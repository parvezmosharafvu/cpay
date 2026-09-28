// A stand-in for the Breez SDK with the calls withdraw.mjs and app.mjs
// make, for tests. Not loaded by the service.

import { randomUUID } from 'node:crypto';

export const RATE = 100_000; // USD per BTC, so $1 = 1000 sats

export const TRON = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
export const EVM = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063';
export const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955';
export const LEAF_ERROR = 'Wallet: Tree service error: generic error: Failed to select leaves after all retries';

export function pair(chain, asset, { provider = 'orchestra', minUsdCents = 100, maxUsdCents = 1_000_000, bitcoin = true, decimals = 6, contractAddress } = {}) {
  return {
    provider, chain, asset, decimals, contractAddress, exactOutEligible: true, deliveryMethods: ['spark'],
    acceptedAssets: [{ asset: bitcoin ? { type: 'bitcoin' } : { type: 'token', tokenIdentifier: 'btkn1usdb' }, limits: { minUsdCents, maxUsdCents } }],
  };
}

// A stand-in for the Breez SDK with the calls withdraw.mjs makes. `mode`
// picks how sendPayment behaves; the first `leafFailures` sends throw the
// stale-reservation leaf error instead.
export function fakeBreez({ mode = 'ok', feeBase = 520_000n, leafFailures = 0, quoteTtlMs = 60_000 } = {}) {
  const payments = new Map();
  const calls = { routes: 0, send: 0, prepare: 0, sync: 0 };
  const byFamily = {
    tron: [pair('tron', 'USDT')],
    // BSC USDT (BEP-20) has 18 decimals.
    evm: [pair('bsc', 'USDT', { decimals: 18, contractAddress: BSC_USDT }), pair('arbitrum', 'USDC'), pair('base', 'USDB', { bitcoin: false })],
    solana: [pair('solana', 'USDC')],
  };
  let release;
  const fake = {
    payments, calls, mode, leafFailures,
    releaseHang: () => release?.(),
    async getCrossChainRoutes({ addressDetails }) { calls.routes++; return byFamily[addressDetails.addressFamily] ?? []; },
    async parse(input) {
      if (/^0x[0-9a-fA-F]{40}$/.test(input)) return { type: 'crossChainAddress', address: input, addressFamily: 'evm' };
      if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(input)) return { type: 'crossChainAddress', address: input, addressFamily: 'tron' };
      throw new Error('unrecognized input');
    },
    async getInfo() { return { balanceSats: 50_000_000 }; },
    async syncWallet() { calls.sync++; return {}; },
    async prepareSendPayment({ paymentRequest, amount, feePolicy }) {
      calls.prepare++;
      // At RATE, 1 sat = $0.001 = 1000 base units of a 6-decimal stablecoin.
      const scale = 10n ** BigInt(paymentRequest.route.decimals - 6);
      const assetIn = amount * 1000n * scale;
      const fee = feeBase * scale;
      return {
        amount, feePolicy,
        paymentMethod: {
          type: 'crossChainAddress', route: paymentRequest.route, recipientAddress: paymentRequest.address,
          amountIn: String(amount), assetAmountIn: String(assetIn), estimatedOut: String(assetIn - fee), feeAmount: String(fee),
          serviceFeeAmount: '0', sourceTransferFeeSats: 0, feeMode: 'feesIncluded',
          expiresAt: new Date(Date.now() + quoteTtlMs).toISOString(),
          providerContext: { type: 'orchestra', quoteId: randomUUID(), depositAddress: 'sprt1deposit' },
        },
      };
    },
    async sendPayment({ prepareResponse, idempotencyKey }) {
      calls.send++;
      const store = (status = 'completed', conv = 'pending') => {
        const p = { id: idempotencyKey, paymentType: 'send', status, amount: prepareResponse.amount, conversionDetails: { status: conv } };
        if (!payments.has(idempotencyKey)) payments.set(idempotencyKey, p);
        return payments.get(idempotencyKey);
      };
      if (payments.has(idempotencyKey)) return { payment: payments.get(idempotencyKey) };
      if (fake.leafFailures > 0) { fake.leafFailures--; throw new Error(LEAF_ERROR); }
      if (fake.mode === 'ok') return { payment: store() };
      // The transfer went out, but the SDK still answered with the leaf error.
      if (fake.mode === 'leaf-after-transfer') { store(); throw new Error(LEAF_ERROR); }
      if (fake.mode === 'insufficient') throw new Error('Insufficient funds');
      if (fake.mode === 'network-after-transfer') { store(); throw new Error('Network error: connection reset'); }
      if (fake.mode === 'network-no-transfer') throw new Error('Network error: connection reset');
      if (fake.mode === 'spark-failed') return { payment: store('failed', undefined) };
      if (fake.mode === 'hang') return new Promise((resolve) => { release = () => resolve({ payment: store() }); });
      throw new Error(`unknown mode ${fake.mode}`);
    },
    async getPayment({ paymentId }) {
      if (!payments.has(paymentId)) throw new Error('Invalid input: Not found');
      return { payment: payments.get(paymentId) };
    },
    // Moves the cross-chain leg along, as Orchestra would.
    deliver(id, status, deliveredBase, decimals = 6) {
      const p = payments.get(id);
      p.conversionDetails = {
        status,
        conversions: deliveredBase == null ? [] : [{
          provider: 'orchestra', status,
          from: { chain: { type: 'spark' }, asset: { ticker: 'BTC', decimals: 8 }, amount: String(p.amount), fee: '0' },
          to: { chain: { type: 'external', name: 'tron' }, asset: { ticker: 'USDT', decimals }, amount: String(deliveredBase), fee: '0' },
        }],
      };
      return p;
    },
  };
  return fake;
}

