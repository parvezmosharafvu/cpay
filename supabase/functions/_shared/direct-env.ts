// Settings both direct-settlement functions read the same way, so they can
// never disagree on the network or on the local test hooks.
import type { Bolt11Network } from "./bolt11.ts";
import { denoResolver, e2eGatewayFetch, type Fetch, guardedFetch } from "./lnurl.ts";

const NETWORKS: Bolt11Network[] = ["bitcoin", "testnet", "signet", "regtest"];

/** DIRECT_SETTLEMENT_NETWORK, bitcoin unless set to another known network. */
export function directNetwork(raw: string | undefined): Bolt11Network {
  const v = String(raw ?? "bitcoin").trim() as Bolt11Network;
  return NETWORKS.includes(v) ? v : "bitcoin";
}

/** The local E2E stack: a loopback SUPABASE_URL. Never the hosted project. */
export function isLocalStack(supabaseUrl: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(supabaseUrl);
}

/**
 * How to reach merchant wallet providers: the guarded fetch, or on the local
 * stack only, the fake provider named by E2E_LNURL_GATEWAY.
 */
export function merchantFetch(supabaseUrl: string, e2eGateway: string | undefined): Fetch {
  const gateway = isLocalStack(supabaseUrl) ? e2eGateway ?? "" : "";
  return gateway ? e2eGatewayFetch(gateway) : guardedFetch(fetch, denoResolver());
}
