// wallet-registry: Admin → Wallet → Wallets (owner only).
//
//   POST { action: "list" }                         -> { wallets, total_balance_sat, audit }
//   POST { action: "add", label, mnemonic }          -> { wallet: { id, label, fingerprint, status } }
//   POST { action: "rename", id, label }
//   POST { action: "set_primary", id }
//   POST { action: "set_status", id, status }        active | standby | disabled
//   POST { action: "remove", id, confirm }           confirm = the wallet's label, typed
//
// Every call: signed in, the owner (CPAY_OWNER_USER_ID), an active admin,
// and a passkey session. add and remove also need a passkey sign-in in the
// last 10 minutes. CPAY_OWNER_USER_ID unset = refused for everyone.
//
// The seed: checked here (12 BIP39 words + checksum), turned into a BIP32
// fingerprint, and passed once to public.wallet_registry_add(), which keeps
// it in Supabase Vault. It is never logged, never in a response or an error,
// and the request body is dropped as soon as it is read. Adds are limited
// to 5 attempts per hour (failures count).
import { claimsAreStrong, decodeJwtPayload } from "../_shared/step-up.ts";
import { checkMnemonic12 } from "../_shared/bip39.ts";

export const PASSKEY_FRESH_SECONDS = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Database errors we pass on by name; anything else becomes "failed".
const KNOWN = new Set([
  "duplicate_wallet", "bad_label", "bad_network", "bad_mnemonic", "bad_fingerprint", "vault_store_failed",
  "wallet_not_found", "wallet_not_active", "bad_status", "primary_must_stay_active", "confirmation_mismatch",
  "legacy_wallet_not_removable", "primary_not_removable", "balance_unknown", "balance_not_zero",
  "open_invoices", "forwards_pending", "withdrawals_pending",
]);

export interface RegistryCaller { userId: string; authHeader: string; role: string | null; status: string | null }
export interface RegistryDeps {
  caller(req: Request): Promise<RegistryCaller | null>;
  ownerUserId: string;
  network: "mainnet" | "regtest";
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
  fingerprint(mnemonic: string): Promise<string>;
  log(e: Record<string, unknown>): void;
  corsHeaders(req: Request): Promise<Record<string, string>>;
  now?: () => number;
}

export function freshPasskey(authHeader: string, nowMs: number, maxAgeSec = PASSKEY_FRESH_SECONDS): boolean {
  const c = decodeJwtPayload(String(authHeader ?? "").replace(/^Bearer\s+/i, ""));
  const amr = Array.isArray(c?.amr) ? c!.amr as Array<{ method?: unknown; timestamp?: unknown }> : [];
  return amr.some((e) => e?.method === "passkey" && typeof e.timestamp === "number" && nowMs / 1000 - e.timestamp <= maxAgeSec);
}

function codeOf(error: { message?: string } | null): string {
  const m = String(error?.message ?? "").trim();
  return KNOWN.has(m) ? m : "failed";
}

export function createHandler(d: RegistryDeps): (req: Request) => Promise<Response> {
  const owner = d.ownerUserId.trim().toLowerCase();
  const now = d.now ?? (() => Date.now());
  return async (req) => {
    const cors = await d.corsHeaders(req);
    const json = (b: unknown, s: number) => new Response(JSON.stringify(b), {
      status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!req.headers.get("Authorization")) return json({ error: "Unauthorized" }, 401);
    let c: RegistryCaller | null = null;
    try { c = await d.caller(req); } catch { c = null; }
    if (!c) return json({ error: "Unauthorized" }, 401);
    const isOwner = owner !== "" && c.userId.toLowerCase() === owner && c.role === "admin" && c.status === "active";
    if (!isOwner) return json({ error: "Owner only", code: "owner_only" }, 403);
    if (!claimsAreStrong(decodeJwtPayload(c.authHeader.replace(/^Bearer\s+/i, "")))) {
      return json({ error: "Sign in again with your passkey.", code: "aal2_required" }, 403);
    }
    const raw = await req.text().catch(() => "");
    if (raw.length > 4096) return json({ error: "Request too large", code: "too_large" }, 413);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "Bad request", code: "bad_request" }, 400); }
    const action = String(body.action ?? "");
    const id = String(body.id ?? "");
    const needId = () => UUID_RE.test(id);
    const actor = c.userId;
    const call = async (name: string, args: Record<string, unknown>, event: string) => {
      const { data, error } = await d.rpc(name, args);
      const code = error ? codeOf(error) : null;
      d.log({ event, ok: !error, code, wallet: UUID_RE.test(id) ? id : null }); // never the body
      return error ? json({ error: code, code }, code === "failed" ? 500 : 409) : json({ ok: true, result: data }, 200);
    };

    try {
      switch (action) {
        case "list": {
          const [l, a] = await Promise.all([d.rpc("wallet_registry_list", {}), d.rpc("wallet_registry_audit", { p_limit: 30 })]);
          if (l.error) return json({ error: "failed", code: "failed" }, 500);
          return json({ ...(l.data as Record<string, unknown>), audit: a.error ? [] : a.data, network: d.network }, 200);
        }
        case "add": {
          // Take the seed out of the body at once; nothing below echoes it.
          const mnemonic = String(body.mnemonic ?? "");
          delete body.mnemonic;
          const label = String(body.label ?? "").trim();
          if (!freshPasskey(c.authHeader, now())) return json({ error: "Confirm with your passkey again.", code: "passkey_required" }, 403);
          const allowed = await d.rpc("wallet_registry_add_attempt", { p_actor: actor });
          if (allowed.error || allowed.data !== true) {
            d.log({ event: "wallet-add", ok: false, code: "rate_limited" });
            return json({ error: "Too many attempts. Try again in an hour.", code: "rate_limited" }, 429);
          }
          if (label.length < 1 || label.length > 60) return json({ error: "bad_label", code: "bad_label" }, 400);
          const check = await checkMnemonic12(mnemonic);
          if (!check.ok) {
            d.log({ event: "wallet-add", ok: false, code: `seed_${check.code}` });
            return json({ error: "That is not a valid 12-word seed.", code: `seed_${check.code}` }, 400);
          }
          let fp = "";
          try { fp = await d.fingerprint(check.normalized); } catch { fp = ""; }
          if (!/^[0-9a-f]{8}$/.test(fp)) return json({ error: "failed", code: "failed" }, 500);
          const { data, error } = await d.rpc("wallet_registry_add", {
            p_actor: actor, p_label: label, p_network: d.network, p_mnemonic: check.normalized, p_fingerprint: fp,
          });
          const code = error ? codeOf(error) : null;
          d.log({ event: "wallet-add", ok: !error, code, fingerprint: fp });
          if (error) return json({ error: code, code }, code === "failed" ? 500 : 409);
          return json({ ok: true, wallet: data }, 200);
        }
        case "rename":
          if (!needId()) return json({ error: "bad_request", code: "bad_request" }, 400);
          return await call("wallet_registry_rename", { p_actor: actor, p_wallet: id, p_label: String(body.label ?? "") }, "wallet-rename");
        case "set_primary":
          if (!needId()) return json({ error: "bad_request", code: "bad_request" }, 400);
          return await call("wallet_registry_set_primary", { p_actor: actor, p_wallet: id }, "wallet-set-primary");
        case "set_status":
          if (!needId()) return json({ error: "bad_request", code: "bad_request" }, 400);
          return await call("wallet_registry_set_status", { p_actor: actor, p_wallet: id, p_status: String(body.status ?? "") }, "wallet-set-status");
        case "remove":
          if (!needId()) return json({ error: "bad_request", code: "bad_request" }, 400);
          if (!freshPasskey(c.authHeader, now())) return json({ error: "Confirm with your passkey again.", code: "passkey_required" }, 403);
          return await call("wallet_registry_remove", { p_actor: actor, p_wallet: id, p_confirm: String(body.confirm ?? "") }, "wallet-remove");
        default:
          return json({ error: "bad_request", code: "bad_request" }, 400);
      }
    } catch {
      // No exception text: it could carry request data.
      d.log({ event: "wallet-registry-error", action: /^[a-z_]{1,20}$/.test(action) ? action : null });
      return json({ error: "failed", code: "failed" }, 500);
    }
  };
}
