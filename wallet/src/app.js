// CPAY Wallet: screens and flow. Everything user-supplied is shown with
// textContent, never as HTML.
//
// Lifecycle of the recovery phrase:
//   create  -> generated here (bip39.js), shown once for the paper backup,
//              checked against the paper, sealed with the passphrase
//              (vault.js), handed to the engine, then dropped from memory
//   unlock  -> opened from the vault, handed to the engine, dropped
//   reveal  -> opened from the vault on request, shown, hidden again
// It is never sent anywhere: not to CPAY, not in a URL, not in a log.
import { generateMnemonic, normalizeMnemonic, validateMnemonic } from './bip39.js';
import { MIN_PASSPHRASE, openPhrase, sealPhrase, vaultStore } from './vault.js';
import { configProblem, createEngine, wipeEngineStorage } from './engine.js';
import { link, linkAvailable, linkedAccount, unlink, websiteBalance } from './link.js';
import { bitcoinUri, drawQr, lightningUri } from './qr.js';

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
let lockTimer = null;

function renderWords(listId, phrase) {
  const ol = $(listId);
  ol.replaceChildren(...phrase.split(' ').map((w) => { const li = document.createElement('li'); li.textContent = w; return li; }));
}

// ---- create ----------------------------------------------------------
$('createBtn').onclick = async () => {
  pending = await generateMnemonic(12);
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
  show('setpass');
};

// ---- restore ---------------------------------------------------------
function startRestore() { $('restoreWords').value = ''; err('restoreErr'); show('restore'); }
$('restoreStartBtn').onclick = startRestore;
$('restoreCancel').onclick = () => show(vaultStore.load() ? 'unlock' : 'welcome');
$('forgotLink').onclick = (e) => { e.preventDefault(); startRestore(); };
$('restoreForm').onsubmit = async (e) => {
  e.preventDefault();
  const phrase = normalizeMnemonic($('restoreWords').value);
  if (!(await validateMnemonic(phrase))) { err('restoreErr', 'That is not a valid 12- or 24-word recovery phrase. Check each word and the order.'); return; }
  $('restoreWords').value = '';
  pending = phrase;
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
    if (vaultStore.load()) await wipeEngineStorage(); // restoring over an old wallet
    vaultStore.save(await sealPhrase(pending, p1));
    await start(pending);
  } catch (x) {
    err('passErr', x.message || 'Could not create the wallet.');
  } finally {
    pending = null;
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
  await refresh();
  await renderLink();
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
      li.textContent = `${sign}${sats(p.amountSats)} sats · ${p.status}${p.type === 'send' && p.feesSats ? ` · fee ${sats(p.feesSats)}` : ''} · ${when}`;
      return li;
    }));
    $('historyEmpty').hidden = list.length > 0;
  } catch { /* keep the last numbers on a failed refresh */ }
}

$('receiveBtn').onclick = () => { $('receivePanel').hidden = !$('receivePanel').hidden; $('sendPanel').hidden = true; };
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
    $('sendConfirm').hidden = false;
  } catch (x) {
    err('sendErr', x.message || 'Could not prepare that payment.');
  } finally {
    $('sendPrepare').disabled = false;
  }
};
$('sendCancel').onclick = () => { prepared = null; $('sendConfirm').hidden = true; };
$('sendGo').onclick = async () => {
  if (!prepared) return;
  $('sendGo').disabled = true;
  try {
    await engine.send(prepared);
    $('sendTo').value = ''; $('sendAmount').value = '';
    $('sendConfirm').hidden = true;
    $('sendPanel').hidden = true;
    await refresh();
  } catch (x) {
    err('sendErr', x.message || 'The payment failed. Nothing was sent.');
    $('sendConfirm').hidden = true;
  } finally {
    prepared = null;
    $('sendGo').disabled = false;
  }
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
$('showPhraseBtn').onclick = () => { $('revealForm').hidden = false; $('wipeForm').hidden = true; err('revealErr'); };
$('revealForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const phrase = await openPhrase(vaultStore.load(), $('revealPass').value);
    renderWords('revealWords', phrase);
    $('revealWords').hidden = false;
    $('revealForm').hidden = true;
    setTimeout(() => { $('revealWords').replaceChildren(); $('revealWords').hidden = true; }, 60_000);
  } catch {
    err('revealErr', 'Wrong passphrase.');
  } finally {
    $('revealPass').value = '';
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
  $('wipeText').value = '';
  $('wipeForm').hidden = true;
  show('welcome');
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
  prepared = null;
}
$('lockBtn').onclick = async () => { await lock(); show('unlock'); };
function armLock() {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(async () => { await lock(); show('unlock'); }, AUTO_LOCK_MS);
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
} else {
  show(vaultStore.load() ? 'unlock' : 'welcome');
}
