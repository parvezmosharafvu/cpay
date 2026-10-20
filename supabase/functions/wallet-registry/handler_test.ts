import { assert, assertEquals } from "jsr:@std/assert@1";
import { createHandler, freshPasskey } from "./handler.ts";
import { seedFingerprint } from "./fingerprint.ts";

// Public BIP39 test vector only (never a real wallet).
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>) {
  const b = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `Bearer ${b({ alg: "none" })}.${b(claims)}.sig`;
}
const PASSKEY = jwt({ aal: "aal1", amr: [{ method: "passkey", timestamp: NOW / 1000 - 30 }] });
const OLD_PASSKEY = jwt({ aal: "aal1", amr: [{ method: "passkey", timestamp: NOW / 1000 - 3600 }] });
const PASSWORD = jwt({ aal: "aal1", amr: [{ method: "password", timestamp: NOW / 1000 - 30 }] });

function setup(opts: { userId?: string; role?: string; rpcError?: string; allowed?: boolean } = {}) {
  const logs: string[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const h = createHandler({
    ownerUserId: OWNER,
    network: "mainnet",
    now: () => NOW,
    caller: async (req) => ({ userId: opts.userId ?? OWNER, authHeader: req.headers.get("Authorization")!, role: opts.role ?? "admin", status: "active" }),
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "wallet_registry_add_attempt") return { data: opts.allowed ?? true, error: null };
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      if (name === "wallet_registry_add") return { data: { id: "w", label: args.p_label, fingerprint: args.p_fingerprint, status: "active" }, error: null };
      if (name === "wallet_registry_list") return { data: { wallets: [], total_balance_sat: 0 }, error: null };
      return { data: { ok: true }, error: null };
    },
    fingerprint: seedFingerprint,
    log: (e) => logs.push(JSON.stringify(e)),
    corsHeaders: async () => ({}),
  });
  const send = (body: unknown, auth = PASSKEY) =>
    h(new Request("https://x/functions/v1/wallet-registry", { method: "POST", headers: { Authorization: auth }, body: JSON.stringify(body) }));
  return { send, logs, calls };
}

const noSeed = (s: string) => !/abandon|about/.test(s);

Deno.test("fingerprint of the BIP39 test vector", async () => {
  assertEquals(await seedFingerprint(SEED), "73c5da0a");
});

Deno.test("add: stores via RPC, response and logs never carry the seed", async () => {
  const t = setup();
  const res = await t.send({ action: "add", label: "Second", mnemonic: SEED });
  const text = await res.text();
  assertEquals(res.status, 200);
  assert(noSeed(text), text);
  assertEquals(JSON.parse(text).wallet.fingerprint, "73c5da0a");
  assert(t.logs.every(noSeed), t.logs.join("\n"));
  const add = t.calls.find((c) => c.name === "wallet_registry_add")!;
  assertEquals(add.args.p_mnemonic, SEED);
  assertEquals(add.args.p_network, "mainnet");
});

Deno.test("add: invalid seeds are refused without echo", async () => {
  for (const [mnemonic, code] of [
    [SEED.replace(/about$/, "abandon"), "seed_checksum"],
    [SEED.replace(/about$/, "zzzz"), "seed_unknown_word"],
    ["abandon about", "seed_word_count"],
  ]) {
    const t = setup();
    const res = await t.send({ action: "add", label: "X", mnemonic });
    const text = await res.text();
    assertEquals(res.status, 400);
    assertEquals(JSON.parse(text).code, code);
    assert(noSeed(text) && !text.includes("zzzz"), text);
    assert(t.logs.every(noSeed), t.logs.join("\n"));
    assert(!t.calls.some((c) => c.name === "wallet_registry_add"));
  }
});

Deno.test("add: a database error never echoes input", async () => {
  const t = setup({ rpcError: `ERROR: something about ${SEED}` });
  const res = await t.send({ action: "add", label: "X", mnemonic: SEED });
  const text = await res.text();
  assertEquals(JSON.parse(text).code, "failed");
  assert(noSeed(text) && t.logs.every(noSeed));
  const dup = setup({ rpcError: "duplicate_wallet" });
  assertEquals(JSON.parse(await (await dup.send({ action: "add", label: "X", mnemonic: SEED })).text()).code, "duplicate_wallet");
});

Deno.test("add: rate limited", async () => {
  const t = setup({ allowed: false });
  const res = await t.send({ action: "add", label: "X", mnemonic: SEED });
  assertEquals(res.status, 429);
  assert(!t.calls.some((c) => c.name === "wallet_registry_add"));
});

Deno.test("owner only, passkey session, fresh passkey for add/remove", async () => {
  assertEquals((await setup({ userId: "22222222-2222-4222-8222-222222222222" }).send({ action: "list" })).status, 403);
  assertEquals((await setup({ role: "user" }).send({ action: "list" })).status, 403);
  assertEquals((await setup().send({ action: "list" }, PASSWORD)).status, 403);
  assertEquals((await setup().send({ action: "list" })).status, 200);
  const old = await setup().send({ action: "add", label: "X", mnemonic: SEED }, OLD_PASSKEY);
  assertEquals(old.status, 403);
  assert(noSeed(await old.text()));
  assertEquals((await setup().send({ action: "remove", id: OWNER, confirm: "X" }, OLD_PASSKEY)).status, 403);
  assertEquals((await setup().send({ action: "remove", id: OWNER, confirm: "X" })).status, 200);
  assert(freshPasskey(PASSKEY, NOW) && !freshPasskey(PASSWORD, NOW));
  const unset = createHandler({ ownerUserId: "", network: "mainnet", caller: async () => ({ userId: OWNER, authHeader: PASSKEY, role: "admin", status: "active" }), rpc: async () => ({ data: null, error: null }), fingerprint: seedFingerprint, log: () => {}, corsHeaders: async () => ({}) });
  assertEquals((await unset(new Request("https://x", { method: "POST", headers: { Authorization: PASSKEY }, body: "{}" }))).status, 403);
});

Deno.test("remove: refusal codes pass through by name", async () => {
  const t = setup({ rpcError: "balance_not_zero" });
  const res = await t.send({ action: "remove", id: OWNER, confirm: "X" });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "balance_not_zero");
});
