// Direct settlement: the provider-neutral part.
//
// A direct payment is an invoice made by the MERCHANT'S own wallet provider
// for a payer to pay straight to the merchant. CPAY records it for status,
// receipts and reporting only. It is never part of a CPAY balance (it lives
// in direct_payments, which get_balance_for() never reads) and CPAY can
// never spend, refund or move it.
//
// Status rules (docs/NON-CUSTODIAL-ARCHITECTURE.md, "Payment states"):
//   pending -> paid      only with a preimage that hashes to the payment hash
//   pending -> expired   only after expires_at + EXPIRY_GRACE_MS, unpaid
//   expired -> paid      a late payment with proof still counts
//   paid                 final
// "The provider says settled" without proof is never "paid".

import type { Bolt11, Bolt11Network } from "./bolt11.ts";
import {
  type Fetch, fetchPayRequest, LnurlError, parseLightningAddress, requestInvoice, type Verification, verifyPayment,
} from "./lnurl.ts";

export const EXPIRY_GRACE_MS = 10 * 60_000;
export const CHECK_INTERVAL_SECONDS = 3;

export type DirectStatus = "pending" | "paid" | "expired";

export type Next =
  | { kind: "record_proof"; preimage: string }
  | { kind: "expire" }
  | { kind: "none" };

/** What to do with a payment after one provider check. Pure. */
export function nextAction(status: DirectStatus, expiresAtMs: number, v: Verification | null, nowMs: number): Next {
  if (status === "paid") return { kind: "none" };
  if (v?.state === "paid") return { kind: "record_proof", preimage: v.preimage };
  if (status === "pending" && nowMs > expiresAtMs + EXPIRY_GRACE_MS && (v === null || v.state === "not_paid")) {
    return { kind: "expire" };
  }
  return { kind: "none" };
}

/** Public status shape for the payer's invoice page. */
export function publicStatus(status: DirectStatus): "new" | "settled" | "expired" {
  return status === "paid" ? "settled" : status === "expired" ? "expired" : "new";
}

export type DestinationCheck = {
  address: string;
  domain: string;
  callbackHost: string;
  minSendableMsat: bigint;
  maxSendableMsat: bigint;
  description: string;
};

export type CreatedInvoice = { invoice: Bolt11; verifyUrl: string; payRequestDescription: string };

/**
 * The one provider kind built today: a Lightning address (LUD-16) whose
 * server confirms payments with LUD-21. Other kinds (a merchant's own
 * payment server, for example) would implement the same two calls.
 */
export interface SettlementProvider {
  readonly kind: "lightning_address";
  checkDestination(address: string): Promise<DestinationCheck>;
  createInvoice(address: string, amountMsat: bigint): Promise<CreatedInvoice>;
  check(p: { verifyUrl: string; paymentHash: string; invoice: string }): Promise<Verification>;
}

export function lightningAddressProvider(fetchImpl: Fetch, network: Bolt11Network, now: () => number = Date.now): SettlementProvider {
  const parse = (address: string) => {
    const a = parseLightningAddress(address);
    if (!a) throw new LnurlError("bad_address", "Enter a Lightning address like name@wallet-provider.com.");
    return a;
  };
  return {
    kind: "lightning_address",
    async checkDestination(address) {
      const a = parse(address);
      const pay = await fetchPayRequest(a, fetchImpl);
      // A real invoice at the smallest amount the provider takes (whole
      // sats), never paid: it proves the provider makes invoices CPAY can
      // check and that it offers LUD-21 confirmation.
      const testMsat = ((pay.minSendableMsat + 999n) / 1000n) * 1000n;
      if (testMsat > pay.maxSendableMsat) throw new LnurlError("bad_limits", "The wallet provider sent invalid amount limits.");
      const inv = await requestInvoice(pay, testMsat, { network, nowMs: now(), minRemainingMs: 60_000 }, fetchImpl);
      if (!inv.verifyUrl) {
        throw new LnurlError("no_verify", "This wallet provider does not confirm payments (LUD-21), so CPAY could not tell your payers when they have paid.");
      }
      const v = await verifyPayment(inv.verifyUrl, { paymentHash: inv.invoice.paymentHash, invoice: inv.invoice.invoice }, fetchImpl);
      if (v.state !== "not_paid") throw new LnurlError("verify_broken", "This wallet provider's payment confirmation did not work as expected.");
      return {
        address: a.address, domain: a.domain, callbackHost: new URL(pay.callback).hostname,
        minSendableMsat: pay.minSendableMsat, maxSendableMsat: pay.maxSendableMsat, description: pay.description,
      };
    },
    async createInvoice(address, amountMsat) {
      const a = parse(address);
      const pay = await fetchPayRequest(a, fetchImpl);
      const inv = await requestInvoice(pay, amountMsat, { network, nowMs: now() }, fetchImpl);
      if (!inv.verifyUrl) throw new LnurlError("no_verify", "The merchant's wallet can no longer confirm payments.");
      return { invoice: inv.invoice, verifyUrl: inv.verifyUrl, payRequestDescription: pay.description };
    },
    check(p) {
      return verifyPayment(p.verifyUrl, { paymentHash: p.paymentHash, invoice: p.invoice }, fetchImpl);
    },
  };
}

/** Payer- and merchant-safe wording for a provider failure (no provider text). */
export function providerMessage(e: unknown): string {
  if (e instanceof LnurlError) {
    switch (e.code) {
      case "bad_address": case "no_verify": case "verify_broken": case "out_of_range":
        return e.message;
      case "unreachable": case "http_error":
        return "The merchant's wallet provider is not answering. Try again in a moment.";
      default:
        return "The merchant's wallet provider sent something CPAY could not accept, so no payment request was made.";
    }
  }
  return "Something went wrong. Try again in a moment.";
}

/** Wording for the merchant setting up their own address. */
export function merchantMessage(e: unknown): string {
  if (e instanceof LnurlError) {
    if (e.code === "provider_error") return "Your wallet provider refused the request. Check the address with your wallet provider.";
    if (e.code === "unreachable" || e.code === "http_error") return "Your wallet provider did not answer. Check the address, or try again later.";
    return e.message;
  }
  return "Could not check that address. Try again in a moment.";
}
