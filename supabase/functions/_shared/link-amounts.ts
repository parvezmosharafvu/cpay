// Pure per-link buyer-amount guard for all CPAY receiving rails.
// Existing links have NULL options and retain the existing global bounds.
// New/configured links must stay inside $10-$1000 inclusive.
import {formatCents, toCents} from "./money.ts";
export type LinkBounds={min_usd?:number|string|null; max_usd?:number|string|null};
export function checkLinkAmountCents(amountCents:number, bounds:LinkBounds):string|null {
  if (bounds.min_usd==null && bounds.max_usd==null) return null;
  const lo=toCents(bounds.min_usd), hi=toCents(bounds.max_usd);
  if (lo===null || hi===null || lo<1000 || hi>100000 || hi<lo) return "Payment link amount settings unavailable";
  if (amountCents<lo || amountCents>hi) return "Enter an amount between $"+formatCents(lo)+" and $"+formatCents(hi)+".";
  return null;
}
