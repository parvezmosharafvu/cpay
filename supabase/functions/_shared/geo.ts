// Coarse payer location from Cloudflare's request headers (20261020090000).
// Country, region and city only: never GPS, never the IP address. The
// worker proxy (worker/og-preview-worker.js) sets these from request.cf;
// a request straight to Supabase carries Cloudflare's own cf-ipcountry.
export type CoarseGeo = { country: string | null; region: string | null; city: string | null };

function clean(v: string | null, max = 80): string | null {
  if (!v) return null;
  // Strip control characters, collapse whitespace, cap the length.
  // deno-lint-ignore no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}

export function coarseGeo(headers: Headers): CoarseGeo {
  const c = (headers.get("cf-ipcountry") || "").trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
  return { country, region: clean(headers.get("cf-region")), city: clean(headers.get("cf-ipcity")) };
}
