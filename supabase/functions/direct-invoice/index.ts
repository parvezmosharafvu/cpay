// direct-invoice Edge Function: wiring only. The logic and its rules are in
// handler.ts (tested by handler_test.ts); the provider rules in
// ../_shared/direct-settlement.ts and ../_shared/lnurl.ts.
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (set by Supabase)
//   TURNSTILE_SECRET_KEY, TURNSTILE_MODE      (optional, as create-invoice)
//   DIRECT_RECONCILE_SECRET                   (optional; the reconcile sweep refuses without it)
//   DIRECT_SETTLEMENT_NETWORK                 (optional; bitcoin by default)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { toCents } from "../_shared/money.ts";
import { checkTurnstile, turnstileMode } from "../create-invoice/guards.ts";
import { currentRate, type Rate } from "../_shared/btc-rate.ts";
import { lightningAddressProvider } from "../_shared/direct-settlement.ts";
import { denoResolver, e2eGatewayFetch, guardedFetch } from "../_shared/lnurl.ts";
import type { Bolt11Network } from "../_shared/bolt11.ts";
import { createHandler, type Db, type DirectRow, type PublicRow } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TURNSTILE_SECRET = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";
const TURNSTILE_MODE = turnstileMode(TURNSTILE_SECRET, Deno.env.get("TURNSTILE_MODE"));
const NETWORKS: Bolt11Network[] = ["bitcoin", "testnet", "signet", "regtest"];
const rawNetwork = (Deno.env.get("DIRECT_SETTLEMENT_NETWORK") ?? "bitcoin").trim() as Bolt11Network;
const NETWORK: Bolt11Network = NETWORKS.includes(rawNetwork) ? rawNetwork : "bitcoin";

// The local E2E stack only: a fake merchant provider and a fixed price.
// Never active on the hosted project, whose SUPABASE_URL is not loopback.
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL);
const E2E_GATEWAY = LOCAL ? Deno.env.get("E2E_LNURL_GATEWAY") ?? "" : "";
const E2E_PRICE = LOCAL ? Number(Deno.env.get("E2E_FIXED_BTC_USD") ?? "") : NaN;

const net = E2E_GATEWAY ? e2eGatewayFetch(E2E_GATEWAY) : guardedFetch(fetch, denoResolver());
const rate = (): Promise<Rate> => Number.isFinite(E2E_PRICE) && E2E_PRICE > 0
  ? Promise.resolve({ usdPerBtc: E2E_PRICE, usdPerBtcCents: BigInt(Math.round(E2E_PRICE * 100)), sources: ["e2e-fixed"] })
  : currentRate(fetch);

const fail = (what: string, error: { message?: string } | null) => {
  console.error(`${what} failed:`, error?.message ?? error);
  return undefined;
};
const first = <T>(data: unknown): T | null => (Array.isArray(data) ? (data[0] as T) ?? null : (data as T) ?? null);
const ROW = "id, status, amount_usd, buyer_amount, expires_at, bolt11, payment_hash, verify_url, destination_address";

const db: Db = {
  async paymentsStopped() {
    const { data, error } = await sb.from("app_settings").select("value").eq("key", "emergency_payments_stop").maybeSingle();
    if (error) return fail("emergency stop read", error);
    return data?.value === true || String(data?.value) === "true";
  },
  async directEnabled() {
    const { data, error } = await sb.rpc("direct_settlement_enabled");
    if (error) return fail("direct switch read", error);
    return data === true;
  },
  async claimPublic(bucket, keyHash, limit, windowSeconds) {
    const { data, error } = await sb.rpc("claim_public_rate_limit", { p_bucket: bucket, p_key_hash: keyHash, p_limit: limit, p_window_seconds: windowSeconds });
    if (error) return fail(`rate limit ${bucket}`, error);
    return data === true;
  },
  async linkForSlug(slug) {
    const { data, error } = await sb.rpc("system_link_for_invoice", { p_slug: slug });
    if (error) return fail("link lookup", error);
    const link = first<{ link_id: string; user_id: string; is_active: boolean; cost_percent: number | null }>(data);
    if (!link) return null;
    const { data: mode, error: modeErr } = await sb.from("payment_links").select("settlement_mode").eq("id", link.link_id).maybeSingle();
    if (modeErr) return fail("link mode lookup", modeErr);
    return { ...link, settlement_mode: String(mode?.settlement_mode ?? "custodial") };
  },
  async profileMaxCents(userId) {
    const { data, error } = await sb.from("profile_limits").select("max_invoice_amount").eq("user_id", userId).maybeSingle();
    if (error) return fail("profile limit read", error);
    return toCents(data?.max_invoice_amount ?? 5000, "floor") ?? 500000;
  },
  async claimOwnerRate(userId) {
    const { data, error } = await sb.rpc("claim_invoice_rate_limit", { p_user_id: userId, p_limit: 30, p_window_seconds: 60 });
    if (error) return fail("owner rate limit", error);
    return data === true;
  },
  async releaseOwnerRate(userId) {
    const { error } = await sb.rpc("release_invoice_rate_limit", { p_user_id: userId });
    if (error) fail("owner rate release", error);
  },
  async destinationFor(userId) {
    const { data, error } = await sb.rpc("system_direct_destination_for", { p_user_id: userId });
    if (error) return fail("destination lookup", error);
    return first<{ id: string; address: string }>(data);
  },
  async findByRequest(linkId, requestId) {
    const { data, error } = await sb.from("direct_payments").select(ROW).eq("payment_link_id", linkId).eq("client_request_id", requestId).maybeSingle();
    if (error) return fail("idempotency lookup", error);
    return (data as DirectRow | null) ?? null;
  },
  async insert(row) {
    const { data, error } = await sb.from("direct_payments").insert(row).select("id").single();
    if (error?.code === "23505" && /link_request/.test(error.message ?? "")) return "request_conflict";
    if (error || !data) return fail("direct payment insert", error);
    return { id: String(data.id) };
  },
  async publicRow(id) {
    const { data, error } = await sb.rpc("system_direct_payment_public", { p_id: id });
    if (error) return fail("direct payment read", error);
    return first<PublicRow>(data);
  },
  async claimCheck(id, intervalSeconds) {
    const { data, error } = await sb.rpc("system_claim_direct_check", { p_id: id, p_min_interval_seconds: intervalSeconds });
    if (error) return fail("check claim", error);
    return first<DirectRow>(data);
  },
  async claimChecks(limit, intervalSeconds) {
    const { data, error } = await sb.rpc("system_claim_direct_checks", { p_limit: limit, p_min_interval_seconds: intervalSeconds });
    if (error) return fail("check sweep claim", error);
    return (data ?? []) as DirectRow[];
  },
  async recordProof(id, preimage) {
    const { data, error } = await sb.rpc("system_record_direct_payment_proof", { p_id: id, p_preimage: preimage });
    if (error) return fail("proof record", error);
    return typeof data === "string" ? data : undefined;
  },
  async expire(id, graceSeconds) {
    const { data, error } = await sb.rpc("system_expire_direct_payment", { p_id: id, p_grace_seconds: graceSeconds });
    if (error) return fail("expire", error);
    return typeof data === "string" ? data : undefined;
  },
};

Deno.serve(createHandler({
  db,
  provider: lightningAddressProvider(net, NETWORK),
  rate,
  turnstile: (token, ip) => checkTurnstile(TURNSTILE_MODE, TURNSTILE_SECRET, token, ip),
  reconcileSecret: Deno.env.get("DIRECT_RECONCILE_SECRET") ?? "",
}));
