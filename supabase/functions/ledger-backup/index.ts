import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { secretMatches } from "../_shared/secret-compare.ts";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const GITHUB_OWNER = Deno.env.get("GITHUB_OWNER")!;
const GITHUB_REPO = Deno.env.get("GITHUB_REPO")!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/**
* Best-effort ops alerts. Payment failures must wake a human up, not sit in
* a log file. Two channels are supported — either one, or both at once:
*   ALERT_WEBHOOK_URL         — Discord or Slack incoming webhook
*   ALERT_TELEGRAM_BOT_TOKEN  — from @BotFather (/newbot)
*   ALERT_TELEGRAM_CHAT_ID    — chat/group id (see docs/ENV_VARS.md)
* Awaited by every caller, with a 10 s timeout per channel, so the alert
* is actually sent before the function returns (an un-awaited fetch can be
* cut off when the response goes out). It never throws: a delivery failure
* only lands in the function log, and only as the error name, because
* Deno's fetch error carries the full URL, and both alert URLs hold a
* secret (the bot token, the webhook token).
*/
async function sendAlert(message: string): Promise<void> {
const text = `🚨 CPAY: ${message}`;
const errName = (e: unknown) => (e instanceof Error ? e.name : "error");
const jobs: Promise<unknown>[] = [];
const webhook = Deno.env.get("ALERT_WEBHOOK_URL");
if (webhook) {
jobs.push(fetch(webhook, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ content: text }),
signal: AbortSignal.timeout(10000),
}).then((r) => { if (!r.ok) console.error(`Discord/Slack alert delivery failed: HTTP ${r.status}`); })
.catch((e) => console.error("Discord/Slack alert delivery failed:", errName(e))));
}
const tgToken = Deno.env.get("ALERT_TELEGRAM_BOT_TOKEN");
const tgChat = Deno.env.get("ALERT_TELEGRAM_CHAT_ID");
if (tgToken && tgChat) {
jobs.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ chat_id: tgChat, text }),
signal: AbortSignal.timeout(10000),
}).then((r) => { if (!r.ok) console.error(`Telegram alert delivery failed: HTTP ${r.status}`); })
.catch((e) => console.error("Telegram alert delivery failed:", errName(e))));
}
if (!webhook && !(tgToken && tgChat)) {
console.warn("sendAlert called but no alert channel is configured.");
}
await Promise.all(jobs);
}


/**
* Fetch an entire table, not just the first page.
*
* PostgREST caps every response at 1000 rows by default. The old code
* called .select("*") with no .range(), so once the ledger passed 1000
* payments the snapshot silently froze: ordered created_at ASC, it kept
* the OLDEST 1000 and dropped every newer payment. The committed backups
* show it happening — 654, 897, 1000, 1000 rows on consecutive days, with
* the newest payment stuck at the same timestamp for 24 hours.
*
* A backup that quietly stops backing up is worse than no backup, because
* nothing looks wrong. So this pages until a short page comes back, and
* the caller verifies the total against a COUNT afterwards.
*/
const PAGE = 1000;

async function fetchAll(
table: string,
columns: string,
orderBy?: { column: string; ascending: boolean },
): Promise<unknown[]> {
const rows: unknown[] = [];
for (let from = 0; ; from += PAGE) {
let q = supabaseAdmin.from(table).select(columns).range(from, from + PAGE - 1);
if (orderBy) q = q.order(orderBy.column, { ascending: orderBy.ascending });
const { data, error } = await q;
if (error) throw new Error(`${table}: ${error.message}`);
rows.push(...(data ?? []));
// A page shorter than the limit means we've reached the end. Paging
// until an EMPTY page would cost one extra round trip every run.
if (!data || data.length < PAGE) break;
}
return rows;
}


/**
* Strip anything that must never sit in a Git repository.
*
* The email column was already excluded for this reason, but more fields
* were going in unredacted, and the committed snapshots prove what that
* costs: a customer's bKash number in plaintext and 988 bolt11 invoice
* strings.
*
* The bolt11 strings matter more than they look. lookup_payment_status()
* accepts a full Lightning address as proof-of-knowledge and returns that
* payment's amount and status — so anyone who cloned the repo could query
* every one of those 988 payments. They are dropped entirely: a restore
* never needs them, because invoice_ref is the key that reconciles
* against the payment provider.
*
* The withdrawal destination is kept only as a last-4 fingerprint. That is
* enough to confirm a payout went where it should during an audit, and not
* enough to identify or reuse the account.
*/
function last4(value: unknown): string | null {
if (typeof value !== "string" || value.length === 0) return null;
const trimmed = value.trim();
return trimmed.length <= 4 ? "****" : `****${trimmed.slice(-4)}`;
}

function redactPayment(row: Record<string, unknown>) {
const { lightning_invoice: _ln, ...rest } = row;
return rest;
}

function redactWithdrawal(row: Record<string, unknown>) {
return { ...row, destination: last4(row.destination) };
}

/** Authoritative row count, used to prove the snapshot is complete. */
async function countRows(table: string): Promise<number> {
const { count, error } = await supabaseAdmin
.from(table)
.select("*", { count: "exact", head: true });
if (error) throw new Error(`count ${table}: ${error.message}`);
return count ?? 0;
}

Deno.serve(async (req) => {
const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
// An unset CRON_SECRET used to make `undefined !== undefined` false, so a
// misconfigured deploy left the whole-ledger export open to the internet.
if (!secretMatches(req.headers.get("x-cron-secret"), cronSecret)) {
return new Response("Unauthorized", { status: 401 });
}
// Pull EVERY record — this is a full ledger snapshot, not just today's.
// Every call is paged; see fetchAll() for why that matters.
let payments: unknown[], withdrawals: unknown[], links: unknown[];
let profiles: unknown[], dailyStats: unknown[];
try {
[payments, withdrawals, links, profiles, dailyStats] = await Promise.all([
fetchAll("payments", "*", { column: "created_at", ascending: true }),
fetchAll("withdrawals", "*", { column: "requested_at", ascending: true }),
fetchAll("payment_links", "*"),
// Email deliberately excluded: this snapshot is committed to a Git
// repository, and once a customer email is in Git history it cannot be
// removed without rewriting every clone. `id` is enough to rejoin the
// rows against the live database during a restore.
fetchAll("profiles", "id, display_name, role, withdrawal_fee_percent, created_at"),
fetchAll("daily_stats", "*", { column: "stat_date", ascending: true }),
]);
} catch (e) {
const detail = e instanceof Error ? e.message : String(e);
console.error("Ledger export failed:", detail);
await sendAlert(`Ledger backup FAILED while reading the database: ${detail}`);
return new Response(JSON.stringify({ error: "Export failed", detail }), { status: 500 });
}

// Verify before committing. Paging is only correct if nothing was missed,
// and the whole point of this change is that a silent shortfall must never
// reach GitHub unnoticed again.
const expected = {
payments: await countRows("payments"),
withdrawals: await countRows("withdrawals"),
payment_links: await countRows("payment_links"),
};
const shortfall: string[] = [];
if (payments.length < expected.payments) shortfall.push(`payments ${payments.length}/${expected.payments}`);
if (withdrawals.length < expected.withdrawals) shortfall.push(`withdrawals ${withdrawals.length}/${expected.withdrawals}`);
if (links.length < expected.payment_links) shortfall.push(`payment_links ${links.length}/${expected.payment_links}`);

// Rows written between the export and the count make the snapshot LARGER
// than expected, which is normal and harmless. Only a shortfall means
// something was dropped, and that must stop the commit.
if (shortfall.length) {
const detail = shortfall.join(", ");
console.error("Ledger snapshot incomplete:", detail);
await sendAlert(`Ledger backup ABORTED — snapshot incomplete (${detail}). Nothing was committed.`);
return new Response(JSON.stringify({ error: "Incomplete snapshot", detail }), { status: 500 });
}

const snapshot = {
generated_at: new Date().toISOString(),
row_counts: {
payments: payments.length,
withdrawals: withdrawals.length,
payment_links: links.length,
profiles: profiles.length,
daily_stats: dailyStats.length,
},
payments: (payments as Record<string, unknown>[]).map(redactPayment),
withdrawals: (withdrawals as Record<string, unknown>[]).map(redactWithdrawal),
payment_links: links,
profiles,
daily_stats: dailyStats,
};
const jsonContent = JSON.stringify(snapshot, null, 2);
const today = new Date().toISOString().slice(0, 10);
const path = `ledger-backups/${today}.json`;
// GitHub Contents API — create or update the file
const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
// Check if a file already exists today (to get its sha for update, else create fresh)
let sha: string | undefined;
const existing = await fetch(apiUrl, {
headers: { "Authorization": `token ${GITHUB_TOKEN}`, "Accept": "application/vnd.github+json" },
});
if (existing.ok) {
const existingData = await existing.json();
sha = existingData.sha;
}
const commitRes = await fetch(apiUrl, {
method: "PUT",
headers: {
"Authorization": `token ${GITHUB_TOKEN}`,
"Accept": "application/vnd.github+json",
"Content-Type": "application/json",
},
body: JSON.stringify({
message: `Ledger backup — ${today}`,
content: btoa(unescape(encodeURIComponent(jsonContent))),
...(sha ? { sha } : {}),
}),
});
if (!commitRes.ok) {
const errText = await commitRes.text();
console.error("GitHub commit failed:", errText);
await sendAlert(`Ledger backup FAILED to commit to GitHub (${today}).`);
return new Response(JSON.stringify({ error: "Backup failed", detail: errText }), { status: 500 });
}
return new Response(JSON.stringify({
status: "backed up",
path,
verified: true,
...snapshot.row_counts,
}), { status: 200, headers: { "Content-Type": "application/json" } });
});
