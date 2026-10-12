// The Deno build of @breeztech/breez-sdk-spark calls JS globals for its
// PostgreSQL storage (createPostgresPool, createPostgres*WithPool). The
// package only installs them from its Node entry, which would also load a
// second copy of the WASM, so load just the four pg-backed stores here.
import { createRequire } from "node:module";
// Pull the package into the npm graph so require.resolve can find it.
import "npm:@breeztech/breez-sdk-spark@0.26.0/deno";
import "npm:pg@8.18.0";

const require = createRequire(import.meta.url);
let installed = false;

export function installPostgresGlobals(): void {
  if (installed) return;
  const entry = require.resolve("@breeztech/breez-sdk-spark/nodejs");
  const dir = entry.replace(/index\.js$/, "");
  const g = globalThis as Record<string, unknown>;
  const storage = require(dir + "postgres-storage/index.cjs");
  const tree = require(dir + "postgres-tree-store/index.cjs");
  const token = require(dir + "postgres-token-store/index.cjs");
  const session = require(dir + "postgres-session-store/index.cjs");
  Object.assign(g, {
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
