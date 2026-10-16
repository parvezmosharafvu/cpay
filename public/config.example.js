// Copy to config.js for local development.
// The anon key is public by design; never put service-role or payment provider secrets here.
window.SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
window.SUPABASE_ANON_KEY = 'YOUR_PUBLIC_ANON_KEY';
window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { auth: { experimental: { passkey: true } } });
