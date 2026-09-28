// Telegram message text (HTML parse mode) for the two telegram_outbox
// kinds in migration 0102. Pure functions: the payload in, the text out.
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

export type DailyLink = {
  link_name: string;
  link_slug: string | null;
  owner_name: string | null;
  show_owner: boolean;
  payments: number;
  gross_usd: number | string;
  fee_usd: number | string;
  net_usd: number | string;
};

export type DailyPayload = {
  reseller_name: string;
  day_start: string;
  day_end: string;
  links: DailyLink[];
  totals: { payments: number; gross_usd: number | string; fee_usd: number | string; net_usd: number | string };
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

function share(part: number | string, total: number | string): string {
  const t = Number(total);
  return t > 0 ? `${((Number(part) / t) * 100).toFixed(1)}%` : "0.0%";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function renderDaily(p: DailyPayload): string {
  const head = [
    `<b>Daily close: ${escapeHtml(p.reseller_name)}</b>`,
    `${dhakaTime(p.day_start)} to ${dhakaTime(p.day_end)} (Dhaka)`,
  ].join("\n");
  const t = p.totals;
  const tail = [
    "<b>Totals</b>",
    `Payments: ${Number(t.payments)}`,
    `Gross, with fee: ${usd(t.gross_usd)}`,
    `Fees: ${usd(t.fee_usd)}`,
    `Net, without fee: <b>${usd(t.net_usd)}</b>`,
  ].join("\n");
  if (!p.links.length) return [head, "No settled payments in this business day.", tail].join("\n\n");

  const blocks = p.links.map((l) => [
    linkLabel(l.link_name, l.link_slug) + (l.show_owner && l.owner_name ? `, ${escapeHtml(l.owner_name)}` : ""),
    `${plural(Number(l.payments), "payment")}, ${usd(l.gross_usd)}, ${share(l.gross_usd, t.gross_usd)} of the day`,
    `Fee ${usd(l.fee_usd)}, net ${usd(l.net_usd)}`,
  ].join("\n"));
  // Telegram refuses a message over 4096 characters. Keep whole link
  // blocks while they fit; the totals always cover every link.
  const kept: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const rest = blocks.length - i - 1;
    const more = rest ? [`And ${plural(rest, "more link")}, included in the totals.`] : [];
    const candidate = [head, ...kept, blocks[i], ...more, tail].join("\n\n");
    if (candidate.length > MAX_MESSAGE) {
      kept.push(`And ${plural(blocks.length - i, "more link")}, included in the totals.`);
      return [head, ...kept, tail].join("\n\n");
    }
    kept.push(blocks[i]);
  }
  return [head, ...kept, tail].join("\n\n");
}

export function render(kind: string, payload: unknown): string {
  if (kind === "payment_settled") return renderSettled(payload as SettledPayload);
  if (kind === "daily_close") return renderDaily(payload as DailyPayload);
  throw new Error(`unknown message kind ${kind}`);
}
