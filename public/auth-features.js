// What Supabase Auth has switched on for this project, read from its public
// /settings endpoint: passkeys. Pages show the passkey button only when the
// owner has enabled passkeys in the Supabase dashboard. Google sign-in was
// removed on 2026-10-21 and is always reported off. One request per page load.
(function () {
  let cached = null;
  window.cpayAuthFeatures = function () {
    if (cached) return cached;
    cached = (async () => {
      try {
        const r = await fetch(`${window.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: window.SUPABASE_ANON_KEY } });
        if (!r.ok) return { passkeys: false };
        const s = await r.json();
        return { passkeys: s?.passkeys_enabled === true };
      } catch (e) {
        return { passkeys: false };
      }
    })();
    return cached;
  };
})();
