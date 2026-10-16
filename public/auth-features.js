// What Supabase Auth has switched on for this project, read from its public
// /settings endpoint: Google sign-in and passkeys. Pages show those buttons
// only when the owner has enabled them in the Supabase dashboard, so turning
// one on or off needs no code change. One request per page load.
(function () {
  let cached = null;
  window.cpayAuthFeatures = function () {
    if (cached) return cached;
    cached = (async () => {
      try {
        const r = await fetch(`${window.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: window.SUPABASE_ANON_KEY } });
        if (!r.ok) return { google: false, passkeys: false };
        const s = await r.json();
        return { google: s?.external?.google === true, passkeys: s?.passkeys_enabled === true };
      } catch (e) {
        return { google: false, passkeys: false };
      }
    })();
    return cached;
  };
})();
