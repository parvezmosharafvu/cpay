// BOLT11 (Lightning invoice) decoder for direct settlement.
//
// CPAY does not create or hold the invoices this reads: a merchant's own
// wallet provider makes them (docs/NON-CUSTODIAL-ARCHITECTURE.md). Before an
// invoice is shown to a payer, CPAY checks that it asks for exactly the
// amount requested, commits to the expected description hash, is for the
// expected network and has not expired, and keeps its payment hash so a
// later preimage can prove the payment (sha256(preimage) == payment hash).
//
// The signature is NOT verified here (no secp256k1 in the Edge runtime
// without a new dependency). CPAY makes no decision from the payee key: the
// checks above, made over TLS to the merchant's own provider, are what the
// invoice is accepted on.
//
// Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const SIGNATURE_WORDS = 104; // 65 bytes
const TIMESTAMP_WORDS = 7;
// Long enough for any invoice a wallet shows as a QR code; refuses garbage.
const MAX_LENGTH = 7089;

export type Bolt11Network = "bitcoin" | "testnet" | "signet" | "regtest";

export type Bolt11 = {
  network: Bolt11Network;
  /** null for an amountless invoice. */
  amountMsat: bigint | null;
  /** Seconds since the epoch. */
  timestamp: number;
  expirySeconds: number;
  /** Milliseconds since the epoch. */
  expiresAtMs: number;
  paymentHash: string;
  paymentSecret: string | null;
  description: string | null;
  descriptionHash: string | null;
  payeePubkey: string | null;
  /** The normalised (lower-case, no lightning: prefix) invoice. */
  invoice: string;
};

export class Bolt11Error extends Error {}

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** bech32 (not bech32m) without the 90-character limit BOLT11 lifts. */
export function bech32Decode(text: string): { hrp: string; words: number[] } {
  if (text.length > MAX_LENGTH) throw new Bolt11Error("invoice too long");
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) throw new Bolt11Error("mixed case");
  const s = text.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Bolt11Error("no separator");
  const hrp = s.slice(0, pos);
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    if (c < 33 || c > 126) throw new Bolt11Error("bad prefix character");
  }
  const words: number[] = [];
  for (const ch of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Bolt11Error("bad character");
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Bolt11Error("bad checksum");
  return { hrp, words: words.slice(0, -6) };
}

/** Used by tests and the local E2E provider to build invoices. */
export function bech32Encode(hrp: string, words: number[]): string {
  const values = [...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...checksum].map((w) => CHARSET[w]).join("");
}

/** 5-bit words to bytes, dropping the zero padding at the end. */
export function wordsToBytes(words: number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

export function bytesToWords(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const wordsToInt = (words: number[]) => words.reduce((n, w) => n * 32 + w, 0);

const PREFIXES: Array<[string, Bolt11Network]> = [
  // Longest first: "bcrt" before "bc", "tbs" before "tb".
  ["bcrt", "regtest"], ["tbs", "signet"], ["bc", "bitcoin"], ["tb", "testnet"],
];

// BOLT11 multipliers, as millisatoshi per unit of the amount digits.
// 1 BTC = 100 000 000 000 msat; "p" (pico-BTC) is a tenth of a msat.
function amountToMsat(digits: string, multiplier: string): bigint {
  if (!/^[1-9][0-9]*$/.test(digits)) throw new Bolt11Error("bad amount");
  const n = BigInt(digits);
  switch (multiplier) {
    case "": return n * 100_000_000_000n;
    case "m": return n * 100_000_000n;
    case "u": return n * 100_000n;
    case "n": return n * 100n;
    case "p":
      if (n % 10n !== 0n) throw new Bolt11Error("sub-millisatoshi amount");
      return n / 10n;
    default: throw new Bolt11Error("bad multiplier");
  }
}

export function decodeBolt11(input: string): Bolt11 {
  const raw = String(input ?? "").trim().replace(/^lightning:/i, "");
  const { hrp, words } = bech32Decode(raw);
  const invoice = raw.toLowerCase();
  if (!hrp.startsWith("ln")) throw new Bolt11Error("not a Lightning invoice");
  const rest = hrp.slice(2);
  const prefix = PREFIXES.find(([p]) => rest.startsWith(p));
  if (!prefix) throw new Bolt11Error("unknown network");
  const amountPart = rest.slice(prefix[0].length);
  let amountMsat: bigint | null = null;
  if (amountPart !== "") {
    const m = /^([0-9]+)([munp]?)$/.exec(amountPart);
    if (!m) throw new Bolt11Error("bad amount");
    amountMsat = amountToMsat(m[1], m[2]);
  }
  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) throw new Bolt11Error("too short");
  const timestamp = wordsToInt(words.slice(0, TIMESTAMP_WORDS));
  const tagged = words.slice(TIMESTAMP_WORDS, words.length - SIGNATURE_WORDS);

  let paymentHash: string | null = null;
  let paymentSecret: string | null = null;
  let description: string | null = null;
  let descriptionHash: string | null = null;
  let payeePubkey: string | null = null;
  let expirySeconds = 3600;
  let i = 0;
  while (i < tagged.length) {
    if (i + 3 > tagged.length) throw new Bolt11Error("truncated field");
    const type = tagged[i];
    const len = tagged[i + 1] * 32 + tagged[i + 2];
    const data = tagged.slice(i + 3, i + 3 + len);
    if (data.length !== len) throw new Bolt11Error("truncated field");
    i += 3 + len;
    // Fields with an unexpected length are skipped, as the spec requires;
    // the first valid one of each kind wins.
    switch (type) {
      case 1: // p: payment hash
        if (len === 52 && paymentHash === null) paymentHash = hex(wordsToBytes(data));
        break;
      case 16: // s: payment secret
        if (len === 52 && paymentSecret === null) paymentSecret = hex(wordsToBytes(data));
        break;
      case 13: // d: description
        if (description === null) {
          try {
            description = new TextDecoder("utf-8", { fatal: true }).decode(wordsToBytes(data));
          } catch {
            throw new Bolt11Error("description is not UTF-8");
          }
        }
        break;
      case 23: // h: description hash
        if (len === 52 && descriptionHash === null) descriptionHash = hex(wordsToBytes(data));
        break;
      case 19: // n: payee public key
        if (len === 53 && payeePubkey === null) payeePubkey = hex(wordsToBytes(data));
        break;
      case 6: // x: expiry
        if (len > 0 && len <= 7) expirySeconds = wordsToInt(data);
        break;
    }
  }
  if (!paymentHash) throw new Bolt11Error("no payment hash");
  const network = prefix[1];
  return {
    network, amountMsat, timestamp, expirySeconds,
    expiresAtMs: (timestamp + expirySeconds) * 1000,
    paymentHash, paymentSecret, description, descriptionHash, payeePubkey, invoice,
  };
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))));
}

export function hexToBytes(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Bolt11Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Proof of payment: the preimage hashes to the invoice's payment hash. */
export async function preimageMatches(preimageHex: string, paymentHash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(preimageHex) || !/^[0-9a-f]{64}$/i.test(paymentHash)) return false;
  return (await sha256HexBytes(hexToBytes(preimageHex.toLowerCase()))) === paymentHash.toLowerCase();
}
