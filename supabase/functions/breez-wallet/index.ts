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
import pg from "npm:pg@8.18.0";
import { connect, defaultConfig, postgresStorage, SdkBuilder } from "npm:@breeztech/breez-sdk-spark@0.26.0/deno";
import { installPostgresGlobals } from "./pg-globals.ts";
import { createHost, WALLET_IDLE_MS } from "./runtime.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const PREFIX = /^\/(?:functions\/v1\/)?breez-wallet/;

function walletDbUrl(raw: string): string {
  // SDK tables live in their own schema; current_schema() follows search_path.
  const u = new URL(raw);
  u.searchParams.set("options", "-c search_path=breez_wallet");
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
  return u.toString();
}

function secretsRedactor(values: string[]) {
  const s = values.filter((v) => v && v.length >= 6).sort((a, b) => b.length - a.length);
  return (line: string) => s.reduce((out, v) => out.split(v).join("[redacted]"), line);
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

let host: ReturnType<typeof createHost> | null = null;
function getHost() {
  if (host) return host;
  const db = new pg.Pool({ connectionString: DB_URL, max: 3 });
  db.on("error", () => {});
  host = createHost({
    db,
    lockClient: () => db.connect(),
    connectSdk: async () => {
      installPostgresGlobals();
      const network = env("BREEZ_NETWORK") as "mainnet" | "regtest";
      const config = defaultConfig(network);
      if (env("BREEZ_API_KEY")) config.apiKey = env("BREEZ_API_KEY");
      if (network === "mainnet") (config as unknown as Record<string, unknown>).crossChainConfig = {};
      const seed = { type: "mnemonic" as const, mnemonic: env("BREEZ_MNEMONIC").split(/\s+/).join(" ") };
      const builder = SdkBuilder.new(config, seed).withStorageBackend(postgresStorage({
        connectionString: walletDbUrl(DB_URL), maxPoolSize: 3, createTimeoutSecs: 10, recycleTimeoutSecs: 60,
        runMigration: true,
      }));
      void connect; // connect() is the file-storage path the VM uses; Edge has no disk.
      return await builder.build();
    },
    secret: env("PAYMENT_SERVICE_SECRET"),
    adminJwtMode: env("ADMIN_JWT_MODE").toLowerCase() === "optional" ? "optional" : "required",
    supabaseUrl: env("SUPABASE_URL"),
    anonKey: env("SUPABASE_ANON_KEY"),
    log,
    redact,
  });
  return host;
}

function keepAliveForIdleClose() {
  // Let the lease drain + unlock after the response instead of being frozen.
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  rt?.waitUntil?.(new Promise((r) => setTimeout(r, WALLET_IDLE_MS + 500)).then(() => host?.idle()));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = (url.pathname.replace(PREFIX, "") || "/") + url.search;
  const bad = configError();
  if (bad) {
    log({ event: "config-error", detail: bad });
    return new Response(JSON.stringify({ error: "wallet not configured" }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const h = getHost();
  try {
    if (url.pathname.endsWith("/cron/sync")) {
      const s = env("CRON_SECRET");
      if (req.method !== "POST" || req.headers.get("x-cron-secret") !== s) {
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
