// settlement-destination Edge Function: wiring only (logic in handler.ts).
// verify_jwt stays on (supabase/config.toml): only signed-in members.
//
// Secrets / env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (set by Supabase), ALLOWED_ORIGINS (optional, as user-withdraw),
// STEP_UP_MAX_AGE_SECONDS (optional, as user-withdraw),
// DIRECT_SETTLEMENT_NETWORK (optional; bitcoin by default),
// DIRECT_PROVIDER_HOSTS (optional; only these provider hosts).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { cachedHosts, corsFor } from "../_shared/cors.ts";
import { checkStepUp, stepUpWindow } from "../_shared/step-up.ts";
import { lightningAddressProvider } from "../_shared/direct-settlement.ts";
import { directNetwork, merchantFetch } from "../_shared/direct-env.ts";
import { sha256Hex } from "../create-invoice/guards.ts";
import { createHandler } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const sb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const STEP_UP_SECONDS = stepUpWindow(Deno.env.get("STEP_UP_MAX_AGE_SECONDS"));
const NETWORK = directNetwork(Deno.env.get("DIRECT_SETTLEMENT_NETWORK"));
// The local E2E stack only (see _shared/direct-env.ts).
const net = merchantFetch(SUPABASE_URL, Deno.env.get("E2E_LNURL_GATEWAY"), Deno.env.get("DIRECT_PROVIDER_HOSTS"));

const hosts = cachedHosts(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  async () => {
    const { data, error } = await sb.from("site_domains").select("hostname").eq("is_active", true);
    if (error) throw error;
    return (data ?? []).map((d) => String(d.hostname ?? "")).filter(Boolean);
  },
);

Deno.serve(createHandler({
  async getUser(authHeader) {
    const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await caller.auth.getUser();
    return error || !user ? null : { id: user.id, factors: (user as { factors?: Array<{ status?: string }> }).factors ?? null };
  },
  stepUp: (token, user) => checkStepUp(token, user, STEP_UP_SECONDS),
  provider: lightningAddressProvider(net, NETWORK),
  cors: (req) => corsFor(req, hosts),
  db: {
    async claimLimit(userId) {
      const { data, error } = await sb.rpc("claim_public_rate_limit", {
        p_bucket: "destination_check", p_key_hash: await sha256Hex(`user:${userId}`), p_limit: 10, p_window_seconds: 600,
      });
      if (error) {
        console.error("destination check limit failed:", error.message);
        return undefined;
      }
      return data === true;
    },
    async save(userId, d) {
      const { data, error } = await sb.rpc("system_set_settlement_destination", {
        p_user_id: userId, p_address: d.address, p_callback_host: d.callbackHost,
        p_min_msat: d.minSendableMsat.toString(), p_max_msat: d.maxSendableMsat.toString(),
      });
      if (error) return { error: error.message };
      const row = Array.isArray(data) ? data[0] : data;
      return { address: String(row.address), ready_at: String(row.ready_at), unchanged: row.unchanged === true };
    },
    async remove(userId) {
      const { data, error } = await sb.rpc("system_remove_settlement_destinations", { p_user_id: userId });
      return error ? { error: error.message } : Number(data ?? 0);
    },
  },
}));
