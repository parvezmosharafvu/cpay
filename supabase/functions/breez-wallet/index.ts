// breez-wallet: the Breez SDK (Spark) wallet as a Supabase Edge Function,
// serving the same API as payment-service (see docs/SUPABASE_BREEZ.md).
//
// OFF by default. It answers 503 until breez_wallet.control.enabled is true
// with owner 'supabase-edge', which the owner sets only after the VM wallet
// is stopped. It is not listed in supabase/config.toml, so merging does not
// deploy it either.
//
// Secrets (Edge): BREEZ_MNEMONIC, BREEZ_API_KEY, BREEZ_NETWORK,
// BREEZ_DB_URL (session-mode / direct connection, port 5432),
// PAYMENT_SERVICE_SECRET, CRON_SECRET, ADMIN_JWT_MODE (default required).
//
// Multi-wallet (20261021030000, docs/MULTI-WALLET.md): BREEZ_MNEMONIC is
// wallet #1 (legacy). Other wallets' seeds live in Supabase Vault and are
// read per wallet with breez_wallet.wallet_seed(id) on this function's own
// DB connection; they are added to the log redactor before use and never
// logged. Each wallet has its own SDK schema, pool and advisory lease.
import pg from "npm:pg@8.18.0";
import { connect, defaultConfig, postgresStorage, SdkBuilder } from "npm:@breeztech/breez-sdk-spark@0.26.0/deno";
import { endPostgresPools, installPostgresGlobals, withPoolScope } from "./pg-globals.ts";
import { createHost, WALLET_IDLE_MS } from "./runtime.ts";
import { createWalletManager } from "./multi.ts";

// Constant-time, and an unset secret never matches. Kept in this file:
// scripts/deploy-breez-wallet.sh deploys only this folder, so the function
// must not import from ../_shared.
function cronSecretMatches(presented: string | null, expected: string): boolean {
  const a = new TextEncoder().encode(presented ?? "");
  const b = new TextEncoder().encode(expected ?? "");
  if (b.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const PREFIX = /^\/(?:functions\/v1\/)?breez-wallet/;

function walletDbUrl(raw: string, schema = "breez_wallet"): string {
  // SDK tables live in their own schema; current_schema() follows search_path.
  const u = new URL(raw);
  u.searchParams.set("options", `-c search_path=${schema}`);
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  return u.toString();
}

// Ledger pool for one wallet: every row it writes names the wallet
// (breez_wallet.acting_wallet_id() reads cpay.wallet_id).
function ledgerDbUrl(raw: string, walletId: string): string {
  const u = new URL(raw);
  u.searchParams.set("options", `-c cpay.wallet_id=${walletId}`);
  return u.toString();
}

// Mutable: Vault seeds are added when loaded, so they are redacted too.
const secretValues: string[] = [];
function secretsRedactor(values: string[]) {
  secretValues.push(...values);
  return (line: string) => secretValues.filter((v) => v && v.length >= 6).sort((a, b) => b.length - a.length)
    .reduce((out, v) => out.split(v).join("[redacted]"), line);
}

const DB_URL = env("BREEZ_DB_URL");
const redactSecrets = secretsRedactor([env("BREEZ_MNEMONIC"), env("BREEZ_API_KEY"), env("PAYMENT_SERVICE_SECRET"), env("CRON_SECRET"), DB_URL]);
const redact = (s: string) => redactSecrets(s).replace(/postgres(?:ql)?:\/\/\S+/g, "[db-url]");
const log = (e: Record<string, unknown>) => console.log(redact(JSON.stringify({ at: new Date().toISOString(), ...e })));

function configError(): string | null {
  const missing = ["BREEZ_MNEMONIC", "BREEZ_NETWORK", "BREEZ_DB_URL", "PAYMENT_SERVICE_SECRET", "CRON_SECRET"].filter((k) => !env(k));
  if (env("BREEZ_NETWORK") === "mainnet" && !env("BREEZ_API_KEY")) missing.push("BREEZ_API_KEY");
  if (env("PAYMENT_SERVICE_SECRET") && env("PAYMENT_SERVICE_SECRET").length < 32) missing.push("PAYMENT_SERVICE_SECRET(>=32)");
  const words = env("BREEZ_MNEMONIC").split(/\s+/).filter(Boolean).length;
  if (env("BREEZ_MNEMONIC") && ![12, 24].includes(words)) missing.push("BREEZ_MNEMONIC(12|24 words)");
  return missing.length ? `not configured: ${missing.join(", ")}` : null; // names only, never values
}

const SCHEMA_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let manager: ReturnType<typeof createWalletManager> | null = null;
function getManager() {
  if (manager) return manager;
  const db = new pg.Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: 10_000 });
  db.on("error", () => {});
  const network = env("BREEZ_NETWORK") as "mainnet" | "regtest";
  manager = createWalletManager({
    db, network, log,
    makeHost: (wallet, role) => {
      if (wallet && !SCHEMA_RE.test(wallet.id)) throw new Error("bad wallet id");
      // null = no registry yet: the exact pre-multi-wallet setup.
      const own = wallet ? new pg.Pool({ connectionString: ledgerDbUrl(DB_URL, wallet.id), max: 2, idleTimeoutMillis: 10_000 }) : db;
      if (own !== db) own.on("error", () => {});
      const vault = wallet && !wallet.legacy;
      const tag = wallet ? `${wallet.id}:${role}` : undefined;
      return createHost({
        db: own,
        lockClient: () => own.connect(),
        wallet: wallet ?? undefined,
        role,
        connectSdk: async () => {
          installPostgresGlobals();
          let mnemonic = env("BREEZ_MNEMONIC");
          if (vault) {
            const { rows } = await own.query("select breez_wallet.wallet_seed($1) as m", [wallet!.id]);
            mnemonic = String(rows[0]?.m ?? "");
            if (!mnemonic) throw new Error("wallet seed unavailable");
            secretValues.push(mnemonic, mnemonic.split(/\s+/).join(" "));
          }
          const config = defaultConfig(network);
          if (env("BREEZ_API_KEY")) config.apiKey = env("BREEZ_API_KEY");
          if (network === "mainnet") (config as unknown as Record<string, unknown>).crossChainConfig = {};
          const seed = { type: "mnemonic" as const, mnemonic: mnemonic.split(/\s+/).join(" ") };
          const schema = vault ? `breez_wallet_w_${wallet!.id.replace(/-/g, "")}` : "breez_wallet";
          const build = () => SdkBuilder.new(config, seed).withStorageBackend(postgresStorage({
            connectionString: walletDbUrl(DB_URL, schema), maxPoolSize: 2, createTimeoutSecs: 10, recycleTimeoutSecs: 60,
            runMigration: true,
          })).build();
          void connect; // connect() is the file-storage path the VM uses; Edge has no disk.
          return tag ? await withPoolScope(tag, build) : await build();
        },
        releaseSdk: () => endPostgresPools(1_000, tag),
        secret: env("PAYMENT_SERVICE_SECRET"),
        adminJwtMode: env("ADMIN_JWT_MODE").toLowerCase() === "optional" ? "optional" : "required",
        supabaseUrl: env("SUPABASE_URL"),
        anonKey: env("SUPABASE_ANON_KEY"),
        log,
        redact,
      });
    },
  });
  return manager;
}

function keepAliveForIdleClose() {
  // Let the lease drain + unlock after the response instead of being frozen.
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  rt?.waitUntil?.(new Promise((r) => setTimeout(r, WALLET_IDLE_MS + 500)).then(() => manager?.idle()));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = (url.pathname.replace(PREFIX, "") || "/") + url.search;
  const bad = configError();
  if (bad) {
    log({ event: "config-error", detail: bad });
    return new Response(JSON.stringify({ error: "wallet not configured" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const h = getManager();
  try {
    if (url.pathname.endsWith("/cron/sync")) {
      const s = env("CRON_SECRET");
      if (req.method !== "POST" || !cronSecretMatches(req.headers.get("x-cron-secret"), s)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return await h.sync();
    }
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > 10_000) return new Response(JSON.stringify({ error: "body too large" }), { status: 413 });
    return await h.serve(req.method, path, req.headers, body);
  } finally {
    keepAliveForIdleClose();
  }
});
