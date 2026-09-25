import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
* CPAY — health monitor
*
* Answers one question: is the money pipeline actually alive right now?
*
* Everything else in this system reports on things that already
* happened. Nothing notices when something STOPS happening — and the
* failures that matter most here are silent ones:
*
*   * provider unreachable → invoices cannot be created; the payment page
*                            fails for every customer, and no row is
*                            written to notice it by.
*   * webhooks stopped     → payments settle at the provider and never reach
*                            the ledger. Creators are not credited. The
*                            site looks completely normal.
*   * cron stopped         → backups, reconciliation and the daily
*                            archive all quietly stop.
*   * withdrawals stuck    → a creator asked for money days ago and
*                            nobody noticed the request.
*
* Each check has a threshold chosen to be quiet when things are fine.
* An alert that fires on a normal Tuesday is an alert nobody reads.
*
* Read-only. It changes nothing.
*/

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function sendAlert(message: string) {
  const text = `🚨 CPAY health: ${message}`;
  const webhook = Deno.env.get("ALERT_WEBHOOK_URL");
  if (webhook) {
    fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    }).catch((e) => console.error("Alert delivery failed:", e));
  }
  const tgToken = Deno.env.get("ALERT_TELEGRAM_BOT_TOKEN");
  const tgChat = Deno.env.get("ALERT_TELEGRAM_CHAT_ID");
  if (tgToken && tgChat) {
    fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat, text }),
    }).catch((e) => console.error("Telegram alert delivery failed:", e));
  }
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  /** false = worth waking someone; true = informational only */
  informational?: boolean;
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const authorised = cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  if (!authorised) return new Response("Unauthorized", { status: 401 });

  // Alerts are suppressed for manual runs unless explicitly asked for, so
  // checking the dashboard by hand does not spam the alert channel.
  const alertsOn = url.searchParams.get("alert") !== "0";

  const checks: Check[] = [];
  const now = Date.now();

  // ---------- 1. Is the payment provider answering? ----------
  // TODO(breez): ask the Breez SDK Spark payment service whether it is
  // connected and synced. Until it exists invoices cannot be created, so
  // this check fails on purpose.
  checks.push({ name: "payment_provider", ok: false, detail: "no payment provider is configured" });

  // ---------- 2. Are webhooks still arriving? ----------
  // Threshold is generous on purpose. A quiet night is not an outage, so
  // this only complains when a payment was CREATED recently and nothing
  // has settled since — that combination means invoices are being made
  // and their outcomes are not coming back.
  const { data: lastWebhook } = await supabase
    .from("webhook_events")
    .select("received_at")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: recentPayment } = await supabase
    .from("payments")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastHookMs = lastWebhook?.received_at ? new Date(lastWebhook.received_at).getTime() : 0;
  const lastPayMs = recentPayment?.created_at ? new Date(recentPayment.created_at).getTime() : 0;
  const hookAge = lastHookMs ? now - lastHookMs : Infinity;
  const payAge = lastPayMs ? now - lastPayMs : Infinity;

  if (payAge > 6 * HOUR) {
    checks.push({
      name: "webhooks",
      ok: true,
      informational: true,
      detail: lastHookMs
        ? `last webhook ${Math.round(hookAge / MIN)}m ago; no new invoices in 6h, so nothing expected`
        : "no webhooks recorded yet",
    });
  } else {
    const stale = hookAge > 30 * MIN;
    checks.push({
      name: "webhooks",
      ok: !stale,
      detail: lastHookMs
        ? `last webhook ${Math.round(hookAge / MIN)}m ago (invoice activity ${Math.round(payAge / MIN)}m ago)`
        : "invoices are being created but NO webhook has ever been received",
    });
  }

  // ---------- 3. Is cron still running? ----------
  // Checked by output rather than by asking pg_cron: a job that runs and
  // fails every night would still look scheduled.
  const { data: lastStat } = await supabase
    .from("daily_stats")
    .select("computed_at")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const statAge = lastStat?.computed_at ? now - new Date(lastStat.computed_at).getTime() : Infinity;
  checks.push({
    name: "cron",
    ok: statAge < 36 * HOUR,
    detail: lastStat?.computed_at
      ? `daily-report last wrote ${Math.round(statAge / HOUR)}h ago`
      : "daily_stats has never been written",
  });

  // ---------- 4. Withdrawals waiting too long ----------
  const dayAgo = new Date(now - 24 * HOUR).toISOString();
  const { data: stuck } = await supabase
    .from("withdrawals")
    .select("id, amount_requested, requested_at")
    .in("status", ["pending", "approved"])
    .lt("requested_at", dayAgo)
    .order("requested_at", { ascending: true });

  const stuckCount = (stuck ?? []).length;
  checks.push({
    name: "withdrawals",
    ok: stuckCount === 0,
    detail: stuckCount === 0
      ? "nothing waiting over 24h"
      : `${stuckCount} withdrawal(s) pending over 24h, oldest from ${stuck![0].requested_at}`,
  });

  // ---------- 4b. Withdrawals stuck mid-payout ----------
  // A row only sits at "processing" for the length of one payout call —
  // seconds, not hours. The one thing that leaves it there longer is the
  // exact case user-withdraw and the admin payout path now deliberately
  // refuse to guess at: an ambiguous timeout where the provider may
  // already have paid. 15 minutes is generous slack for a slow request;
  // past that, nothing is going to finish it but a human checking the
  // provider directly and confirming paid or voiding it.
  const fifteenMinAgo = new Date(now - 15 * MIN).toISOString();
  const { data: stuckProcessing } = await supabase
    .from("withdrawals")
    .select("id, amount_requested, requested_at")
    .eq("status", "processing")
    .lt("requested_at", fifteenMinAgo)
    .order("requested_at", { ascending: true });

  const stuckProcessingCount = (stuckProcessing ?? []).length;
  checks.push({
    name: "withdrawals_processing",
    ok: stuckProcessingCount === 0,
    detail: stuckProcessingCount === 0
      ? "nothing stuck mid-payout"
      : `${stuckProcessingCount} withdrawal(s) stuck at "processing" over 15m — verify against the payment provider directly, oldest from ${stuckProcessing![0].requested_at}`,
  });

  const failing = checks.filter((c) => !c.ok && !c.informational);
  const healthy = failing.length === 0;

  if (!healthy && alertsOn) {
    sendAlert(failing.map((c) => `${c.name}: ${c.detail}`).join("\n"));
  }

  return new Response(
    JSON.stringify({ healthy, checkedAt: new Date().toISOString(), checks }, null, 2),
    {
      // 503 when unhealthy so an uptime monitor pointed at this URL can
      // page on the status code alone, without parsing the body.
      status: healthy ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    },
  );
});
