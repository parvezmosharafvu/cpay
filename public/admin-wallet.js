// Admin Wallet tab: the platform's own Breez Spark wallet. Every call goes
// through admin-actions, which checks the caller is an admin
// and forwards to the payment service. Sends only spend what the wallet
// holds beyond what is owed to creators; the service enforces that.
const WALLET_FN = 'admin-actions';
const walletState = { info: null, fiat: [], currency: 'USD', page: 0, pageSize: 10, prepared: null, quote: null, routes: [] };

const $w = (id) => document.getElementById(id);
const sats = (n) => (n == null ? '-' : `${Number(n).toLocaleString('en-US')} sats`);

async function walletCall(action, body = {}) {
  const res = await callFunction(WALLET_FN, { action, ...body });
  if (!res.ok) throw new Error(res.message || 'The wallet did not answer');
  return res.data;
}
