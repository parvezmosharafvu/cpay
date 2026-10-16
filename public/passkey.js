// Passkeys (Supabase Auth, WebAuthn): sign in, and confirm payouts, with the
// device's fingerprint, face or screen lock instead of the password.
//
// Shown only when the browser supports WebAuthn and the owner has switched
// passkeys on in Supabase (Authentication → Passkeys; auth-features.js).
// A passkey replaces the password, not the authenticator code: a passkey
// sign-in is aal1, so an account with two-step sign-in still enters its code
// afterwards (mfa.js). The private key stays on the device or in the
// password manager; this page only relays the signed challenge to Supabase
// Auth, and logs or stores nothing.
(function () {
  const sb = () => window.supabaseClient;

  function supported() {
    return !!(window.PublicKeyCredential && navigator.credentials
      && typeof navigator.credentials.get === 'function' && typeof navigator.credentials.create === 'function');
  }

  async function available() {
    if (!supported() || !window.cpayAuthFeatures) return false;
    return (await window.cpayAuthFeatures()).passkeys === true;
  }

  // The person closed the browser prompt, or it timed out: say nothing.
  function cancelled(error) {
    const name = error?.name || error?.cause?.name || '';
    return name === 'NotAllowedError' || name === 'AbortError' || error?.code === 'ERROR_CEREMONY_ABORTED';
  }

  function message(error, during) {
    const code = error?.code || error?.error_code || '';
    if (window.cpayIsCaptchaError && window.cpayIsCaptchaError(error)) return window.CPAY_CAPTCHA_MESSAGE;
    if (error?.name === 'AuthRetryableFetchError' || error?.status === 0) return 'Could not reach the server. Check your connection and try again.';
    if (code === 'webauthn_credential_not_found') return 'That passkey is not set up for CPAY. Log in with your email and password, then add a passkey in Security.';
    if (code === 'passkey_disabled') return 'Passkeys are not available right now. Use your email and password.';
    if (code === 'user_banned') return 'This account cannot sign in.';
    if (code === 'webauthn_challenge_expired' || code === 'webauthn_challenge_not_found') return 'That took too long. Try again.';
    if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || code === 'webauthn_credential_exists') return 'This device or password manager already has a passkey for your account.';
    if (code === 'too_many_passkeys') return 'You have the most passkeys allowed. Remove one first.';
    if (code === 'insufficient_aal') return 'Enter the code from your authenticator app first, then try again.';
    if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID') return 'Passkeys do not work on this address. Open CPAY at its usual address and try again.';
    return during === 'add' ? 'Could not add the passkey. Try again.' : 'Passkey sign-in did not work. Try again, or use your email and password.';
  }

  // Sign in with whichever passkey the person picks. With Supabase Auth
  // CAPTCHA on, the challenge request carries a fresh Turnstile token.
  // Resolves { user }, { cancelled: true } or { error, code }.
  async function signIn({ container } = {}) {
    let captchaToken;
    try {
      if (window.cpayCaptchaOptions) ({ captchaToken } = await window.cpayCaptchaOptions('passkey', { container }));
    } catch (e) {
      return { error: e.message || window.CPAY_CAPTCHA_MESSAGE, code: 'captcha_failed' };
    }
    let data = null;
    let error = null;
    try {
      ({ data, error } = await sb().auth.signInWithPasskey({ options: { captchaToken } }));
    } catch (e) {
      error = e;
    }
    if (error) {
      if (cancelled(error)) return { cancelled: true };
      return { error: message(error, 'signin'), code: error.code || error.error_code || '' };
    }
    if (!data?.user) return { error: message(null, 'signin'), code: '' };
    return { user: data.user };
  }

  // Register a passkey for the signed-in account. Resolves { passkey },
  // { cancelled: true } or { error }.
  async function register() {
    let data = null;
    let error = null;
    try {
      ({ data, error } = await sb().auth.registerPasskey());
    } catch (e) {
      error = e;
    }
    if (error) return cancelled(error) ? { cancelled: true } : { error: message(error, 'add') };
    return { passkey: data };
  }

  async function list() {
    const { data, error } = await sb().auth.passkey.list();
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  async function remove(id) {
    const { error } = await sb().auth.passkey.delete({ passkeyId: id });
    if (error) throw error;
  }

  window.cpayPasskey = { supported, available, signIn, register, list, remove };
})();
