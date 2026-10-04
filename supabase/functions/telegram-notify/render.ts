// Telegram message text (HTML parse mode) for the telegram_outbox
// payment_settled kind (migration 0106; the reseller daily close was
// removed in 20261005020000). Pure functions: the payload in, the text out.
// Every name that comes from a user goes through escapeHtml.

export const MAX_MESSAGE = 4096;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000; // UTC+6, no daylight saving
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type SettledPayload = {
  link_name: string | null;
  link_slug: string | null;
  owner_name: string | null;
  show_owner: boolean;
  amount_usd: number | string;
  amount_sat: number | string | null;
  fee_usd: number | string;
  net_usd: number | string;
  settled_at: string;
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function usd(value: number | string): string {
  const [whole, cents] = Number(value).toFixed(2).split(".");
  return `$${groupThousands(whole)}.${cents}`;
}

export function sats(value: number | string): string {
  return `${groupThousands(String(Math.round(Number(value))))} sats`;
}

/** "26 Sep 2026, 4:59 PM" in Dhaka time. */
export function dhakaTime(iso: string): string {
  const d = new Date(Date.parse(iso) + DHAKA_OFFSET_MS);
  const h = d.getUTCHours();
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${minutes} ${h < 12 ? "AM" : "PM"}`;
}

function linkLabel(name: string | null, slug: string | null): string {
  const title = `<b>${escapeHtml(name || slug || "Payment")}</b>`;
  return slug && slug !== name ? `${title} (/${escapeHtml(slug)})` : title;
}

export function renderSettled(p: SettledPayload): string {
  const amount = p.amount_sat != null ? `<b>${usd(p.amount_usd)}</b> (${sats(p.amount_sat)})` : `<b>${usd(p.amount_usd)}</b>`;
  return [
    "<b>Payment received</b>",
    `Link: ${linkLabel(p.link_name, p.link_slug)}`,
    ...(p.show_owner && p.owner_name ? [`Freelancer: ${escapeHtml(p.owner_name)}`] : []),
    `Amount: ${amount}`,
    `Fee: ${usd(p.fee_usd)}`,
    `Net: <b>${usd(p.net_usd)}</b>`,
    `Time: ${dhakaTime(p.settled_at)} (Dhaka)`,
  ].join("\n");
}

export function render(kind: string, payload: unknown): string {
  if (kind === "payment_settled") return renderSettled(payload as SettledPayload);
  throw new Error(`unknown message kind ${kind}`);
}
