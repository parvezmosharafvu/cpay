import { formatCents, parseAmountToCents, toCents } from "./money.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

Deno.test("payer amounts become exact integer cents", () => {
  eq(parseAmountToCents("4.35"), 435, "string 4.35");
  eq(parseAmountToCents(4.35), 435, "number 4.35");
  eq(parseAmountToCents(19.99), 1999, "number 19.99");
  eq(parseAmountToCents("1.005"), 101, "half-up at the third decimal");
  eq(parseAmountToCents("1.004"), 100, "round down below half");
  eq(parseAmountToCents(5000), 500000, "integer");
  for (const bad of [NaN, Infinity, -1, "-1", "1e3", "", " ", "abc", null, undefined, {}, [], "0x10", "1,5"]) {
    eq(parseAmountToCents(bad as unknown), null, `reject ${String(bad)}`);
  }
});

Deno.test("balances floor for spend checks; numeric strings with 8 decimals", () => {
  eq(toCents("10.00500000", "floor"), 1000, "floor");
  eq(toCents("10.00500000"), 1001, "half-up");
  eq(toCents(0.1 + 0.2, "floor"), 30, "float noise floors to 30");
  eq(toCents("1e-7", "floor"), 0, "exponent");
  eq(toCents("-0.001", "floor"), -1, "negative floor");
});

Deno.test("formatCents is exact", () => {
  eq(formatCents(435), "4.35", "4.35");
  eq(formatCents(7), "0.07", "0.07");
  eq(formatCents(-150), "-1.50", "negative");
});
