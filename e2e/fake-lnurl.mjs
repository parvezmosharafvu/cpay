// A fake merchant wallet provider for the E2E stack (direct settlement,
// 20261018010000): Lightning address (LUD-16), invoices (LUD-06) and payment
// confirmation (LUD-21), the way the wallet library's own Lightning-address
// server answers. Local only: the Edge Functions reach it through
// E2E_LNURL_GATEWAY, which is honoured only when SUPABASE_URL is loopback.
//
// Hosts (the request's x-e2e-host header):
//   pay.example.com        confirms payments (offers "verify")
//   noverify.example.com   makes invoices but cannot confirm them
// Invoices are regtest BOLT11 with a dummy signature (CPAY does not check it).
import { createHash, randomBytes } from 'node:crypto';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function bech32(hrp, words) {
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...sum].map((w) => CHARSET[w]).join('')}`;
}
function toWords(bytes) {
  const out = []; let acc = 0; let bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); } acc &= (1 << bits) - 1; }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}
const intWords = (n, len) => Array.from({ length: len }, (_, i) => Math.floor(n / 32 ** (len - 1 - i)) % 32);
const field = (type, data) => [type, Math.floor(data.length / 32), data.length % 32, ...data];
const sha256 = (b) => createHash('sha256').update(b).digest();

export function bolt11({ amountMsat, paymentHash, descriptionHash, expirySeconds = 3600 }) {
  const words = intWords(Math.floor(Date.now() / 1000), 7);
  words.push(...field(1, toWords(Buffer.from(paymentHash, 'hex'))));
  words.push(...field(23, toWords(Buffer.from(descriptionHash, 'hex'))));
  words.push(...field(6, intWords(expirySeconds, 4)));
  words.push(...new Array(104).fill(0));
  return bech32(`lnbcrt${BigInt(amountMsat) / 100n}n`, words);
}

export function createFakeLnurl() {
  const invoices = new Map(); // payment hash -> { preimage, pr, settled, forged }
  const metadata = (user, host) => JSON.stringify([['text/plain', `Pay ${user}`], ['text/identifier', `${user}@${host}`]]);
  return {
    invoices,
    /** Mark an issued invoice paid (forge: claim it with a wrong preimage). */
    pay(paymentHash, { forge = false } = {}) {
      const inv = invoices.get(paymentHash);
      if (!inv) return false;
      inv.settled = true;
      inv.forged = forge;
      return true;
    },
    handle(host, url) {
      const path = url.pathname;
      let m = /^\/\.well-known\/lnurlp\/([a-z0-9._+-]+)$/.exec(path);
      if (m) {
        return { tag: 'payRequest', callback: `https://${host}/lnurlp/${m[1]}/invoice`, minSendable: 1000, maxSendable: 100_000_000_000, metadata: metadata(m[1], host), commentAllowed: 0 };
      }
      m = /^\/lnurlp\/([a-z0-9._+-]+)\/invoice$/.exec(path);
      if (m) {
        const amount = url.searchParams.get('amount');
        if (!/^\d+$/.test(amount || '') || Number(amount) % 1000 !== 0) return { status: 'ERROR', reason: 'amount must be a whole sat amount' };
        const preimage = randomBytes(32);
        const paymentHash = sha256(preimage).toString('hex');
        const pr = bolt11({ amountMsat: amount, paymentHash, descriptionHash: sha256(metadata(m[1], host)).toString('hex') });
        invoices.set(paymentHash, { preimage: preimage.toString('hex'), pr, settled: false, forged: false });
        return host === 'noverify.example.com' ? { pr, routes: [] } : { pr, routes: [], verify: `https://${host}/verify/${paymentHash}` };
      }
      m = /^\/verify\/([0-9a-f]{64})$/.exec(path);
      if (m) {
        const inv = invoices.get(m[1]);
        if (!inv) return { status: 'ERROR', reason: 'Not found' };
        return { status: 'OK', settled: inv.settled, preimage: inv.settled ? (inv.forged ? 'ee'.repeat(32) : inv.preimage) : null, pr: inv.pr };
      }
      return null;
    },
  };
}
