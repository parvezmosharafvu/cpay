// CPAY public browser configuration. The anon key is intentionally public.
// Never place a service-role key or payment provider secret in this file.
window.SUPABASE_URL = 'https://riumaeihemgznvgattoc.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpdW1hZWloZW1nem52Z2F0dG9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NDU1MDAsImV4cCI6MjEwNTQyMTUwMH0.WEC84G_IwHG4jfAJ5fWVdSjFxS8xM-D9tklGn4jsyHk';
// Cloudflare Turnstile SITE key (public, starts with 0x). Required while
// Supabase Auth CAPTCHA protection is on, or sign-in, sign-up and reset
// email are refused. Never put the Turnstile SECRET key here: it belongs
// only in Supabase (Authentication -> Attack Protection). See turnstile.js.
window.CPAY_TURNSTILE_SITE_KEY = window.CPAY_TURNSTILE_SITE_KEY || '';
window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
