// Port ownership for the E2E stack (e2e/stack.mjs). The stack binds five
// fixed ports (E2E_PORT, default 54321, .. +4). A port held by anything else
// must be a clear startup error, never a timeout or, worse, a stale process
// answering readiness probes for a service that never started. Nothing here
// kills a process: the stack only ever stops the children it spawned.
import net from 'node:net';

export const stackPorts = (base) => ({ gateway: base, rest: base + 1, invoiceFn: base + 2, withdrawFn: base + 3, directFns: base + 4 });

// Listening on the unspecified address (dual-stack where available) conflicts
// with any listener on that port, IPv4 or IPv6, loopback or wildcard.
export function portFree(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => (e.code === 'EADDRINUSE' || e.code === 'EACCES' ? resolve(false) : reject(e)));
    s.listen({ port, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export async function assertPortsFree(ports) {
  const busy = [];
  for (const [name, port] of Object.entries(ports)) if (!(await portFree(port))) busy.push(`${port} (${name})`);
  if (busy.length) {
    throw new Error(`e2e stack: port(s) already in use: ${busy.join(', ')}. Something else owns them `
      + '(see `ss -ltnp`); stop it yourself - the stack never kills a process it did not start.');
  }
}

// Resolve once `ok(response)` holds for `url`; reject if `child` exits first
// or the deadline passes. `ok` is the identity check: a bare open port is
// not proof the service is ours.
export async function waitReady(child, name, url, { ok = (r) => r.status < 500, ms = 60_000 } = {}) {
  const end = Date.now() + ms;
  const alive = () => child.exitCode === null && child.signalCode === null;
  while (Date.now() < end) {
    if (!alive()) throw new Error(`e2e stack: ${name} exited during startup (code ${child.exitCode}, signal ${child.signalCode})`);
    try {
      const r = await fetch(url, { method: 'OPTIONS' });
      if (ok(r) && alive()) return;
      if (r.status < 500 && !ok(r)) throw new Error(`e2e stack: ${url} is answered by something that is not this run's ${name}`);
    } catch (e) { if (e.message.startsWith('e2e stack:')) throw e; /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`e2e stack: timeout waiting for ${name} at ${url}`);
}
