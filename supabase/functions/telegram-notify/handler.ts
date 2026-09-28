// telegram-notify: sends what migration 0106 queued in telegram_outbox.
// Called by pg_cron (cpay-telegram-send, every minute when a row is due)
// with the x-cron-secret header.
//
// Each row is claimed once (telegram_claim marks it 'sending') and then
// finished with exactly one outcome:
//   sent     Telegram answered ok
//   retry    Telegram did not take it (429 or 5xx); the row is due again
//            after retry_after, up to 5 attempts
//   failed   Telegram refused it (4xx, e.g. the bot is not in the group),
//            or there was no answer at all (a timeout or dropped
//            connection may still have delivered it, so it is not resent)
//   skipped  nothing to send to (no admin group set, or ALERT_ON_SETTLED=false)
// The bot token is never logged, stored or returned.
//
// Kept apart from index.ts so tests can run it against a mock Telegram
// server and a fake outbox.

import { render } from "./render.ts";

export type OutboxRow = { id: number; kind: string; chat: string; payload: unknown; attempts: number };

export interface Outbox {
  claim(limit: number): Promise<OutboxRow[]>;
  finish(id: number, outcome: "sent" | "retry" | "failed" | "skipped", detail?: { messageId?: number; error?: string; retryAfterSecs?: number }): Promise<void>;
}

export interface NotifyConfig {
  cronSecret: string;
  botToken: string;
  /** ALERT_TELEGRAM_CHAT_ID: the admin group, for rows whose chat is 'admin'. */
  adminChatId: string;
  /** ALERT_ON_SETTLED, default true: payment messages to the admin group. */
  settledToAdmin: boolean;
  /** https://api.telegram.org in production; a local mock in tests. */
  telegramApi: string;
  outbox: Outbox;
  fetch?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
  batchSize?: number;
  maxBatches?: number;
  timeoutMs?: number;
}

type Outcome = { outcome: "sent" | "retry" | "failed" | "skipped"; messageId?: number; error?: string; retryAfterSecs?: number };

function sameSecret(given: string | null, expected: string): boolean {
  if (!expected || given === null) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function createHandler(cfg: NotifyConfig): (req: Request) => Promise<Response> {
  const doFetch = cfg.fetch ?? fetch;
  const log = cfg.log ?? ((e) => console.log(JSON.stringify(e)));
  const clean = (s: string) => (cfg.botToken ? s.split(cfg.botToken).join("[token]") : s).slice(0, 500);

  async function send(chat: string, text: string): Promise<Outcome> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.telegramApi}/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
      });
    } catch (e) {
      return { outcome: "failed", error: clean(`No answer from Telegram, not resent: ${e instanceof Error ? e.message : e}`) };
    }
    const body = await res.json().catch(() => ({})) as {
      ok?: boolean; description?: string; result?: { message_id?: number }; parameters?: { retry_after?: number };
    };
    if (res.ok && body.ok) return { outcome: "sent", messageId: body.result?.message_id };
    const error = clean(`Telegram ${res.status}: ${body.description ?? "no description"}`);
    if (res.status === 429 || res.status >= 500) {
      return { outcome: "retry", error, retryAfterSecs: body.parameters?.retry_after };
    }
    return { outcome: "failed", error };
  }

  async function deliver(row: OutboxRow): Promise<Outcome> {
    const toAdmin = row.chat === "admin";
    if (toAdmin && !cfg.adminChatId) return { outcome: "skipped", error: "ALERT_TELEGRAM_CHAT_ID is not set" };
    if (toAdmin && row.kind === "payment_settled" && !cfg.settledToAdmin) return { outcome: "skipped", error: "ALERT_ON_SETTLED is false" };
    let text: string;
    try {
      text = render(row.kind, row.payload);
    } catch (e) {
      return { outcome: "failed", error: clean(`Could not build the message: ${e instanceof Error ? e.message : e}`) };
    }
    return send(toAdmin ? cfg.adminChatId : row.chat, text);
  }

  return async (req: Request) => {
    if (!sameSecret(req.headers.get("x-cron-secret"), cfg.cronSecret)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Without a bot nothing is claimed: rows wait until the secret is set.
    if (!cfg.botToken) {
      log({ event: "telegram-notify", error: "ALERT_TELEGRAM_BOT_TOKEN is not set" });
      return Response.json({ ok: false, error: "ALERT_TELEGRAM_BOT_TOKEN is not set" }, { status: 503 });
    }
    const counts: Record<string, number> = { sent: 0, retry: 0, failed: 0, skipped: 0 };
    for (let batch = 0; batch < (cfg.maxBatches ?? 5); batch++) {
      const rows = await cfg.outbox.claim(cfg.batchSize ?? 20);
      if (!rows.length) break;
      for (const row of rows) {
        const r = await deliver(row);
        counts[r.outcome]++;
        await cfg.outbox.finish(row.id, r.outcome, { messageId: r.messageId, error: r.error, retryAfterSecs: r.retryAfterSecs });
        if (r.outcome !== "sent") log({ event: "telegram-notify", id: row.id, kind: row.kind, outcome: r.outcome, error: r.error });
      }
    }
    return Response.json({ ok: true, ...counts });
  };
}

// The outbox through supabase-js with the service role.
// deno-lint-ignore no-explicit-any
export function outboxFromSupabase(supabase: any): Outbox {
  return {
    async claim(limit) {
      const { data, error } = await supabase.rpc("telegram_claim", { p_limit: limit });
      if (error) throw new Error(`telegram_claim: ${error.message}`);
      return data ?? [];
    },
    async finish(id, outcome, detail = {}) {
      const { error } = await supabase.rpc("telegram_finish", {
        p_id: id,
        p_outcome: outcome,
        p_message_id: detail.messageId ?? null,
        p_error: detail.error ?? null,
        p_retry_after_secs: detail.retryAfterSecs ?? null,
      });
      if (error) throw new Error(`telegram_finish: ${error.message}`);
    },
  };
}
