// Port ownership for the E2E stack (e2e/ports.mjs): an occupied port is a
// clear error that names it and leaves the owner running, a stale process on
// a function's port is never taken for this run's function, and a child that
// dies during startup fails fast instead of timing out.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { stackPorts, portFree, assertPortsFree, waitReady } from '../../e2e/ports.mjs';

const listen = (server, port = 0, host) => new Promise((r) => server.listen(port, host, () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));
const freePort = async () => { const s = net.createServer(); const p = await listen(s); await close(s); return p; };
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);

test('stack ports are E2E_PORT .. +3 in the order stack.mjs binds them', () => {
  assert.deepEqual(stackPorts(54321), { gateway: 54321, rest: 54322, invoiceFn: 54323, withdrawFn: 54324 });
});

test('free ports pass the preflight', async () => {
  const ports = { a: await freePort(), b: await freePort() };
  await assertPortsFree(ports);
  for (const p of Object.values(ports)) assert.equal(await portFree(p), true, 'preflight must release what it probed');
});

for (const host of ['127.0.0.1', '0.0.0.0']) {
  test(`a port held on ${host} fails the preflight, names the port, and the owner keeps running`, async () => {
    const owner = net.createServer();
    const busy = await listen(owner, 0, host);
    const free = await freePort();
    await assert.rejects(assertPortsFree({ gateway: free, withdrawFn: busy }), (e) => {
      assert.match(e.message, new RegExp(`${busy} \\(withdrawFn\\)`));
      assert.doesNotMatch(e.message, new RegExp(`${free} `));
      return true;
    });
    assert.equal(owner.listening, true, 'the stack must never stop a process it did not start');
    await close(owner);
    assert.equal(await portFree(busy), true);
  });
}

test('a stale process answering on the port is not mistaken for this run\'s function', async () => {
  const stale = http.createServer((_q, s) => s.end('old run'));
  const port = await listen(stale, 0, '127.0.0.1');
  const child = sleeper();
  try {
    await assert.rejects(
      waitReady(child, 'user-withdraw', `http://127.0.0.1:${port}/`, { ok: (r) => r.headers.get('x-e2e-run') === 'this-run', ms: 5_000 }),
      /answered by something that is not this run's user-withdraw/,
    );
  } finally { child.kill(); await close(stale); }
});

test('a stale process from an earlier run (other run id) is rejected too', async () => {
  const stale = http.createServer((_q, s) => { s.setHeader('x-e2e-run', 'earlier-run'); s.end(); });
  const port = await listen(stale, 0, '127.0.0.1');
  const child = sleeper();
  try {
    await assert.rejects(
      waitReady(child, 'create-invoice', `http://127.0.0.1:${port}/`, { ok: (r) => r.headers.get('x-e2e-run') === 'this-run', ms: 5_000 }),
      /not this run's create-invoice/,
    );
  } finally { child.kill(); await close(stale); }
});

test('a child that dies during startup (e.g. AddrInUse) fails fast, not after the timeout', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(3)']);
  const t = Date.now();
  await assert.rejects(waitReady(child, 'user-withdraw', `http://127.0.0.1:${await freePort()}/`, { ms: 30_000 }), /user-withdraw exited during startup \(code 3/);
  assert.ok(Date.now() - t < 5_000, 'must not wait for the 30s deadline');
});

test('this run\'s live service is ready; the port is released once it stops', async () => {
  const svc = http.createServer((_q, s) => { s.setHeader('x-e2e-run', 'this-run'); s.end(); });
  const port = await listen(svc, 0, '127.0.0.1');
  const child = sleeper();
  try {
    await waitReady(child, 'create-invoice', `http://127.0.0.1:${port}/`, { ok: (r) => r.headers.get('x-e2e-run') === 'this-run', ms: 5_000 });
  } finally { child.kill(); await close(svc); }
  assert.equal(await portFree(port), true);
});

test('nothing listening times out with the service name', async () => {
  const child = sleeper();
  try {
    await assert.rejects(waitReady(child, 'postgrest', `http://127.0.0.1:${await freePort()}/`, { ms: 600 }), /timeout waiting for postgrest/);
  } finally { child.kill(); }
});
