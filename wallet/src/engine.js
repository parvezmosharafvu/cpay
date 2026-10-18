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

export function assertRegtest() {
  if (cfg().network !== 'regtest') throw new Error('Test-bitcoin deposits are only available on the test network.');
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
      // Real-time sync shares wallet records with the library's sync
      // service. Off unless the build turned it on (WALLET_SYNC=on).
      if (!c.sync) config.realTimeSyncServerUrl = undefined;
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
    // On-chain deposit address, REGTEST ONLY: the documented way to fund a
    // test wallet from the regtest faucet. The library claims a confirmed
    // deposit into the wallet by itself (within its default claim-fee cap).
    // Not offered on mainnet: a deposit whose claim fee exceeds the cap
    // would wait unclaimed, and this version has no screen to handle that.
    async bitcoinAddress() {
      assertRegtest();
      return (await sdk.receivePayment({ paymentMethod: { type: 'bitcoinAddress' } })).paymentRequest;
    },
    async unclaimedDeposits() {
      const { deposits } = await sdk.listUnclaimedDeposits({});
      return (deposits || []).map((d) => ({ txid: d.txid, vout: d.vout, amountSats: Number(d.amountSats) }));
    },
    // Same two-step send the CPAY server wallet uses: parse, prepare (shows
    // the fee), then send only after the user confirms. The idempotency key
    // is chosen here, once per prepared payment: the library returns the
    // existing payment for a key it has seen, so sending the same prepared
    // payment again (after a timeout, say) can never pay twice.
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
      return { amountSats: sats, feeSats, kind: parsed.type, handle: prepared, idempotencyKey: globalThis.crypto.randomUUID(), to: text };
    },
    async send(prepared) {
      const { payment } = await sdk.sendPayment({ prepareResponse: prepared.handle, idempotencyKey: prepared.idempotencyKey });
      return { id: payment.id, status: payment.status };
    },
    // One payment by id (a send's id is its idempotency key), or null when
    // the library has no such payment.
    async payment(id) {
      try {
        const { payment: p } = await sdk.getPayment({ paymentId: id });
        return p ? { id: p.id, status: p.status, type: p.paymentType, amountSats: Number(p.amount), feesSats: Number(p.fees) } : null;
      } catch {
        return null;
      }
    },
    async payments() {
      const { payments } = await sdk.listPayments({ offset: 0, limit: 50, sortAscending: false });
      return payments.map((p) => ({
        id: p.id, type: p.paymentType, status: p.status,
        amountSats: Number(p.amount), feesSats: Number(p.fees), timestamp: Number(p.timestamp),
      }));
    },
    // Exit backup: the pre-signed Bitcoin transactions that let this wallet
    // leave Spark on its own if the Spark operators stop working. It holds
    // no keys and cannot move money by itself, but it does reveal the
    // wallet's balance, so it is treated as private.
    async exportExitState() {
      return (await sdk.exportUnilateralExitState()).exitState;
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
