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

export function installPostgresGlobals(): void {
  if (installed) return;
  Object.assign(globalThis as Record<string, unknown>, {
    createPostgresPool: storage.createPostgresPool,
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
