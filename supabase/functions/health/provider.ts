// The payment provider check: GET <service>/health, asked again once after a
// short wait before it counts as down. The wallet function answers 503 for a
// moment while an instance is recycled (2026-10-28 02:15 UTC: one 503 in a
// day, healthy again within the minute), which alone is not worth an alert.

export type ProviderProbe = { ok: boolean; status: number; body: Record<string, unknown>; attempts: number };

type Fetch = typeof fetch;

export async function probeProvider(
  f: Fetch, url: string, opts: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ProviderProbe> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: ProviderProbe = { ok: false, status: 0, body: {}, attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(opts.retryDelayMs ?? 5000);
    try {
      const res = await f(`${url}/health`, { signal: AbortSignal.timeout(10000) });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      last = { ok: res.ok && body?.ok === true, status: res.status, body: body ?? {}, attempts: attempt };
    } catch (e) {
      last = { ok: false, status: 0, body: { error: String(e) }, attempts: attempt };
    }
    if (last.ok) return last;
  }
  return last;
}

/** Why the provider looked down, in the fields it actually sent (no "undefined"). */
export function providerFailure(p: ProviderProbe): string {
  const fields = ["ok", "enabled", "holder", "db", "sdkConnected", "synced", "shuttingDown", "error"]
    .filter((k) => k in p.body)
    .map((k) => `${k}=${JSON.stringify(p.body[k])}`);
  const what = p.status === 0 ? "payment service unreachable" : `payment service answered ${p.status}`;
  return `${what}${fields.length ? `: ${fields.join(" ")}` : ""} (asked ${p.attempts}×)`;
}
