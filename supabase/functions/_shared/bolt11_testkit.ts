// Test helper: builds BOLT11 strings with chosen fields and a dummy
// signature (decodeBolt11 does not check it). Tests only; no function
// imports this.
import { bech32Encode, bytesToWords, hexToBytes, sha256HexBytes } from "./bolt11.ts";

export type TestInvoice = {
  network?: "bc" | "bcrt" | "tb";
  amountMsat?: bigint | null;
  paymentHash: string;
  descriptionHash?: string | null;
  timestamp?: number;
  expirySeconds?: number;
};

function intWords(n: number, len: number): number[] {
  const out: number[] = [];
  for (let i = len - 1; i >= 0; i--) out.push(Math.floor(n / 32 ** i) % 32);
  return out;
}

const field = (type: number, data: number[]) => [type, Math.floor(data.length / 32), data.length % 32, ...data];

export function buildInvoice(t: TestInvoice): string {
  const words = intWords(t.timestamp ?? Math.floor(Date.now() / 1000), 7);
  words.push(...field(1, bytesToWords(hexToBytes(t.paymentHash))));
  if (t.descriptionHash) words.push(...field(23, bytesToWords(hexToBytes(t.descriptionHash))));
  words.push(...field(6, intWords(t.expirySeconds ?? 3600, 4)));
  words.push(...new Array(104).fill(0));
  const amount = t.amountMsat == null ? "" : `${t.amountMsat / 100n}n`;
  return bech32Encode(`ln${t.network ?? "bc"}${amount}`, words);
}

export async function randomPreimage(): Promise<{ preimage: string; paymentHash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const preimage = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { preimage, paymentHash: await sha256HexBytes(hexToBytes(preimage)) };
}
