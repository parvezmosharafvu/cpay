// TEST BUILDS ONLY. build.mjs copies this file only when WALLET_TEST=1 and
// refuses engine: 'fake' otherwise, so a production wallet can never show
// these made-up balances.
//
// In memory, no network. window.__fakeWallet lets Playwright credit sats
// and read what was "connected" (a fingerprint of the phrase, never the
// phrase itself).
export function createFakeEngine() {
  const state = { balance: 0, payments: [], connected: null, onEvent: null };
  const fingerprint = async (m) => {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m)));
    return Array.from(d.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  globalThis.__fakeWallet = {
    credit(sats) {
      state.balance += sats;
      state.payments.unshift({ id: `in-${state.payments.length}`, type: 'receive', status: 'completed', amountSats: sats, feesSats: 0, timestamp: Math.floor(Date.now() / 1000) });
      state.onEvent?.('paymentSucceeded');
    },
    get fingerprint() { return state.connected; },
  };
  return {
    kind: 'fake',
    async connect(mnemonic, onEvent) { state.connected = await fingerprint(mnemonic); state.onEvent = onEvent; },
    async info() { return { balanceSats: state.balance }; },
    async receive({ amountSats }) { return { request: `lnbcrt${amountSats || 0}n1fake${Date.now().toString(36)}`, feeSats: 0 }; },
    async sparkAddress() { return 'sprt1fakeaddress'; },
    async bitcoinAddress() {
      if ((globalThis.CPAY_WALLET_CONFIG || {}).network !== 'regtest') throw new Error('Test-bitcoin deposits are only available on the test network.');
      return 'bcrt1qfakedepositaddress0000000000000000';
    },
    async unclaimedDeposits() { return []; },
    async prepareSend(input, amountSats) {
      const text = String(input || '').trim();
      if (!/^lnbc/i.test(text)) throw new Error('Paste a Lightning invoice or a Spark address.');
      const m = text.match(/^lnbcrt(\d+)n/);
      const sats = m && Number(m[1]) > 0 ? Number(m[1]) : Number(amountSats);
      if (!Number.isInteger(sats) || sats <= 0) throw new Error('Enter an amount in sats.');
      return { amountSats: sats, feeSats: 1, kind: 'bolt11Invoice', handle: { text } };
    },
    async send(prepared) {
      const total = prepared.amountSats + prepared.feeSats;
      if (total > state.balance) throw new Error('Not enough sats in this wallet.');
      state.balance -= total;
      const p = { id: `out-${state.payments.length}`, type: 'send', status: 'completed', amountSats: prepared.amountSats, feesSats: prepared.feeSats, timestamp: Math.floor(Date.now() / 1000) };
      state.payments.unshift(p);
      return { id: p.id, status: p.status };
    },
    async payments() { return state.payments.slice(); },
    async exportExitState() { return JSON.stringify({ fake: true, balanceSats: state.balance }); },
    async disconnect() { state.connected = null; },
  };
}
