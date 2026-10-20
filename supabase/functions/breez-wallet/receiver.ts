// Receive-only app for a NON-primary wallet (multi-wallet, 20261021030000).
// It never creates invoices, never sends, never reconciles withdrawals and
// never runs forwards: only the primary wallet does that. It settles
// payments that arrive for invoices this wallet made while it was primary
// (settle_breez_payment matches by payment hash and is idempotent), so
// switching the primary never strands a payer.
import * as ledger from "./core/ledger.mjs";

// deno-lint-ignore no-explicit-any
type Any = any;

export function createReceiverApp({ sdk, db, log }: { sdk: Any; db: Any; log: (e: Record<string, unknown>) => void }) {
  const inflight = new Set<Promise<unknown>>();
  let draining = false;
  const track = <T>(p: Promise<T>) => { inflight.add(p); p.finally(() => inflight.delete(p)).catch(() => {}); return p; };

  async function catchUpOnce() {
    const since = await ledger.catchUpSince(db);
    const outcomes: Record<string, number> = {};
    if (since !== null) {
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const { payments } = await sdk.listPayments({
          typeFilter: ["receive"], statusFilter: ["completed"], fromTimestamp: since, offset, limit, sortAscending: true,
        });
        for (const p of payments) {
          const outcome = await ledger.settlePayment(db, p);
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        }
        if (payments.length < limit) break;
      }
    }
    log({ event: "receiver-catch-up", since, outcomes });
    return outcomes;
  }

  return {
    catchUp: () => (draining ? Promise.resolve({}) : track(catchUpOnce())),
    async drain(timeoutMs: number) {
      draining = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        Promise.allSettled([...inflight]).then(() => true),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(false), timeoutMs); }),
      ]);
      clearTimeout(timer);
      return { drained };
    },
    onEvent(_e: unknown) { /* receive-only: the cron catch-up settles */ },
    markSynced() {},
    markReady() {},
    async handle(_req: unknown, res: Any) {
      res.statusCode = 503;
      res.setHeader?.("content-type", "application/json");
      res.end(JSON.stringify({ error: "not the primary wallet" }));
    },
  };
}
