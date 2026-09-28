// deno test --allow-net=127.0.0.1 supabase/functions/telegram-notify/
//
// The real handler against a local mock of the Telegram Bot API and an
// in-memory outbox with telegram_claim/telegram_finish's rules. No real
// Telegram, no real token.
import { createHandler, type OutboxRow } from "./handler.ts";
import { dhakaTime, escapeHtml, MAX_MESSAGE, renderDaily, renderSettled, sats, usd } from "./render.ts";

const TOKEN = "123456:fake-token-for-tests";
const SECRET = "cron-secret-for-tests";

function eq<T>(got: T, expected: T, msg: string) {
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

// ---------- mock Telegram ----------
type Sent = { chat_id: string; text: string; parse_mode: string; token: string };
const sent: Sent[] = [];
const reply: Record<string, () => Response> = {
  "-100429": () => Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }, { status: 429 }),
  "-100403": () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" }, { status: 403 }),
  "-100500": () => Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 }),
};
const tg = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
  const m = new URL(req.url).pathname.match(/^\/bot(.+)\/sendMessage$/);
  if (!m) return new Response("not found", { status: 404 });
  const body = await req.json();
  if (reply[body.chat_id]) return reply[body.chat_id]();
  sent.push({ ...body, token: m[1] });
  return Response.json({ ok: true, result: { message_id: 1000 + sent.length } });
});
const API = `http://127.0.0.1:${tg.addr.port}`;

// ---------- in-memory outbox ----------
type Row = OutboxRow & { status: string; error?: string; messageId?: number; retryAfterSecs?: number };
function outbox(rows: Row[]) {
  return {
    rows,
    async claim(limit: number) {
      const due = rows.filter((r) => r.status === "pending").slice(0, limit);
      for (const r of due) { r.status = "sending"; r.attempts++; }
      return due.map((r) => ({ ...r }));
    },
    async finish(id: number, outcome: string, d: { messageId?: number; error?: string; retryAfterSecs?: number } = {}) {
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "sending") throw new Error(`finish on ${r.status}`);
      r.status = outcome === "retry" ? "retry-later" : outcome;
      Object.assign(r, d);
    },
  };
}

const settled = {
  link_name: "Logo <design>", link_slug: "tg-logo", owner_name: "Karim & Sons", show_owner: true,
  amount_usd: 1234.5, amount_sat: 1234500, fee_usd: 37.04, net_usd: 1197.46, settled_at: "2026-09-27T10:59:00+00:00",
};
const daily = {
  reseller_name: "Rahim <Team> & Co", business_day: "2026-09-26",
  day_start: "2026-09-26T11:00:00+00:00", day_end: "2026-09-27T11:00:00+00:00",
  links: [
    { link_name: "Logo <design>", link_slug: "tg-logo", owner_name: "Karim", show_owner: true, payments: 2, gross_usd: 133.33, fee_usd: 4, net_usd: 129.33 },
    { link_name: "Reseller own", link_slug: "tg-own", owner_name: "Rahim", show_owner: false, payments: 1, gross_usd: 40, fee_usd: 1.2, net_usd: 38.8 },
    { link_name: "tg-promo", link_slug: "tg-promo", owner_name: "Karim", show_owner: true, payments: 1, gross_usd: 20, fee_usd: 0.6, net_usd: 19.4 },
  ],
  totals: { payments: 4, gross_usd: 193.33, fee_usd: 5.8, net_usd: 187.53 },
};

Deno.test("formatting helpers", () => {
  eq(escapeHtml(`<b>"Tom" & Jerry</b>`), `&lt;b&gt;"Tom" &amp; Jerry&lt;/b&gt;`, "escape");
  eq(usd(1234567.5), "$1,234,567.50", "usd");
  eq(usd("0"), "$0.00", "usd zero");
  eq(sats(1234500), "1,234,500 sats", "sats");
  eq(dhakaTime("2026-09-27T10:59:00Z"), "27 Sep 2026, 4:59 PM", "16:59 Dhaka");
  eq(dhakaTime("2026-09-27T18:05:00Z"), "28 Sep 2026, 12:05 AM", "after midnight Dhaka");
});

Deno.test("settled payment message, exact text", () => {
  eq(renderSettled(settled), [
    "<b>Payment received</b>",
    "Link: <b>Logo &lt;design&gt;</b> (/tg-logo)",
    "Freelancer: Karim &amp; Sons",
    "Amount: <b>$1,234.50</b> (1,234,500 sats)",
    "Fee: $37.04",
    "Net: <b>$1,197.46</b>",
    "Time: 27 Sep 2026, 4:59 PM (Dhaka)",
  ].join("\n"), "settled");
  const own = renderSettled({ ...settled, show_owner: false, amount_sat: null });
  eq(own.includes("Freelancer"), false, "no freelancer line on the reseller's own link");
  eq(own.includes("Amount: <b>$1,234.50</b>\n"), true, "no sats for a manual settle");
});

Deno.test("daily close message, exact text", () => {
  eq(renderDaily(daily), [
    "<b>Daily close: Rahim &lt;Team&gt; &amp; Co</b>\n26 Sep 2026, 5:00 PM to 27 Sep 2026, 5:00 PM (Dhaka)",
    "<b>Logo &lt;design&gt;</b> (/tg-logo), Karim\n2 payments, $133.33, 69.0% of the day\nFee $4.00, net $129.33",
    "<b>Reseller own</b> (/tg-own)\n1 payment, $40.00, 20.7% of the day\nFee $1.20, net $38.80",
    "<b>tg-promo</b>, Karim\n1 payment, $20.00, 10.3% of the day\nFee $0.60, net $19.40",
    "<b>Totals</b>\nPayments: 4\nGross, with fee: $193.33\nFees: $5.80\nNet, without fee: <b>$187.53</b>",
  ].join("\n\n"), "daily");
  const empty = renderDaily({ ...daily, links: [], totals: { payments: 0, gross_usd: 0, fee_usd: 0, net_usd: 0 } });
  eq(empty.includes("No settled payments in this business day."), true, "empty day");
});

Deno.test("a day with hundreds of links stays under Telegram's limit and keeps the totals", () => {
  const links = Array.from({ length: 400 }, (_, i) => ({ ...daily.links[0], link_name: `Link number ${i}`, link_slug: `link-${i}` }));
  const text = renderDaily({ ...daily, links });
  eq(text.length <= MAX_MESSAGE, true, `length ${text.length}`);
  eq(/And \d+ more links, included in the totals\./.test(text), true, "says how many were left out");
  eq(text.endsWith("Net, without fee: <b>$187.53</b>"), true, "totals kept");
});

Deno.test("each row gets one outcome: sent, retry on 429/5xx, failed on 4xx or no answer, skipped without a target", async () => {
  sent.length = 0;
  const box = outbox([
    { id: 1, kind: "payment_settled", chat: "-1001111111111", payload: settled, attempts: 0, status: "pending" },
    { id: 2, kind: "daily_close", chat: "-1001111111111", payload: daily, attempts: 0, status: "pending" },
    { id: 3, kind: "payment_settled", chat: "admin", payload: settled, attempts: 0, status: "pending" },
    { id: 4, kind: "payment_settled", chat: "-100429", payload: settled, attempts: 0, status: "pending" },
    { id: 5, kind: "payment_settled", chat: "-100403", payload: settled, attempts: 0, status: "pending" },
    { id: 6, kind: "payment_settled", chat: "-100500", payload: settled, attempts: 0, status: "pending" },
    { id: 7, kind: "mystery", chat: "-1001111111111", payload: {}, attempts: 0, status: "pending" },
  ]);
  const logs: string[] = [];
  const handler = createHandler({
    cronSecret: SECRET, botToken: TOKEN, adminChatId: "-1009999999999", settledToAdmin: true,
    telegramApi: API, outbox: box, log: (e) => logs.push(JSON.stringify(e)),
  });
  const res = await handler(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": SECRET } }));
  const body = await res.json();
  eq(body, { ok: true, sent: 3, retry: 2, failed: 2, skipped: 0 }, "counts");
  eq(box.rows.map((r) => r.status), ["sent", "sent", "sent", "retry-later", "failed", "retry-later", "failed"], "statuses");
  eq(box.rows[3].retryAfterSecs, 7, "retry_after passed on");
  eq(sent.map((s) => s.chat_id), ["-1001111111111", "-1001111111111", "-1009999999999"], "chats");
  eq(sent.every((s) => s.parse_mode === "HTML" && s.token === TOKEN), true, "HTML mode, bot token in the path only");
  eq(box.rows[0].messageId, 1001, "message id stored");
  eq(JSON.stringify(box.rows).includes(TOKEN) || logs.join("").includes(TOKEN) || JSON.stringify(body).includes(TOKEN), false, "token nowhere");

  // A second run finds nothing due and sends nothing.
  const again = await (await handler(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": SECRET } }))).json();
  eq(again, { ok: true, sent: 0, retry: 0, failed: 0, skipped: 0 }, "second run");
  eq(sent.length, 3, "nothing sent twice");
});

Deno.test("admin rows are skipped without an admin group or with ALERT_ON_SETTLED=false; the daily close to a reseller is not", async () => {
  sent.length = 0;
  for (const [adminChatId, settledToAdmin, reason] of [["", true, "ALERT_TELEGRAM_CHAT_ID is not set"], ["-1009999999999", false, "ALERT_ON_SETTLED is false"]] as const) {
    const box = outbox([
      { id: 1, kind: "payment_settled", chat: "admin", payload: settled, attempts: 0, status: "pending" },
      { id: 2, kind: "daily_close", chat: "-1001111111111", payload: daily, attempts: 0, status: "pending" },
    ]);
    const handler = createHandler({ cronSecret: SECRET, botToken: TOKEN, adminChatId, settledToAdmin, telegramApi: API, outbox: box, log: () => {} });
    await handler(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": SECRET } }));
    eq(box.rows.map((r) => [r.status, r.error ?? null]), [["skipped", reason], ["sent", null]], reason);
  }
});

Deno.test("no answer from Telegram is failed and never resent, without the token in the error", async () => {
  const box = outbox([{ id: 1, kind: "payment_settled", chat: "-1001111111111", payload: settled, attempts: 0, status: "pending" }]);
  const handler = createHandler({
    cronSecret: SECRET, botToken: TOKEN, adminChatId: "", settledToAdmin: true, telegramApi: "http://127.0.0.1:1", outbox: box, log: () => {},
    fetch: () => Promise.reject(new Error(`connection reset for http://127.0.0.1:1/bot${TOKEN}/sendMessage`)),
  });
  await handler(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": SECRET } }));
  eq(box.rows[0].status, "failed", "failed");
  eq(box.rows[0].error, "No answer from Telegram, not resent: connection reset for http://127.0.0.1:1/bot[token]/sendMessage", "error text");
});

Deno.test("the cron secret is required and compared exactly; no bot token claims nothing", async () => {
  const box = outbox([{ id: 1, kind: "payment_settled", chat: "-1001111111111", payload: settled, attempts: 0, status: "pending" }]);
  const handler = createHandler({ cronSecret: SECRET, botToken: TOKEN, adminChatId: "", settledToAdmin: true, telegramApi: API, outbox: box, log: () => {} });
  for (const h of [{} as Record<string, string>, { "x-cron-secret": "" }, { "x-cron-secret": SECRET + "x" }, { "x-cron-secret": SECRET.slice(1) }]) {
    eq((await handler(new Request("http://x/", { method: "POST", headers: h }))).status, 401, JSON.stringify(h));
  }
  const unset = createHandler({ cronSecret: "", botToken: TOKEN, adminChatId: "", settledToAdmin: true, telegramApi: API, outbox: box, log: () => {} });
  eq((await unset(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": "" } }))).status, 401, "unset secret refuses all");
  const noBot = createHandler({ cronSecret: SECRET, botToken: "", adminChatId: "", settledToAdmin: true, telegramApi: API, outbox: box, log: () => {} });
  eq((await noBot(new Request("http://x/", { method: "POST", headers: { "x-cron-secret": SECRET } }))).status, 503, "no bot");
  eq(box.rows[0].status, "pending", "nothing claimed without a bot");
});

addEventListener("unload", () => tg.shutdown());
