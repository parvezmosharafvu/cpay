// The Deno build of @breeztech/breez-sdk-spark calls JS globals for its
// PostgreSQL storage (createPostgresPool, createPostgres*WithPool). The
// package only installs them from its Node entry, which would also load a
// second copy of the WASM, so install just the four pg-backed stores here.
//
// They are vendored as ES modules (scripts/vendor-breez-pg-stores.py) and
// imported statically: the Supabase Edge bundler only ships modules in the
// static import graph, so the earlier require.resolve() of the package's
// nodejs/ directory failed in production with "Cannot find module".

import * as storage from "./vendor/postgres-storage/index.mjs";
import * as tree from "./vendor/postgres-tree-store/index.mjs";
import * as token from "./vendor/postgres-token-store/index.mjs";
import * as session from "./vendor/postgres-session-store/index.mjs";

let installed = false;

// The SDK makes one pg.Pool per build (createPostgresPool) and shares it with
// all four stores; disconnect() does not end it, so its idle session-mode
// connections stayed open for recycleTimeoutSecs (60 s) after every handoff.
// Seven quick handoffs then held ~14 of the session pooler's 15 clients and
// the next opens failed with EMAXCONNSESSION (lease_log 115-122, 03:20 Dhaka
// 2026-10-13). Track the pools so the host can end them when it lets go.
type EndablePool = { end(): Promise<void> };
const pools = new Set<EndablePool>();

export function trackPools<C>(create: (config: C) => EndablePool) {
  return (config: C) => {
    const pool = create(config);
    pools.add(pool);
    return pool;
  };
}

// Ends every SDK pool made since the last call. Idle connections close at
// once; capMs bounds the wait for a client the SDK never released, so a
// stuck pool can never keep the advisory lock held.
export async function endPostgresPools(capMs = 1_000): Promise<number> {
  const all = [...pools];
  pools.clear();
  if (!all.length) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(all.map((p) => Promise.resolve().then(() => p.end()))),
    new Promise((r) => { timer = setTimeout(r, capMs); }),
  ]);
  clearTimeout(timer);
  return all.length;
}

export function installPostgresGlobals(): void {
  if (installed) return;
  Object.assign(globalThis as Record<string, unknown>, {
    createPostgresPool: trackPools(storage.createPostgresPool as (c: unknown) => EndablePool),
    createPostgresStorage: storage.createPostgresStorage,
    createPostgresStorageWithPool: storage.createPostgresStorageWithPool,
    createPostgresTreeStore: tree.createPostgresTreeStore,
    createPostgresTreeStoreWithPool: tree.createPostgresTreeStoreWithPool,
    createPostgresTokenStore: token.createPostgresTokenStore,
    createPostgresTokenStoreWithPool: token.createPostgresTokenStoreWithPool,
    createPostgresSessionStore: session.createPostgresSessionStore,
    createPostgresSessionStoreWithPool: session.createPostgresSessionStoreWithPool,
  });
  installed = true;
}
