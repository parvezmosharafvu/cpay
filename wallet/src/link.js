// Optional link to a CPAY website account.
//
// What linking is: signing in to the CPAY account inside this app (email
// and password, the same sign-in the website uses) so the app can show the
// account's website balance next to the wallet's own balance, clearly
// labelled as two different things. What it is not: nothing about the
// wallet's keys, recovery phrase or passphrase is involved, sent or
// derived from the CPAY password, and no money moves between the two.
//
// Revocation: "Unlink" signs this app out (its session is deleted from this
// device). "Unlink and sign out everywhere" also revokes every other CPAY
// session's refresh token server-side (Supabase global sign-out).
//
// Reads use the existing get_my_balance() RPC, which only returns the
// signed-in user's own row (it is SECURITY DEFINER over auth.uid()).
const cfg = () => globalThis.CPAY_WALLET_CONFIG || {};

let client = null;

export function linkAvailable() {
  const c = cfg();
  return Boolean(c.cpaySupabaseUrl && c.cpaySupabaseAnonKey && globalThis.supabase?.createClient);
}

function sb() {
  if (!client) {
    const c = cfg();
    client = globalThis.supabase.createClient(c.cpaySupabaseUrl, c.cpaySupabaseAnonKey, {
      auth: { storageKey: 'cpay-wallet.cpay-link', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

export async function linkedAccount() {
  if (!linkAvailable()) return null;
  const { data } = await sb().auth.getSession();
  const s = data?.session;
  return s ? { email: s.user?.email || '' } : null;
}

export async function link(email, password) {
  const { error } = await sb().auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
  if (error) throw new Error('Could not sign in to CPAY. Check the email and password.');
}

// The CPAY website ledger's numbers for this account, in USD as the site
// shows them. Held by CPAY; not in this wallet.
export async function websiteBalance() {
  const { data, error } = await sb().rpc('get_my_balance');
  if (error) throw new Error('Could not read the CPAY account balance.');
  const row = Array.isArray(data) ? data[0] : data;
  return { available: Number(row?.available ?? 0), earned: Number(row?.earned ?? 0) };
}

// Where this CPAY account's direct payments go (direct settlement), read
// only: get_my_direct_settlement() returns the signed-in user's own
// addresses. Changing it happens on the website, with a fresh sign-in.
export async function directSettlement() {
  const { data, error } = await sb().rpc('get_my_direct_settlement');
  if (error || !data) return null;
  return {
    enabled: data.enabled === true,
    current: data.current?.address || null,
    pending: data.pending ? { address: data.pending.address, readyAt: data.pending.ready_at } : null,
  };
}

export async function unlink({ everywhere = false } = {}) {
  if (!client) return;
  try {
    await sb().auth.signOut({ scope: everywhere ? 'global' : 'local' });
  } finally {
    // Whatever the server answered, nothing of the link stays on this device.
    try { localStorage.removeItem('cpay-wallet.cpay-link'); } catch { /* ignore */ }
  }
}
