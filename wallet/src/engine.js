// Wallet engine: the same Lightning/Spark SDK the CPAY website's own wallet
// runs on (pinned 0.26.0), but its browser build, on this device, with this
// device's recovery phrase. See wallet/SECURITY.md for the custody model.
//
// The phrase goes from the vault straight into the SDK's connect() call,
// which derives the keys in WebAssembly inside this page. It is never put
// in a request, a URL, a log line or storage other than the encrypted
// vault. The SDK keeps its own wallet state in this origin's IndexedDB.
//
// Test builds (WALLET_TEST=1) may set engine: 'fake' to load
// fake-engine.js instead; production builds do not ship that file.

const cfg = () => globalThis.CPAY_WALLET_CONFIG || {};

export function configProblem() {
  const c = cfg();
  if (c.engine === 'fake') return null;
  if (!['mainnet', 'regtest'].includes(c.network)) return 'network is not set';
  if (c.network === 'mainnet' && !c.apiKey) return 'the wallet API key is not set';
  return null;
}

const storageDir = () => `cpay-wallet-${cfg().network || 'fake'}`;

export async function createEngine() {
  if (cfg().engine === 'fake') {
    const { createFakeEngine } = await import('./fake-engine.js');
    return createFakeEngine();
  }
  const sdkMod = await import('./vendor/sdk/index.js');
  await sdkMod.default(); // load the WebAssembly module and IndexedDB storage
  let sdk = null;
  let listenerId = null;

  return {
    kind: 'sdk',
    async connect(mnemonic, onEvent) {
      const c = cfg();
      const config = sdkMod.defaultConfig(c.network);
      if (c.apiKey) config.apiKey = c.apiKey;
      sdk = await sdkMod.connect({ config, seed: { type: 'mnemonic', mnemonic }, storageDir: storageDir() });
      if (onEvent) listenerId = await sdk.addEventListener({ onEvent: (e) => onEvent(e?.type || 'event') });
    },
    async info() {
      const { balanceSats } = await sdk.getInfo({ ensureSynced: false });
      return { balanceSats: Number(balanceSats) };
    },
    async receive({ amountSats, description }) {
      const res = await sdk.receivePayment({
        paymentMethod: { type: 'bolt11Invoice', description: description || 'CPAY Wallet', amountSats: amountSats || undefined, expirySecs: 3600 },
      });
      return { request: res.paymentRequest, feeSats: Number(res.fee ?? 0n) };
    },
    async sparkAddress() {
      return (await sdk.receivePayment({ paymentMethod: { type: 'sparkAddress' } })).paymentRequest;
    },
    // Same two-step send the CPAY server wallet uses: parse, prepare (shows
    // the fee), then send only after the user confirms.
    async prepareSend(input, amountSats) {
      const text = String(input || '').trim();
      const parsed = await sdk.parse(text);
      let fixed = null;
      if (parsed?.type === 'bolt11Invoice') {
        fixed = parsed.amountMsat != null ? Math.ceil(Number(parsed.amountMsat) / 1000) : null;
      } else if (parsed?.type !== 'sparkAddress') {
        throw new Error('Paste a Lightning invoice or a Spark address.');
      }
      const sats = fixed ?? Number(amountSats);
      if (!Number.isInteger(sats) || sats <= 0) throw new Error('Enter an amount in sats.');
      const prepared = await sdk.prepareSendPayment({
        paymentRequest: { type: 'input', input: text },
        amount: fixed ? undefined : BigInt(sats),
      });
      const m = prepared.paymentMethod || {};
      const feeSats = m.type === 'bolt11Invoice' ? Number(m.lightningFeeSats ?? 0) + Number(m.sparkTransferFeeSats ?? 0) : Number(m.fee ?? 0);
      return { amountSats: sats, feeSats, kind: parsed.type, handle: prepared };
    },
    async send(prepared) {
      const { payment } = await sdk.sendPayment({ prepareResponse: prepared.handle, idempotencyKey: globalThis.crypto.randomUUID() });
      return { id: payment.id, status: payment.status };
    },
    async payments() {
      const { payments } = await sdk.listPayments({ offset: 0, limit: 50, sortAscending: false });
      return payments.map((p) => ({
        id: p.id, type: p.paymentType, status: p.status,
        amountSats: Number(p.amount), feesSats: Number(p.fees), timestamp: Number(p.timestamp),
      }));
    },
    async disconnect() {
      if (!sdk) return;
      try { if (listenerId) await sdk.removeEventListener(listenerId); } catch { /* ignore */ }
      try { await sdk.disconnect(); } catch { /* ignore */ }
      try { sdk.free(); } catch { /* ignore */ }
      sdk = null;
    },
  };
}

// Remove the SDK's local databases (wallet state, not the funds: the funds
// come back by restoring the recovery phrase).
export async function wipeEngineStorage() {
  const prefix = storageDir();
  if (!globalThis.indexedDB?.databases) return;
  const dbs = await indexedDB.databases();
  await Promise.all(dbs.filter((d) => d.name && d.name.startsWith(prefix)).map((d) => new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(d.name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  })));
}
