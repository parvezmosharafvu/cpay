// CORS for browser calls from the CPAY site to signed-in Edge Functions:
// an Origin is allowed when its host is an active row of site_domains (the
// registry the admin panel manages) or in the ALLOWED_ORIGINS secret. The
// same rules as user-withdraw, which keeps its own copy.

export type HostList = () => Promise<Set<string>>;

/** A host normalised one way everywhere: lower case, no scheme, no slash. */
export function normalizeOriginHost(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * `fetchActive` lists active site_domains hostnames. A failed lookup falls
 * back to the last good list (or the static one): failing closed here would
 * lock every browser out.
 */
export function cachedHosts(staticOrigins: string[], fetchActive: () => Promise<string[]>, ttlMs = 5 * 60_000): HostList {
  let cache: { hosts: Set<string>; at: number } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.hosts;
    const hosts = new Set(staticOrigins.map(normalizeOriginHost));
    try {
      for (const h of await fetchActive()) hosts.add(h.toLowerCase());
    } catch (e) {
      console.error("site_domains lookup failed, using cached/static origins:", e);
      return cache?.hosts ?? new Set(staticOrigins.map(normalizeOriginHost));
    }
    cache = { hosts, at: Date.now() };
    return hosts;
  };
}

export async function corsFor(req: Request, hosts: HostList): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const origin = req.headers.get("Origin");
  if (!origin) return h;
  let host = "";
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return h;
  }
  if ((await hosts()).has(host)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
