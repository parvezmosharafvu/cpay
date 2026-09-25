// Admin-only switch for sign-up email confirmation. See handler.ts.
//
// Secrets (Dashboard > Edge Functions > Secrets):
//   CPAY_SUPABASE_ACCESS_TOKEN  Supabase personal access token. Account-wide
//                               and powerful: it must only ever live here.
//                               Hosted Supabase refuses secret names that
//                               start with SUPABASE_, hence the CPAY_ prefix;
//                               SUPABASE_ACCESS_TOKEN is still read when set
//                               (e.g. `supabase functions serve` locally).
//   CPAY_PROJECT_REF            Optional. Worked out from SUPABASE_URL when
//                               that is https://<ref>.supabase.co.
import { createHandler, projectRefFromUrl } from "./handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const tokenFromCpay = Deno.env.get("CPAY_SUPABASE_ACCESS_TOKEN") ?? "";

Deno.serve(createHandler({
    supabaseUrl: SUPABASE_URL,
    anonKey: Deno.env.get("SUPABASE_ANON_KEY")!,
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    accessToken: tokenFromCpay || (Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? ""),
    projectRef: (Deno.env.get("CPAY_PROJECT_REF") ?? "").trim() || projectRefFromUrl(SUPABASE_URL),
    // Fixed on purpose: the token is only ever sent to Supabase itself.
    managementApiUrl: "https://api.supabase.com",
    staticOrigins: (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    tokenSecretName: "CPAY_SUPABASE_ACCESS_TOKEN",
}));
