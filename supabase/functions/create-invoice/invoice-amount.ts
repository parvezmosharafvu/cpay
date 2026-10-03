export function invoiceChargeCents(amountCents: number, costPercent: number): number {
  const costThousandthsPercent = Math.round(costPercent * 1000);
  return Math.floor((amountCents * (100_000 + costThousandthsPercent) + 50_000) / 100_000);
}
