/**
* CPAY — daily reconciliation
*
* Compares what the payment provider says it settled against what the
* CPAY ledger records, for one 5pm–5pm Dhaka cycle. It is the one job that
* looks outside CPAY: a settled payment whose event never arrived is
* invisible to every internal check.
*
* Read-only. It must never write to payments or withdrawals — it reports,
* and a human decides.
*
* TODO(breez): list the Breez SDK Spark payments received in the cycle
* (listPayments on the treasury wallet), match them to payments.invoice_ref
* by payment hash, compare with daily_totals_for_cycle(), and alert on any
* difference. The previous comparison was removed with the previous
* provider. pg_cron (cpay-reconcile, 0045) still calls this daily, so it
* answers 200 and says it skipped.
*/

Deno.serve((req) => {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }
  return new Response(
    JSON.stringify({ skipped: true, reason: "No payment provider to reconcile against yet" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
