// Invoice view (QR checkout), shared by invoice-cpay-v2.html and the payment
// link page (404.html), which shows it in place after "Continue to payment"
// so the whole payment is one page. Wrapped so none of its names collide
// with the link page's own script.
(function(){
// Uses window.supabaseClient set up in config.js (same pattern as every other page)
const supabaseClient = window.supabaseClient;

// How long the page waits on a network step before it says so. The page
// never shows a spinner without an end.
const LOAD_TIMEOUT_MS = 15000;
const CREATE_TIMEOUT_MS = 25000;
// Status is pushed over Realtime where available; a slow read of the same
// public status RPC backs it up, so a dropped socket can't strand the payer.
const POLL_MS = 3000;

let timerInterval, pollTimer, loadTimer;
let currentPayCode = '';
let currentPayUrl = '';   // the lightning: URI handed to the OS
let currentCashAppUrl = '';
let returnPage = '/';
let currentPaymentId = '';
let merchantName = '';
let amountRequested = 0;
let linkSlug = '';
let session = null;       // sessionStorage cache from the payment link page
let finished = false;     // settled, expired or failed: stop all status work
// Direct payments (20261018010000): the invoice is the merchant's own
// wallet's, and the status comes from direct-invoice, which confirms it with
// the provider's proof of payment.
let DIRECT = false;   // set in start() from the URL
let EMBEDDED = false; // true on the payment link page (one-page flow)
let directInfo = null;    // { destination, proof, paymentHash } from the last direct read
let lastFocus = null;

// Ways out of this page on a phone:
//   * Pay with Lightning: the standard `lightning:` URI, for whichever
//     wallet the phone has registered. Also what tapping the QR does.
//   * Pay with Cash App: Cash App's universal link with the invoice in it,
//     https://cash.app/launch/lightning/<bolt11>. It opens Cash App on the
//     payment when the app is installed and the Cash App website when not.
//   * Other wallets: wallets-config.js, each with its own handoff.
// A desktop has none of these apps. The QR is the path there.
const CASHAPP_LIGHTNING = 'https://cash.app/launch/lightning/';

function cashAppUrl(bolt11){
  return CASHAPP_LIGHTNING + encodeURIComponent(String(bolt11).replace(/^lightning:/i, ''));
}
function isPhone(){ return /iPad|iPhone|iPod|Android/.test(navigator.userAgent); }
function el(id){ return document.getElementById(id); }
// Bare lowercase BOLT11 only (no lightning: prefix, no BIP21), for QR and copy.
function bareInvoice(){ return String(currentPayCode).trim().replace(/^lightning:/i, '').toLowerCase(); }
function money(n){ return '$' + Number(n || 0).toFixed(2); }
function shortRef(id){ return id.length > 18 ? id.slice(0, 8) + '…' + id.slice(-6) : id; }

function setPanel(node, on){ node.hidden = !on; node.setAttribute('aria-hidden', on ? 'false' : 'true'); }
function showStep(n){
  el('statePanel').hidden = true;
  setPanel(el('step2'), n === 2);
  setPanel(el('step3'), n === 3);
}

// title: null = loading (spinner). kind: 'expired' | 'failed' | 'error' | 'gone'
function showState({ title = null, sub = '', kind = '', primary = null, secondary = null } = {}){
  setPanel(el('step2'), false);
  setPanel(el('step3'), false);
  const panel = el('statePanel');
  panel.hidden = false;
  panel.dataset.kind = kind;
  el('stateSpinner').hidden = !!title;
  el('stateIcon').hidden = !title;
  el('stateIcon').textContent = kind === 'expired' ? '⏱' : (kind ? '!' : '');
  el('stateTitle').hidden = !title;
  el('stateTitle').textContent = title || '';
  el('stateSub').textContent = sub || '';
  for (const [id, action] of [['stateBtn', primary], ['stateBtn2', secondary]]){
    const btn = el(id);
    btn.hidden = !action;
    btn.disabled = false;
    btn.textContent = action ? action.label : '';
    btn.onclick = action ? action.run : null;
  }
}

function stopStatusWork(){
  finished = true;
  clearInterval(timerInterval);
  clearTimeout(pollTimer);
  clearTimeout(loadTimer);
}

const back = { label: 'Back', run: () => goBack() };

// An invoice reached by a shared or bookmarked URL can legitimately no
// longer exist. Say what happened instead of leaving a blank page.
function showInvoiceGone(msg){
  stopStatusWork();
  showState({
    title: msg || 'This payment is no longer available.',
    sub: 'Start a new payment to get a fresh payment request.',
    kind: 'gone',
    primary: { label: 'Start over', run: () => { window.location.href = returnPage || '/'; } },
  });
}

function showExpired(){
  stopStatusWork();
  sessionStorage.removeItem('invoiceSession');
  updateTimeline('expired');
  showState({
    title: 'This payment request expired',
    sub: 'It can no longer be paid. If you paid just before it expired, don\'t pay again: this page will switch to "Payment received" when it lands. Otherwise, generate a new one.',
    kind: 'expired',
    primary: { label: 'Generate new payment', run: regenerate },
    secondary: back,
  });
  lateCheck(Date.now() + 3 * 60 * 1000);
}

// A payment sent in the last seconds can still be settled after expiry.
// Keep a slow eye on it for a few minutes so the payer isn't told to pay
// twice. Read-only, same status RPC.
let lateTimer;
function lateCheck(until){
  clearTimeout(lateTimer);
  if (Date.now() > until) return;
  lateTimer = setTimeout(async () => {
    if (regenerating) return;
    try {
      const row = await fetchInvoiceRow();
      if (row && row.status === 'settled'){ finishAsSettled(row.amount_settled || amountRequested); return; }
    } catch {}
    lateCheck(until);
  }, 10000);
}

function showFailed(sub){
  stopStatusWork();
  sessionStorage.removeItem('invoiceSession');
  updateTimeline('failed');
  showState({
    title: 'This payment could not be completed',
    sub: sub || ('This request was cancelled and can no longer be paid. If money already left your wallet, keep reference ' + shortRef(currentPaymentId) + ' and contact ' + (merchantName || 'the person you were paying') + '.'),
    kind: 'failed',
    primary: { label: 'Try again', run: regenerate },
    secondary: back,
  });
}

function showLoadError(){
  clearTimeout(loadTimer);
  showState({
    title: "We couldn't load this payment",
    sub: 'Check your connection and try again. If you already paid, it will show as received once we can reach the server.',
    kind: 'error',
    primary: { label: 'Retry', run: () => window.location.reload() },
    secondary: back,
  });
}

function toast(msg){
  const t = el('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, 2800);
}

function renderQr(qrText){
  const box = el('qrcode');
  el('invoiceText').textContent = qrText;
  if (!box || box.dataset.rendered === '1') return;
  box.textContent = '';

  // The QR library comes from a CDN. An ad blocker, a corporate proxy or a
  // flaky connection can drop it. Show the request text instead; Copy and
  // the wallet buttons still work.
  if (typeof QRCode === 'undefined'){
    console.error('QR library failed to load');
    const fallback = document.createElement('div');
    fallback.className = 'qr-fallback';
    fallback.textContent = qrText;
    box.appendChild(fallback);
    box.dataset.rendered = '1';
    toast('QR code could not load. Use Copy payment request instead.');
    return;
  }

  // Black on white at high correction, because the Bolt logo sits over the
  // middle of the code and covers some of its modules.
  new QRCode(box, {
    text: qrText, width: 520, height: 520,
    colorDark: '#000000', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H,
  });
  // The QR button's aria-label names the code, so the drawn image is decorative.
  box.querySelectorAll('img').forEach((img) => { img.alt = ''; });
  box.dataset.rendered = '1';
}

// BTCPay checkout: a plain link to the store's checkout page, where the
// payer can also pay with on-chain bitcoin. https only.
function showCheckoutLink(url){
  if (typeof url !== 'string' || !url.startsWith('https://')) return;
  const anchor = document.getElementById('copyBtn');
  if (!anchor || document.getElementById('checkoutLink')) return;
  const a = document.createElement('a');
  a.id = 'checkoutLink';
  a.className = 'link-btn';
  a.href = url;
  a.rel = 'noopener';
  a.textContent = 'Pay with on-chain bitcoin';
  anchor.parentNode.insertAdjacentElement('afterend', a);
}

function readSession(){
  try {
    const saved = sessionStorage.getItem('invoiceSession');
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}

function withTimeout(promise, ms){
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

async function fetchInvoiceRow(){
  if (DIRECT){
    const r = await window.cpayDirectPay.status(currentPaymentId, LOAD_TIMEOUT_MS);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.data && r.data.error || 'status unavailable');
    const row = window.cpayDirectPay.toRow(r.data);
    directInfo = { destination: row.destination || '', proof: row.proof || '', paymentHash: row.payment_hash || '' };
    return row;
  }
  const { data: rows, error } = await withTimeout(
    supabaseClient.rpc('get_invoice_public', { p_payment_id: currentPaymentId }), LOAD_TIMEOUT_MS);
  if (error) throw error;
  return Array.isArray(rows) ? rows[0] : rows;
}

async function boot(){
  // Never an endless spinner: if anything below hangs, say so.
  loadTimer = setTimeout(showLoadError, LOAD_TIMEOUT_MS + 2000);

  if (!supabaseClient){ showLoadError(); return; }
  // The design named in the URL (set by the payment page) wins; without one
  // the page uses the domain default.
  let domainDesign = null;
  try { domainDesign = await withTimeout(applyDomainTheme(), 5000); } catch {}
  setDesign(new URLSearchParams(window.location.search).get('theme') || domainDesign);

  // The id in the URL is the source of truth. sessionStorage is only a
  // cache from the page that created this invoice, so the QR can paint
  // before the round trip finishes — and it is trusted only when it refers
  // to the same invoice the URL names.
  const urlId = new URLSearchParams(window.location.search).get('id');
  const cached = readSession();

  currentPaymentId = urlId || cached?.paymentId || null;
  if (!currentPaymentId){ clearTimeout(loadTimer); window.location.href = '/'; return; }

  const cacheMatches = cached && cached.paymentId === currentPaymentId;
  if (cacheMatches) session = cached;
  returnPage = (cacheMatches && cached.returnUrl) || '/';

  if (cacheMatches && (cached.payCode || cached.qrText)){
    currentPayCode = cached.payCode || cached.qrText;
    // payUrl from create-invoice is already `lightning:<bolt11>`. Anything
    // else (an https checkout link) must not be treated as a deep link.
    currentPayUrl = (cached.payUrl && cached.payUrl.startsWith('lightning:'))
      ? cached.payUrl
      : 'lightning:' + bareInvoice();
    if (cached.cashAppUrl && cached.cashAppUrl.startsWith(CASHAPP_LIGHTNING)) currentCashAppUrl = cached.cashAppUrl;
    renderQr(bareInvoice());
  }
  if (cacheMatches) showCheckoutLink(cached.checkoutUrl);

  let row;
  try { row = await fetchInvoiceRow(); }
  catch (e){ console.error('invoice lookup failed:', e); showLoadError(); return; }
  clearTimeout(loadTimer);
  if (!row){ showInvoiceGone(); return; }

  // Rebuild the QR from the server when there was no usable cache — this is
  // what makes the link work on a second device, after a refresh, or once
  // the tab has been closed and reopened.
  if (!currentPayCode && row.lightning_invoice){
    currentPayCode = row.lightning_invoice;
    currentPayUrl = 'lightning:' + bareInvoice();
    renderQr(bareInvoice());
  }
  if (!currentPayCode){ showInvoiceGone(); return; }

  merchantName = row.merchant_name || row.link_slug || '';
  linkSlug = row.link_slug || '';
  amountRequested = Number(row.amount_requested || 0);
  el('merchantName').textContent = merchantName || 'CPAY';
  el('merchantAvatar').textContent = ([...merchantName.trim()][0] || '$').toUpperCase();
  el('amountDue').textContent = money(amountRequested);
  el('refShort').textContent = shortRef(currentPaymentId);
  document.title = (merchantName ? 'Pay ' + merchantName : 'Pay') + ' · CPAY';

  if (linkSlug) returnPage = '/' + linkSlug;
  if (DIRECT && directInfo){
    const note = el('directNote');
    note.textContent = 'Goes straight to ' + (merchantName || 'the merchant') + "'s own wallet"
      + (directInfo.destination ? ' (' + directInfo.destination + ')' : '') + '. CPAY does not hold this payment.';
    note.hidden = false;
  }
  applyWalletMode();

  if (row.status === 'settled'){ finishAsSettled(row.amount_settled || row.amount_requested); return; }
  if (row.status === 'expired'){ showExpired(); return; }
  if (row.status === 'invalid'){ showFailed(); return; }

  showStep(2);
  setStatus(row.status === 'pending' ? 'detected' : 'waiting');
  startTimer(row.expires_at);
  schedulePoll();
}

// wallet=cashapp (set per payment link) makes Cash App the main button.
function applyWalletMode(){
  const mode = new URLSearchParams(location.search).get('wallet') || 'all_wallets';
  document.documentElement.setAttribute('data-wallet', mode);
  if (mode === 'cashapp'){
    const cash = el('cashAppBtn'), ln = el('payBtn');
    cash.classList.replace('btn-alt', 'btn-pay');
    ln.classList.replace('btn-pay', 'btn-alt');
    el('payActions').insertBefore(cash, ln);
  }
}

/* ---------- status ---------- */
const STATUS_TEXT = {
  waiting: 'Awaiting payment…',
  detected: 'Payment detected · confirming',
};
function setStatus(state){
  const chip = el('statusChip');
  chip.dataset.state = state;
  chip.textContent = STATUS_TEXT[state] || STATUS_TEXT.waiting;
  // While a payment is confirming, don't invite a second one.
  const busy = state === 'detected';
  for (const id of ['payBtn', 'cashAppBtn', 'otherWalletsBtn']) el(id).disabled = busy;
  el('payHint').textContent = busy
    ? 'Your payment is on its way. Keep this page open; it updates by itself.'
    : 'The amount is already in the request. Pay before the timer runs out.';
  updateTimeline(state);
}
function updateTimeline(state){
  const tl = el('statusTimeline');
  if (!tl) return;
  const order = ['created', 'waiting', 'detected', 'settled'];
  let active = state === 'detected' ? 'detected' : (state === 'settled' ? 'settled' : 'waiting');
  if (state === 'expired' || state === 'failed') active = 'waiting';
  const idx = order.indexOf(active);
  tl.querySelectorAll('li').forEach((li) => {
    const step = li.dataset.step;
    const si = order.indexOf(step);
    li.classList.remove('done', 'current', 'failed');
    if (state === 'expired' || state === 'failed') {
      if (step === 'waiting') li.classList.add('failed');
      else if (si < 1) li.classList.add('done');
      return;
    }
    if (si < idx) li.classList.add('done');
    else if (si === idx) li.classList.add(si === order.length - 1 ? 'done' : 'current');
  });
}

function applyStatus(row){
  if (finished || !row) return;
  if (row.status === 'settled') finishAsSettled(row.amount_settled || amountRequested);
  else if (row.status === 'expired') showExpired();
  else if (row.status === 'invalid') showFailed();
  else if (row.status === 'pending') setStatus('detected');
}

// No Realtime: anon has no SELECT on payments (20261007110000), so other
// payers' rows can never be listed. The page follows its own invoice by id.
// The same read-only status RPC the page loads with (get_invoice_public,
// this invoice's id only), every few seconds while the tab is visible. Errors
// update separate read-availability feedback and are retried; the expiry
// timer still bounds the wait.
function schedulePoll(delay = POLL_MS){
  clearTimeout(pollTimer);
  if (finished) return;
  pollTimer = setTimeout(pollOnce, delay);
}
// Connection feedback is display-only; it never confirms a payment.
function updateStatusSync(connected){
  const note = el('statusSync');
  if (!note) return;
  const text = connected ? 'Payment status updates automatically.' : 'Payment status is temporarily unavailable. We are checking again. Check your wallet before trying to pay again.';
  if (note.textContent !== text) note.textContent = text;
  note.dataset.connection = connected ? 'ok' : 'interrupted';
}
async function pollOnce(){
  if (finished) return;
  if (document.visibilityState === 'hidden'){ schedulePoll(); return; }
  try {
    const row = await fetchInvoiceRow();
    applyStatus(row);
    if (!finished) updateStatusSync(Boolean(row));
  } catch { if (!finished) updateStatusSync(false); }
  schedulePoll();
}
document.addEventListener('visibilitychange', () => {
  // Back from the wallet app: check straight away.
  if (document.visibilityState === 'visible' && !finished && currentPaymentId && !el('step2').hidden) schedulePoll(0);
});

/* ---------- clipboard ---------- */
async function copyText(text){
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Older iOS Safari and any non-secure context reject the async
    // clipboard API. execCommand still works there.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      console.error('copy failed:', e2);
      return false;
    }
  }
}
const copyInvoice = () => copyText(bareInvoice());

async function copyAddress(){
  const btn = el('copyBtn');
  const ok = await copyInvoice();
  if (!ok){ toast('Could not copy. Open "Show payment request" and copy it by hand.'); el('rawRequest').open = true; return; }
  btn.textContent = 'Copied';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = 'Copy address'; btn.classList.remove('done'); }, 2000);
}

async function copyRefChip(){
  toast(await copyText(currentPaymentId) ? 'Reference copied' : 'Could not copy the reference');
}

/* ---------- wallet handoff ---------- */
// The request goes on the clipboard first either way, so a paste is one
// tap away if nothing opens.
async function handOff(url, name){
  if (!currentPayCode || finished) return;
  const copied = await copyInvoice();
  if (!isPhone()){
    toast(copied ? `Payment request copied. Scan the QR code with ${name || 'your wallet'} on your phone.`
                 : `Scan the QR code with ${name || 'your wallet'} on your phone.`);
    return;
  }
  toast(name ? `Opening ${name}…` : 'Opening your wallet…');
  window.location.href = url;
}
const openLightning = () => handOff(currentPayUrl || ('lightning:' + bareInvoice()), '');
const openCashApp = () => handOff(currentCashAppUrl || cashAppUrl(currentPayCode), 'Cash App');

function walletUrl(w){
  const fill = (tpl) => tpl.split('{bolt11}').join(encodeURIComponent(bareInvoice()));
  if (w.handoff === 'universal' && w.universalLink && w.universalLink.startsWith('https://')) return fill(w.universalLink);
  if (w.handoff === 'deeplink' && w.deepLink && /^[a-z][a-z0-9+.-]*:/i.test(w.deepLink) && !/^(javascript|data|vbscript|file):/i.test(w.deepLink)) return fill(w.deepLink);
  return 'lightning:' + bareInvoice();
}

async function chooseWallet(w){
  closeSheet();
  if (w.handoff === 'copy'){
    const ok = await copyInvoice();
    toast(ok ? (w.copyHint || `Copied. Open ${w.displayName} and paste.`) : 'Could not copy. Use "Show payment request".');
    return;
  }
  handOff(walletUrl(w), w.displayName);
}

const PLATFORM_LABEL = { ios: 'iPhone', android: 'Android', web: 'Web' };
function walletRow(w){
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'wallet-row';
  row.setAttribute('role', 'listitem');
  const badge = document.createElement('span');
  badge.className = 'wallet-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = ([...String(w.displayName)][0] || '?').toUpperCase();
  const text = document.createElement('span');
  text.className = 'wallet-text';
  const name = document.createElement('span');
  name.className = 'wallet-name';
  name.textContent = w.displayName;
  const meta = document.createElement('span');
  meta.className = 'wallet-meta';
  meta.textContent = (w.platforms || []).map((p) => PLATFORM_LABEL[p] || p).join(' · ')
    + (w.handoff === 'copy' ? ' · copy and paste' : '');
  text.append(name, meta);
  const go = document.createElement('span');
  go.className = 'wallet-go';
  go.setAttribute('aria-hidden', 'true');
  go.textContent = w.handoff === 'copy' ? 'Copy' : 'Open';
  row.append(badge, text, go);
  row.addEventListener('click', () => chooseWallet(w));
  return row;
}

function renderWallets(){
  const all = Array.isArray(window.CPAY_WALLETS) ? window.CPAY_WALLETS : [];
  const usable = all.filter((w) => w && w.enabled && w.lightning && (w.invoiceTypes || []).includes('bolt11') && w.id !== 'cashapp');
  const featured = usable.filter((w) => w.group === 'featured' && w.verification?.status === 'verified');
  // Anything not verified is only ever offered with the plain lightning:
  // handoff (or copy), never with an app-specific link.
  const other = usable.filter((w) => !featured.includes(w)).map((w) =>
    w.verification?.status === 'verified' ? w : { ...w, handoff: w.handoff === 'copy' ? 'copy' : 'lightning' });
  const any = { id: 'any', displayName: 'Open in my Lightning wallet', platforms: ['ios', 'android'], handoff: 'lightning' };
  el('walletListFeatured').replaceChildren(...featured.map(walletRow));
  el('walletListOther').replaceChildren(walletRow(any), ...other.map(walletRow));
}

function openSheet(){
  if (finished) return;
  lastFocus = document.activeElement;
  renderWallets();
  const s = el('walletSheet');
  s.hidden = false; s.setAttribute('aria-hidden', 'false'); s.classList.add('open');
  const first = s.querySelector('.wallet-row') || el('walletSheetClose');
  first.focus();
}
function closeSheet(){
  const s = el('walletSheet');
  if (s.hidden) return;
  s.classList.remove('open'); s.hidden = true; s.setAttribute('aria-hidden', 'true');
  (lastFocus && lastFocus.focus ? lastFocus : el('otherWalletsBtn')).focus();
}

function openModal(){
  const m = el('howToPayModal');
  m.hidden = false;
  m.setAttribute('aria-hidden', 'false');
  m.classList.add('open');
  el('modalCloseBtn').focus();
}
function closeModal(){
  const m = el('howToPayModal');
  m.classList.remove('open');
  m.hidden = true;
  m.setAttribute('aria-hidden', 'true');
  el('helpBtn').focus();
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el('walletSheet').hidden) closeSheet();
  else if (!el('howToPayModal').hidden) closeModal();
});

/* ---------- timer ---------- */
// A BTCPay checkout can remain open after the Blink-signed BOLT11 has expired.
// Use the earlier of the server deadline and the invoice's own BOLT11 expiry.
// This is display-only: never marks an invoice paid/expired in the ledger.
// Invalid/unknown invoice formats fall back to the server deadline.
function bolt11ExpiryMs(input){
  const raw = String(input || '').trim().replace(/^lightning:/i, '');
  if (raw.length < 120 || raw.length > 4000 || (raw !== raw.toLowerCase() && raw !== raw.toUpperCase())) return null;
  const invoice = raw.toLowerCase();
  const sep = invoice.lastIndexOf('1');
  const hrp = invoice.slice(0, sep);
  if (sep < 4 || !/^ln(?:bc|tb|tbs|bcrt)(?:[0-9]+[munp]?)?$/.test(hrp)) return null;
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = [...invoice.slice(sep + 1)].map((c) => alphabet.indexOf(c));
  if (data.length < 7 + 104 + 6 || data.some((v) => v < 0)) return null;
  // BOLT11 uses Bech32, not Bech32m. Reject corrupted invoices.
  const hrpValues = [...hrp].map((c) => c.charCodeAt(0));
  const values = [
    ...hrpValues.map((c) => c >> 5), 0, ...hrpValues.map((c) => c & 31), ...data,
  ];
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i];
  }
  if ((chk >>> 0) !== 1) return null;
  const words = data.slice(0, -6);
  const tagEnd = words.length - 104;
  const toNumber = (arr) => arr.reduce((n, w) => n * 32 + w, 0);
  const timestamp = toNumber(words.slice(0, 7));
  let expirySeconds = 3600;
  for (let i = 7; i < tagEnd;) {
    if (i + 3 > tagEnd) return null;
    const type = words[i], len = words[i + 1] * 32 + words[i + 2];
    if (i + 3 + len > tagEnd) return null;
    if (type === 6 && len > 0 && len <= 7) expirySeconds = toNumber(words.slice(i + 3, i + 3 + len));
    i += 3 + len;
  }
  const expiresAt = (timestamp + expirySeconds) * 1000;
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
}
function effectiveInvoiceExpiryMs(serverExpiresAt, bolt11){
  const serverMs = new Date(serverExpiresAt).getTime();
  const boltMs = bolt11ExpiryMs(bolt11);
  if (boltMs === null) return serverMs;
  return Number.isFinite(serverMs) ? Math.min(serverMs, boltMs) : boltMs;
}

function startTimer(expiresAt){
  clearInterval(timerInterval);
  const expiryMs = effectiveInvoiceExpiryMs(expiresAt, currentPayCode);
  if (!Number.isFinite(expiryMs)) { updateTimerPill(0); return; }

  const update = async () => {
    const secondsLeft = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
    updateTimerPill(secondsLeft);
    if (secondsLeft > 0 || finished) return;
    clearInterval(timerInterval);
    // A payment can land in the last second: check once before saying expired.
    try { const row = await fetchInvoiceRow(); if (row && row.status === 'settled'){ applyStatus(row); return; } } catch {}
    if (!finished) showExpired();
  };

  update();
  timerInterval = setInterval(update, 1000);
}

function updateTimerPill(t){
  const m = Math.floor(t/60), s = t%60;
  const pill = el('timerPill');
  pill.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  pill.classList.toggle('urgent', t < 60);
  pill.setAttribute('aria-label', `Expires in ${m} minutes ${s} seconds`);
}

function finishAsSettled(amount){
  stopStatusWork();
  clearTimeout(lateTimer);
  closeSheet();
  sessionStorage.removeItem('invoiceSession');
  updateTimeline('settled');
  showStep(3);

  const paid = Number.isFinite(parseFloat(amount)) ? parseFloat(amount).toFixed(2) : Number(amountRequested).toFixed(2);
  // The status read carries no settlement time, so this is when this page
  // saw the payment confirmed.
  const when = new Date();
  el('successAmount').textContent = '$' + paid;
  el('rcpMerchant').textContent = merchantName || '—';
  el('rcpAmount').textContent = '$' + paid + ' USD';
  el('rcpDate').textContent = when.toLocaleString();
  el('rcpRef').textContent = shortRef(currentPaymentId);
  if (DIRECT && directInfo && directInfo.proof){
    el('rcpProof').textContent = shortRef(directInfo.proof);
    el('rcpProofRow').hidden = false;
    el('rcpDirectNote').textContent = 'Paid straight to ' + (directInfo.destination || "the merchant's wallet")
      + ", confirmed by the merchant's wallet provider. CPAY did not hold this payment, so a refund is between you and the merchant. The saved receipt has the full proof of payment.";
    el('rcpDirectNote').hidden = false;
  }
  el('successTitle').focus();

  // Stash the full values for the copy and save actions, so neither has
  // to re-derive them from the truncated text on screen.
  receipt = {
    merchant: merchantName || 'Unknown',
    amount: paid,
    date: when.toLocaleString(),
    iso: when.toISOString(),
    reference: currentPaymentId,
    direct: DIRECT && directInfo ? { ...directInfo } : null,
  };
}

let receipt = null;

function receiptText(){
  if (!receipt) return '';
  return [
    'Payment receipt',
    '',
    `Paid to    ${receipt.merchant}`,
    `Amount     $${receipt.amount} USD`,
    `Confirmation seen  ${receipt.date}`,
    `Reference  ${receipt.reference}`,
    ...(receipt.direct && receipt.direct.proof ? [
      `Paid to    ${receipt.direct.destination} (the merchant's own wallet)`,
      `Payment hash      ${receipt.direct.paymentHash}`,
      `Proof of payment  ${receipt.direct.proof}`,
      '',
      'This payment went straight to the merchant\'s wallet; CPAY never held',
      'it. The merchant\'s wallet provider confirmed it with this proof of',
      'payment, whose SHA-256 is the payment hash of the invoice you paid.',
      'Your own wallet shows the same payment hash and proof.',
    ] : []),
    '',
    'Keep this reference. It is what identifies this payment if you',
    'ever need to ask about it.',
  ].join('\n');
}

async function copyReference(){
  if (!receipt) return;
  toast(await copyText(receipt.reference) ? 'Reference copied' : 'Could not copy. Write the reference down.');
}

function saveReceipt(){
  if (!receipt) return;
  // A .txt file rather than a PDF: no library to load on a page a
  // stranger just opened on mobile data, and every phone can open it.
  const blob = new Blob([receiptText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipt-${receipt.iso.slice(0,10)}-${receipt.reference.slice(0,8)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Receipt saved');
}

function goBack(){
  stopStatusWork();
  clearTimeout(lateTimer);
  window.location.href = returnPage;
}

/* ---------- new payment after expiry or failure ----------
   Same request the payment link page sends (create-invoice with the link
   and the amount the payer typed), so pricing and limits are the server's.
   When this browser didn't create the original (shared link, other device)
   the typed amount isn't known, so the payer goes back to the link page. */
let regenerating = false;
async function regenerate(){
  if (regenerating) return;
  const slug = linkSlug || (session?.returnUrl || '').replace(/^\/|\/$/g, '');
  const base = Number(session?.baseAmount);
  if (!slug){ window.location.href = '/'; return; }
  if (!Number.isFinite(base) || base <= 0){ window.location.href = '/' + encodeURIComponent(slug); return; }
  regenerating = true;
  const btn = el('stateBtn');
  btn.disabled = true;
  btn.textContent = 'Creating new payment…';
  const reqScope = 'regen:' + slug + ':' + base + ':' + (currentPaymentId || '');
  try {
    const requestId = window.cpayRequestId ? window.cpayRequestId(reqScope) : undefined;
    const turnstileToken = window.cpayTurnstileToken ? await window.cpayTurnstileToken('pay') : null;
    let res, result;
    if (DIRECT){
      const r = await window.cpayDirectPay.create({ slug, amount: base, requestId, turnstileToken: turnstileToken || undefined }, CREATE_TIMEOUT_MS);
      res = { ok: r.ok, status: r.status };
      result = r.data;
      // The link pays the CPAY balance again: start over on the link page.
      if (res.status === 409 && result.code === 'custodial_link'){ window.location.href = '/' + encodeURIComponent(slug); return; }
    } else {
      const body = JSON.stringify({ slug, amount: base, requestId, turnstileToken: turnstileToken || undefined });
      const post = (url) => withTimeout(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), CREATE_TIMEOUT_MS);
      try {
        res = await post('/api/create-invoice');
        if (res.status === 404 || res.status === 405) throw new Error('proxy unavailable');
      } catch (e) {
        if (e && e.message === 'timeout') throw e;
        res = await post(`${window.SUPABASE_URL}/functions/v1/create-invoice`);
      }
      result = await res.json().catch(() => ({}));
      if (res.status === 409 && result.code === 'direct_link'){ window.location.href = '/' + encodeURIComponent(slug); return; }
    }
    if (!res.ok || !result.paymentId){
      if (res.status === 409 && window.cpayForgetRequestId) window.cpayForgetRequestId(reqScope);
      throw new Error(typeof result.error === 'string' ? result.error : 'Could not create a new payment.');
    }
    if (window.cpayForgetRequestId) window.cpayForgetRequestId(reqScope);
    // BTCPay checkout (docs/BTCPAY.md): with no Lightning invoice, the
    // payer goes straight to the store's own checkout page.
    const checkoutUrl = typeof result.checkoutUrl === 'string' && result.checkoutUrl.startsWith('https://') ? result.checkoutUrl : '';
    if (!result.payCode && checkoutUrl){ window.location.href = checkoutUrl; return; }
    sessionStorage.setItem('invoiceSession', JSON.stringify({
      paymentId: result.paymentId, payCode: result.payCode, payUrl: result.payUrl, checkoutUrl,
      cashAppUrl: result.cashAppUrl || '', returnUrl: '/' + slug, baseAmount: base,
      settlement: DIRECT ? 'direct' : 'custodial',
    }));
    const q = new URLSearchParams(location.search);
    q.set('id', result.paymentId);
    window.location.href = (EMBEDDED ? '/' + encodeURIComponent(slug) + '?' : '/invoice-cpay-v2.html?') + q.toString();
  } catch (e) {
    regenerating = false;
    btn.disabled = false;
    btn.textContent = 'Try again';
    el('stateSub').textContent = e && e.message === 'timeout'
      ? 'That took too long. Check your connection and try again.'
      : (e && e.message) || 'Could not create a new payment. Try again.';
  }
}

/* ---------- wiring ----------
   Listeners rather than inline onclick, so a renamed handler shows up as a
   missing-element error in testing instead of failing silently at a tap. */
async function shareInvoicePage(){
  const url = location.href;
  if (navigator.share){ try { await navigator.share({ title: merchantName || 'CPAY payment', text: 'Payment request from ' + (merchantName || 'CPAY'), url }); } catch {} }
  else toast(await copyText(url) ? 'Payment link copied' : 'Could not copy link');
}
async function copyInvoicePageLink(){ toast(await copyText(location.href) ? 'Payment link copied' : 'Could not copy link'); }

function downloadQr(){
  const node = el('qrcode');
  const canvas = node && node.querySelector('canvas');
  const img = node && node.querySelector('img');
  let href = '';
  if (canvas) {
    try { href = canvas.toDataURL('image/png'); } catch (e) { href = ''; }
  } else if (img && img.src) {
    href = img.src;
  }
  if (!href){ toast('QR is not ready yet'); return; }
  const a = document.createElement('a');
  a.href = href;
  a.download = 'cpay-payment-qr.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  toast('QR downloaded');
}
function wire(){
  el('shareInvoiceBtn').addEventListener('click', shareInvoicePage);
  el('copyLinkBtn').addEventListener('click', copyInvoicePageLink);
  el('downloadQrBtn').addEventListener('click', downloadQr);
  el('copyBtn').addEventListener('click', copyAddress);
  el('refChip').addEventListener('click', copyRefChip);
  el('payBtn').addEventListener('click', openLightning);
  el('cashAppBtn').addEventListener('click', openCashApp);
  el('otherWalletsBtn').addEventListener('click', openSheet);
  el('walletSheetClose').addEventListener('click', closeSheet);
  el('walletSheet').addEventListener('click', (e) => { if (e.target === el('walletSheet')) closeSheet(); });
  el('helpBtn').addEventListener('click', openModal);
  el('closeBtn').addEventListener('click', goBack);
  el('doneBtn').addEventListener('click', goBack);
  el('rcpCopyBtn').addEventListener('click', copyReference);
  el('rcpSaveBtn').addEventListener('click', saveReceipt);
  el('modalCloseBtn').addEventListener('click', closeModal);
  el('modalGotItBtn').addEventListener('click', closeModal);
  el('qrLink').addEventListener('click', openLightning);
  el('howToPayModal').addEventListener('click', (e) => {
    if (e.target === el('howToPayModal')) closeModal();
  });
}

let started = false;
function start(opts){
  if (started) return;
  started = true;
  EMBEDDED = Boolean(opts && opts.embedded);
  DIRECT = new URLSearchParams(window.location.search).get('settlement') === 'direct';
  wire();
  return boot();
}
window.cpayInvoice = { start };
if (!window.CPAY_INVOICE_EMBEDDED) window.addEventListener('DOMContentLoaded', () => start({}));
})();
