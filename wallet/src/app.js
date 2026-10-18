// CPAY Wallet: screens and flow. Everything user-supplied is shown with
// textContent, never as HTML.
//
// Lifecycle of the recovery phrase:
//   create  -> generated here (bip39.js), shown once for the paper backup,
//              checked against the paper, sealed with the passphrase
//              (vault.js), handed to the engine, then dropped from memory
//   unlock  -> opened from the vault, handed to the engine, dropped
//   reveal  -> opened from the vault on request, shown, hidden again
// A passkey wallet (passkey.js) has the same 12 words but keeps no copy:
// the passkey derives them at creation (shown once for the paper backup,
// checked), at every unlock and on reveal, and they are dropped after.
// It is never sent anywhere: not to CPAY, not in a URL, not in a log.
import { generateMnemonic, normalizeMnemonic, validateMnemonic } from './bip39.js';
import { MIN_PASSPHRASE, isPasskeyVault, openPhrase, passkeyRecord, sealPhrase, vaultStore } from './vault.js';
import { PASSKEY_LABEL, passkeyAvailability, passkeyErrorKind, passkeyMessage, registerPasskey, signInPasskey } from './passkey.js';
import { configProblem, createEngine, wipeEngineStorage } from './engine.js';
import { link, linkAvailable, linkedAccount, unlink, websiteBalance } from './link.js';
import { bitcoinUri, drawQr, lightningUri } from './qr.js';
import { lightningName } from './lnaddress.js';

const $ = (id) => document.getElementById(id);
const cfg = globalThis.CPAY_WALLET_CONFIG || {};
const AUTO_LOCK_MS = 5 * 60 * 1000;

const SCREENS = ['loading', 'notconfigured', 'welcome', 'backup', 'confirm', 'restore', 'setpass', 'unlock', 'home'];
function show(name) {
  for (const s of SCREENS) $(`s-${s}`).hidden = s !== name;
  $('lockBtn').hidden = name !== 'home';
  window.scrollTo(0, 0);
}
function err(id, msg) { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; }
const sats = (n) => Number(n || 0).toLocaleString('en-US');

let engine = null;
let pending = null; // phrase being set up (create/restore), dropped once sealed
let pendingHow = null; // 'created' (words checked against the paper) or 'restored'
let pendingPasskey = null; // { cred } while a passkey wallet's words are being checked
let lockTimer = null;

// ---- small records on this phone (no keys, no phrase) --------------------
// walletId: a one-way fingerprint of the phrase, so a restore can tell the
// same wallet (forgot the passphrase) from a different one (would replace
// it). 64 bits of SHA-256 over 128 bits of entropy: it cannot recover the
// phrase. backup: when the words were last checked. sends: payments that
// were sent but not yet seen as completed or failed. Field names are single
// letters and the id is prefixed, so nothing stored can look like a word of
// the phrase.
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* best effort */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* best effort */ } },
};
const ID_SLOT = 'cpay-wallet.id.v1';
const BACKUP_SLOT = 'cpay-wallet.backup.v1';
const SENDS_SLOT = 'cpay-wallet.sends.v1';
async function walletId(phrase) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cpay-wallet-id:${phrase}`)));
  return `id-${Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
const sends = () => store.get(SENDS_SLOT) || [];
// { k: idempotency key, d: destination as pasted, s: sats, t: when }
function rememberSend(p) {
  store.set(SENDS_SLOT, [...sends().filter((x) => x.k !== p.idempotencyKey), { k: p.idempotencyKey, d: p.to, s: p.amountSats, t: Date.now() }]);
}
const forgetSend = (key) => store.set(SENDS_SLOT, sends().filter((x) => x.k !== key));

function renderWords(listId, phrase) {
  const ol = $(listId);
  ol.replaceChildren(...phrase.split(' ').map((w) => { const li = document.createElement('li'); li.textContent = w; return li; }));
}

// ---- create ----------------------------------------------------------
$('createBtn').onclick = async () => {
  pending = await generateMnemonic(12);
  pendingPasskey = null;
  $('backupPasskeyNote').hidden = true;
  renderWords('words', pending);
  $('wroteIt').checked = false;
  $('backupNext').disabled = true;
  show('backup');
};
$('wroteIt').onchange = () => { $('backupNext').disabled = !$('wroteIt').checked; };

let confirmAt = [];
$('backupNext').onclick = () => {
  const idx = new Set();
  const r = new Uint32Array(8);
  crypto.getRandomValues(r);
  for (const v of r) { idx.add(v % 12); if (idx.size === 3) break; }
  while (idx.size < 3) idx.add(idx.size);
  confirmAt = [...idx].sort((a, b) => a - b);
  $('confirmFields').replaceChildren(...confirmAt.flatMap((i) => {
    const l = document.createElement('label'); l.htmlFor = `cw${i}`; l.textContent = `Word ${i + 1}`;
    const inp = document.createElement('input'); inp.id = `cw${i}`; inp.autocomplete = 'off'; inp.autocapitalize = 'none'; inp.spellcheck = false; inp.required = true;
    return [l, inp];
  }));
  $('words').replaceChildren(); // off the screen while checking
  err('confirmErr');
  show('confirm');
};
$('confirmBack').onclick = () => { renderWords('words', pending); show('backup'); };
$('confirmForm').onsubmit = (e) => {
  e.preventDefault();
  const words = pending.split(' ');
  const ok = confirmAt.every((i) => normalizeMnemonic($(`cw${i}`).value) === words[i]);
  if (!ok) { err('confirmErr', 'That does not match. Check your paper, or show the words again.'); return; }
  pendingHow = 'created';
  if (pendingPasskey) { finishPasskey(pending, pendingPasskey.cred, 'created'); return; }
  show('setpass');
};

// ---- passkey ---------------------------------------------------------
// Create: the passkey derives the words, which are then shown and checked
// exactly like generated ones; no passphrase is set.
async function passkeyAttempt(btn, errId, fn) {
  btn.disabled = true;
  err(errId);
  try { await fn(); } catch (x) { err(errId, passkeyMessage(passkeyErrorKind(x))); } finally { btn.disabled = false; }
}
$('pkCreateBtn').onclick = () => passkeyAttempt($('pkCreateBtn'), 'welcomeErr', async () => {
  const r = await registerPasskey();
  pending = r.phrase;
  pendingPasskey = { cred: r.credentialId };
  $('backupPasskeyNote').hidden = false;
  renderWords('words', pending);
  $('wroteIt').checked = false;
  $('backupNext').disabled = true;
  show('backup');
});
// Sign in on a phone without a wallet yet (a new phone, or after removing
// it). The words were written down when the passkey wallet was created.
$('pkSignInBtn').onclick = () => passkeyAttempt($('pkSignInBtn'), 'welcomeErr', async () => {
  const r = await signInPasskey(null);
  await finishPasskey(r.phrase, r.credentialId, 'signedin');
});
async function finishPasskey(phrase, cred, how) {
  try {
    const id = await walletId(phrase);
    if (vaultStore.load() && store.get(ID_SLOT) !== id) { await wipeEngineStorage(); store.del(SENDS_SLOT); }
    vaultStore.save(passkeyRecord(cred, PASSKEY_LABEL));
    store.set(ID_SLOT, id);
    // h: 1 = words checked against the paper at creation, 3 = opened with
    // the passkey on this phone (words not checked here).
    store.set(BACKUP_SLOT, { h: how === 'created' ? 1 : 3, t: Date.now() });
    await start(phrase);
  } catch (x) {
    err(how === 'created' ? 'confirmErr' : 'welcomeErr', x.message || 'Could not open the wallet.');
  } finally {
    pending = null; pendingHow = null; pendingPasskey = null;
  }
}
$('unlockPkBtn').onclick = () => passkeyAttempt($('unlockPkBtn'), 'unlockPkErr', async () => {
  const v = vaultStore.load();
  const r = await signInPasskey(v?.cred, { existing: true });
  if (store.get(ID_SLOT) && store.get(ID_SLOT) !== (await walletId(r.phrase))) throw new Error('A different passkey was used.');
  await start(r.phrase);
});
$('pkLostLink').onclick = (e) => { e.preventDefault(); startRestore(); };

// The unlock screen matches how this phone's wallet is kept.
function showUnlock() {
  const pk = isPasskeyVault(vaultStore.load());
  $('unlockPasskey').hidden = !pk;
  $('unlockForm').hidden = pk;
  $('forgotNote').hidden = pk;
  err('unlockPkErr');
  show('unlock');
}

// ---- restore ---------------------------------------------------------
function startRestore() {
  pendingPasskey = null;
  $('restoreWords').value = ''; err('restoreErr');
  $('restoreReplace').hidden = true; $('replaceOk').checked = false; $('replaceText').value = '';
  show('restore');
}
$('restoreStartBtn').onclick = startRestore;
$('restoreCancel').onclick = () => (vaultStore.load() ? showUnlock() : showWelcome());
$('forgotLink').onclick = (e) => { e.preventDefault(); startRestore(); };
$('restoreForm').onsubmit = async (e) => {
  e.preventDefault();
  const phrase = normalizeMnemonic($('restoreWords').value);
  if (!(await validateMnemonic(phrase))) { err('restoreErr', 'That is not a valid 12- or 24-word recovery phrase. Check each word and the order.'); return; }
  // Restoring over a different wallet deletes it from this phone: never
  // without an explicit confirmation. The same wallet (a forgotten
  // passphrase) needs none.
  if (vaultStore.load() && store.get(ID_SLOT) !== (await walletId(phrase))) {
    if ($('restoreReplace').hidden) { $('restoreReplace').hidden = false; $('replaceOk').focus(); return; }
    if (!$('replaceOk').checked || $('replaceText').value.trim() !== 'REPLACE') {
      err('restoreErr', 'Tick the box and type REPLACE to replace the wallet on this phone, or go back.');
      return;
    }
  }
  $('restoreWords').value = '';
  pending = phrase;
  pendingHow = 'restored';
  show('setpass');
};

// ---- passphrase, then connect -----------------------------------------
$('passForm').onsubmit = async (e) => {
  e.preventDefault();
  const p1 = $('pass1').value; const p2 = $('pass2').value;
  if (p1.length < MIN_PASSPHRASE) { err('passErr', `Use at least ${MIN_PASSPHRASE} characters.`); return; }
  if (p1 !== p2) { err('passErr', 'The two passphrases differ.'); return; }
  $('passBtn').disabled = true;
  err('passErr');
  try {
    const id = await walletId(pending);
    // A different wallet's local state is removed only after the restore
    // screen's explicit confirmation (above); the same wallet keeps its own.
    if (vaultStore.load() && store.get(ID_SLOT) !== id) { await wipeEngineStorage(); store.del(SENDS_SLOT); }
    vaultStore.save(await sealPhrase(pending, p1));
    store.set(ID_SLOT, id);
    // h: 1 = words checked against the paper at creation, 2 = restored from them.
    store.set(BACKUP_SLOT, { h: pendingHow === 'created' ? 1 : 2, t: Date.now() });
    await start(pending);
  } catch (x) {
    err('passErr', x.message || 'Could not create the wallet.');
  } finally {
    pending = null;
    pendingHow = null;
    $('pass1').value = ''; $('pass2').value = '';
    $('passBtn').disabled = false;
  }
};

$('unlockForm').onsubmit = async (e) => {
  e.preventDefault();
  $('unlockBtn').disabled = true;
  err('unlockErr');
  try {
    const phrase = await openPhrase(vaultStore.load(), $('unlockPass').value);
    $('unlockPass').value = '';
    await start(phrase);
  } catch (x) {
    err('unlockErr', x.message === 'Wrong passphrase.' ? 'Wrong passphrase.' : 'Could not unlock. Try again.');
  } finally {
    $('unlockBtn').disabled = false;
  }
};

async function start(phrase) {
  engine = engine || await createEngine();
  await engine.connect(phrase, () => { refresh(); if (!$('fundOut').hidden) renderDeposits(); });
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  show('home');
  $('fundPanel').hidden = cfg.network !== 'regtest';
  armLock();
  renderBackupStatus();
  await refresh();
  await renderLink();
}

function renderBackupStatus() {
  const b = store.get(BACKUP_SLOT);
  const when = b?.t ? new Date(b.t).toLocaleDateString() : '';
  $('backupStatus').textContent = !b
    ? 'Recovery phrase: not recorded on this phone. Show it and check it against your paper copy.'
    : b.h === 1
      ? `Recovery phrase: you checked your paper copy when you created this wallet (${when}).`
      : b.h === 3
        ? `Recovery phrase: not checked on this phone. This wallet was opened with its passkey (${when}). Show the words and check them against your paper copy.`
        : `Recovery phrase: this wallet was restored from it on this phone (${when}).`;
}

// ---- home ------------------------------------------------------------
async function refresh() {
  if (!engine) return;
  try {
    const { balanceSats } = await engine.info();
    $('balSats').textContent = sats(balanceSats);
    const list = await engine.payments();
    $('history').replaceChildren(...list.map((p) => {
      const li = document.createElement('li');
      const sign = p.type === 'send' ? '−' : '+';
      const when = p.timestamp ? new Date(p.timestamp * 1000).toLocaleString() : '';
      const status = p.status === 'pending' && p.type === 'send' ? 'in progress, do not pay again' : p.status;
      li.textContent = `${sign}${sats(p.amountSats)} sats · ${status}${p.type === 'send' && p.feesSats ? ` · fee ${sats(p.feesSats)}` : ''} · ${when}`;
      return li;
    }));
    $('historyEmpty').hidden = list.length > 0;
    await reconcileSends();
  } catch { /* keep the last numbers on a failed refresh */ }
}

// Sends this phone started whose outcome is not settled yet, checked
// against the library's own record (never re-sent). One the library has no
// record of is kept a day for the "you already tried this" warning: a new
// send gets a new idempotency key, which nothing would de-duplicate. Only
// the library's own "pending" counts as in progress.
async function reconcileSends() {
  let open = 0;
  for (const s of sends()) {
    const p = await engine.payment(s.k);
    if (p && (p.status === 'completed' || p.status === 'failed')) forgetSend(s.k);
    else if (!p && Date.now() - s.t > 86_400_000) forgetSend(s.k);
    else if (p) open++;
  }
  $('pendingSends').textContent = open
    ? `${open} payment${open === 1 ? ' is' : 's are'} not confirmed yet. ${open === 1 ? 'It' : 'They'} may still complete: check Activity before paying again.`
    : '';
  $('pendingSends').hidden = !open;
}

$('receiveBtn').onclick = () => {
  $('receivePanel').hidden = !$('receivePanel').hidden; $('sendPanel').hidden = true;
  if (!$('receivePanel').hidden) renderLightningAddress();
};
$('sendBtn').onclick = () => { $('sendPanel').hidden = !$('sendPanel').hidden; $('receivePanel').hidden = true; };

$('receiveForm').onsubmit = async (e) => {
  e.preventDefault();
  err('rcvErr');
  try {
    const amount = Number($('rcvAmount').value) || undefined;
    const r = await engine.receive({ amountSats: amount, description: $('rcvNote').value.trim() });
    $('rcvInvoice').value = r.request;
    drawQr($('rcvQr'), lightningUri(r.request));
    $('rcvOut').hidden = false;
    $('rcvShare').hidden = !navigator.share;
  } catch (x) {
    err('rcvErr', x.message || 'Could not create an invoice. Check the connection and try again.');
  }
};
$('rcvCopy').onclick = () => navigator.clipboard?.writeText($('rcvInvoice').value);

// ---- Lightning address -------------------------------------------------
// Only on builds that name a domain (LIGHTNING_ADDRESS_DOMAIN). Names are
// checked when the person taps Check, not on every keystroke: each check is
// a signed request to the server.
let lnaChecked = null; // the name that was last found available
async function renderLightningAddress() {
  const domain = cfg.lnAddressDomain;
  $('lnaBox').hidden = !domain;
  if (!domain) return;
  $('lnaExample').textContent = `name@${domain}`;
  $('lnaAt').textContent = `@${domain}`;
  let a = null;
  try { a = await engine.lightningAddress(); } catch { /* shown as not set; Check will report a real failure */ }
  $('lnaHave').hidden = !a;
  $('lnaForm').hidden = Boolean(a);
  if (a) {
    $('lnaAddress').textContent = a.address;
    drawQr($('lnaQr'), lightningUri(a.lnurl || a.address));
    $('lnaShare').hidden = !navigator.share;
  }
}
$('lnaName').oninput = () => { lnaChecked = null; $('lnaSave').disabled = true; err('lnaErr'); $('lnaOk').hidden = true; };
$('lnaCheck').onclick = async () => {
  err('lnaErr'); $('lnaOk').hidden = true;
  const name = lightningName($('lnaName').value);
  if (!name.ok) { err('lnaErr', name.why); return; }
  $('lnaCheck').disabled = true;
  try {
    if (await engine.lightningAddressAvailable(name.value)) {
      lnaChecked = name.value;
      $('lnaOk').textContent = `${name.value}@${cfg.lnAddressDomain} is available.`;
      $('lnaOk').hidden = false;
      $('lnaSave').disabled = false;
    } else {
      err('lnaErr', 'That name is taken. Try another.');
    }
  } catch {
    err('lnaErr', 'Could not check the name. Check the connection and try again.');
  } finally {
    $('lnaCheck').disabled = false;
  }
};
$('lnaForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = lightningName($('lnaName').value);
  if (!name.ok || name.value !== lnaChecked) return;
  $('lnaSave').disabled = true;
  try {
    await engine.registerLightningAddress(name.value);
    $('lnaName').value = ''; lnaChecked = null; $('lnaOk').hidden = true;
    await renderLightningAddress();
  } catch (x) {
    err('lnaErr', /taken|unavailable|exists/i.test(x?.message || '') ? 'That name was just taken. Try another.' : 'Could not save the name. Check the connection and try again.');
  }
};
$('lnaCopy').onclick = () => navigator.clipboard?.writeText($('lnaAddress').textContent);
$('lnaShare').onclick = () => navigator.share?.({ text: $('lnaAddress').textContent }).catch(() => {});
$('lnaRemove').onclick = async () => {
  if (!confirm(`Remove ${$('lnaAddress').textContent}? People who saved it can no longer pay you there.`)) return;
  try { await engine.deleteLightningAddress(); } catch { /* re-read below shows what is true */ }
  await renderLightningAddress();
};
$('rcvShare').onclick = () => navigator.share?.({ text: $('rcvInvoice').value }).catch(() => {});

let prepared = null;
$('sendForm').onsubmit = async (e) => {
  e.preventDefault();
  err('sendErr');
  $('sendPrepare').disabled = true;
  try {
    prepared = await engine.prepareSend($('sendTo').value, Number($('sendAmount').value) || undefined);
    $('sendSats').textContent = sats(prepared.amountSats);
    $('sendFee').textContent = sats(prepared.feeSats);
    const earlier = sends().find((x) => x.d === prepared.to);
    err('sendDupWarn', earlier
      ? `You already started a payment to this request (${new Date(earlier.t).toLocaleString()}) and it is not confirmed yet. Check Activity first: sending again may pay twice.`
      : '');
    $('sendUnsure').hidden = true;
    $('sendConfirm').hidden = false;
  } catch (x) {
    err('sendErr', x.message || 'Could not prepare that payment.');
  } finally {
    $('sendPrepare').disabled = false;
  }
};
$('sendCancel').onclick = () => { prepared = null; $('sendConfirm').hidden = true; };
let unsure = null; // a sent payment whose outcome is not known
function sendDone() {
  $('sendTo').value = ''; $('sendAmount').value = '';
  $('sendConfirm').hidden = true; $('sendUnsure').hidden = true;
  $('sendPanel').hidden = true;
  unsure = null;
}
// After a send errors, ask the library what happened instead of guessing:
// an error does not mean nothing was sent (a timeout can follow a payment).
async function settleOutcome(p, error) {
  const known = await engine.payment(p.idempotencyKey);
  if (known?.status === 'completed') { forgetSend(p.idempotencyKey); sendDone(); return; }
  if (known?.status === 'failed') {
    forgetSend(p.idempotencyKey);
    err('sendErr', `The payment failed${error?.message ? ` (${error.message})` : ''}. Nothing was sent.`);
    $('sendConfirm').hidden = true; $('sendUnsure').hidden = true; unsure = null;
    return;
  }
  unsure = p;
  $('sendConfirm').hidden = true;
  $('sendUnsureMsg').textContent = known?.status === 'pending'
    ? 'This payment is in progress and may still complete. Do not pay again; it will show in Activity.'
    : `${error?.message ? `${error.message} ` : ''}The wallet has no record of this payment, so it was most likely not sent. If you are not sure, check Activity in a minute before trying again.`;
  $('sendRetry').hidden = known?.status === 'pending';
  $('sendUnsure').hidden = false;
}
$('sendGo').onclick = async () => {
  if (!prepared) return;
  $('sendGo').disabled = true;
  const p = prepared;
  rememberSend(p);
  try {
    const out = await engine.send(p);
    if (out.status === 'completed' || out.status === 'failed') forgetSend(p.idempotencyKey);
    if (out.status === 'failed') { await settleOutcome(p, null); return; }
    sendDone();
    await refresh();
  } catch (x) {
    await settleOutcome(p, x);
    await refresh();
  } finally {
    prepared = null;
    $('sendGo').disabled = false;
  }
};
$('sendCheck').onclick = async () => { if (unsure) { await settleOutcome(unsure, null); await refresh(); } };
// The same prepared payment, the same idempotency key: the library returns
// the first attempt's payment if there was one, so this cannot pay twice.
$('sendRetry').onclick = async () => {
  if (!unsure) return;
  const p = unsure;
  $('sendRetry').disabled = true;
  let error = null;
  try { await engine.send(p); } catch (x) { error = x; }
  await settleOutcome(p, error);
  $('sendRetry').disabled = false;
  await refresh();
};

// ---- test-network funding (regtest builds only) ------------------------
async function renderDeposits() {
  try {
    const pending = await engine.unclaimedDeposits();
    const total = pending.reduce((t, d) => t + d.amountSats, 0);
    $('fundPending').textContent = pending.length
      ? `${pending.length} deposit(s), ${sats(total)} sats, received but not yet added. The wallet keeps trying.`
      : '';
    $('fundPending').hidden = !pending.length;
  } catch { /* informational only */ }
}
$('fundBtn').onclick = async () => {
  err('fundErr');
  try {
    const address = await engine.bitcoinAddress();
    $('fundAddr').value = address;
    drawQr($('fundQr'), bitcoinUri(address));
    $('fundOut').hidden = false;
    await renderDeposits();
  } catch (x) {
    err('fundErr', x.message || 'Could not get a deposit address.');
  }
};
$('fundCopy').onclick = () => navigator.clipboard?.writeText($('fundAddr').value);

// ---- security --------------------------------------------------------
function revealWords(phrase) {
  renderWords('revealWords', phrase);
  $('revealWords').hidden = false;
  $('revealForm').hidden = true;
  setTimeout(() => { $('revealWords').replaceChildren(); $('revealWords').hidden = true; }, 60_000);
}
$('showPhraseBtn').onclick = async () => {
  $('wipeForm').hidden = true; err('revealErr');
  const v = vaultStore.load();
  if (!isPasskeyVault(v)) { $('revealForm').hidden = false; return; }
  // A passkey wallet keeps no copy: the passkey derives the words again.
  try { revealWords((await signInPasskey(v.cred, { existing: true })).phrase); } catch (x) { err('revealErr', passkeyMessage(passkeyErrorKind(x))); }
};
$('revealForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    revealWords(await openPhrase(vaultStore.load(), $('revealPass').value));
  } catch {
    err('revealErr', 'Wrong passphrase.');
  } finally {
    $('revealPass').value = '';
  }
};
$('exitBackupBtn').onclick = async () => {
  err('exitErr');
  $('exitBackupBtn').disabled = true;
  try {
    const state = await engine.exportExitState();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([state], { type: 'application/json' }));
    a.download = `cpay-wallet-exit-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    err('exitErr', `Could not make the exit backup: ${e?.message || e}`);
  } finally {
    $('exitBackupBtn').disabled = false;
  }
};
$('wipeBtn').onclick = () => { $('wipeForm').hidden = false; $('revealForm').hidden = true; };
$('wipeForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('wipeText').value.trim() !== 'DELETE') return;
  await lock();
  await unlink().catch(() => {});
  await wipeEngineStorage();
  vaultStore.clear();
  store.del(ID_SLOT); store.del(BACKUP_SLOT); store.del(SENDS_SLOT);
  $('wipeText').value = '';
  $('wipeForm').hidden = true;
  await showWelcome();
};

async function lock() {
  clearTimeout(lockTimer);
  if (engine) await engine.disconnect();
  $('revealWords').replaceChildren();
  $('rcvInvoice').value = '';
  $('rcvOut').hidden = true;
  $('rcvQr').hidden = true;
  $('fundAddr').value = '';
  $('fundOut').hidden = true;
  $('receivePanel').hidden = true;
  $('sendPanel').hidden = true;
  $('sendUnsure').hidden = true;
  prepared = null;
  unsure = null;
}
$('lockBtn').onclick = async () => { await lock(); showUnlock(); };
function armLock() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(async () => { await lock(); showUnlock(); }, AUTO_LOCK_MS);
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { if (!$('s-home').hidden) armLock(); }, { passive: true });

// ---- optional CPAY account link ----------------------------------------
async function renderLink() {
  if (!linkAvailable()) { $('linkCard').hidden = true; return; }
  $('linkCard').hidden = false;
  const acct = await linkedAccount();
  $('linkOff').hidden = Boolean(acct);
  $('linkOn').hidden = !acct;
  if (!acct) return;
  $('linkWho').textContent = acct.email;
  err('siteErr');
  try {
    const b = await websiteBalance();
    $('siteBal').textContent = `$${b.available.toFixed(2)} available`;
  } catch (x) {
    $('siteBal').textContent = '—';
    err('siteErr', x.message);
  }
}
$('linkForm').onsubmit = async (e) => {
  e.preventDefault();
  err('linkErr');
  if (!$('linkConsent').checked) { err('linkErr', 'Tick the box to link.'); return; }
  try {
    await link($('linkEmail').value, $('linkPass').value);
    $('linkPass').value = '';
    await renderLink();
  } catch (x) {
    err('linkErr', x.message);
  }
};
$('unlinkBtn').onclick = async () => { await unlink(); await renderLink(); };
$('unlinkAllBtn').onclick = async () => { await unlink({ everywhere: true }); await renderLink(); };

// The passkey choice shows only where this device can use one.
async function showWelcome() {
  err('welcomeErr');
  show('welcome');
  $('passkeyChoice').hidden = (await passkeyAvailability()) !== 'available';
}

// ---- boot ------------------------------------------------------------
window.addEventListener('online', () => { $('offline').hidden = true; });
window.addEventListener('offline', () => { $('offline').hidden = false; });
$('offline').hidden = navigator.onLine !== false;
$('ver').textContent = cfg.version ? `v${cfg.version}` : '';
$('netTag').textContent = cfg.network && cfg.network !== 'mainnet' ? cfg.network : '';
$('testNetNote').hidden = cfg.network !== 'regtest';

if ('serviceWorker' in navigator && cfg.serviceWorker !== false) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const problem = configProblem();
if (problem) {
  $('cfgProblem').textContent = problem;
  show('notconfigured');
} else if (vaultStore.load()) {
  showUnlock();
} else {
  showWelcome();
}
