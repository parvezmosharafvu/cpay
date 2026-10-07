// Exact dollar <-> integer-cent helpers for edge functions. No float math:
// digits are parsed as BigInt, so "4.35" is 435 cents (4.35 * 100 is
// 434.99999999999994 in floating point). Mirrors payment-service/money.mjs.

function fraction(value: unknown): { num: bigint; den: bigint } | null {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value ?? "").trim());
  if (!m) return null;
  const exp = Number(m[4] ?? 0);
  if (!Number.isInteger(exp) || Math.abs(exp) > 40) return null;
  const frac = m[3] ?? "";
  let num = BigInt(`${m[2]}${frac}`);
  let scale = frac.length - exp;
  if (scale < 0) { num *= 10n ** BigInt(-scale); scale = 0; }
  if (m[1] === "-") num = -num;
  return { num, den: 10n ** BigInt(scale) };
}

function toSafe(v: bigint): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** Decimal (string or JSON number) to cents. half-up = Postgres round(x,2) for x >= 0. */
export function toCents(value: unknown, mode: "half-up" | "floor" = "half-up"): number | null {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const f = fraction(value);
  if (!f) return null;
  const n = f.num * 100n;
  let q = n / f.den;
  const r = n % f.den;
  if (mode === "floor") { if (r < 0n) q -= 1n; }
  else if (r !== 0n) { const twice = (r < 0n ? -r : r) * 2n; if (twice >= f.den) q += n < 0n ? -1n : 1n; }
  return toSafe(q);
}

/**
 * A payer- or user-entered dollar amount: digits with an optional
 * fractional part. Rounded half-up to cents. JSON numbers are accepted as
 * their shortest decimal form (String(19.99) === "19.99").
 */
export function parseAmountToCents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const s = String(value).trim();
  if (!/^\d{1,9}(\.\d{1,8})?$/.test(s)) return null;
  return toCents(s, "half-up");
}

/** 1234 -> "12.34" (exact, for numeric columns and messages). */
export function formatCents(cents: number): string {
  const v = BigInt(cents);
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}
