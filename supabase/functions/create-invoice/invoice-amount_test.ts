import { invoiceChargeCents } from "./invoice-amount.ts";

Deno.test("invoice markup rounds a half-cent up using integer cents", () => {
  if (invoiceChargeCents(100, 0.5) !== 101) throw new Error("half-cent markup did not round up");
});

Deno.test("invoice markup preserves exact-cent totals", () => {
  if (invoiceChargeCents(100, 0) !== 100 || invoiceChargeCents(100, 1) !== 101) {
    throw new Error("invoice markup rounded an exact-cent total incorrectly");
  }
});
