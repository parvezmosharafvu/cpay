// Overwrite walletCall after admin-wallet.js loads.
// invoke('admin-actions/admin-wallet') is not a valid function slug.
async function walletCall(action, body = {}) {
  const res = await callFunction('admin-actions', { action, ...body });
  if (!res.ok) throw new Error(res.message || 'The wallet did not answer');
  return res.data;
}
