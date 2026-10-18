// Payer pages, direct payments (20261018010000): the invoice is made by the
// merchant's own wallet provider and paid straight to it; CPAY never holds
// the money. Shared by the payment page (404.html) and the invoice page.
(function () {
  const url = () => `${window.SUPABASE_URL}/functions/v1/direct-invoice`;
  async function post(body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
    try {
      const res = await fetch(url(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timeout');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  window.cpayDirectPay = {
    create: (body, timeoutMs) => post({ ...body, action: 'create' }, timeoutMs),
    status: (id, timeoutMs) => post({ action: 'status', id }, timeoutMs || 15000),
    // The same fields the invoice page reads from get_invoice_public.
    toRow(d) {
      return {
        status: d.status,
        lightning_invoice: d.payCode,
        amount_requested: d.amountRequested,
        amount_settled: d.status === 'settled' ? d.amountRequested : null,
        expires_at: d.expiresAt,
        merchant_name: d.merchantName,
        link_slug: d.linkSlug,
        destination: d.destination,
        proof: d.proof,
        payment_hash: d.paymentHash,
      };
    },
  };
})();
