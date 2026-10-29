// Admin-only invitations. An emailed invite is NOT an active account;
// handle_new_user() creates a pending application for human review.
// The service-role key never reaches the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { createAdminVerifier } from "../admin-actions/admin-auth.ts";
import { checkPasskeyStepUp, stepUpWindow } from "../_shared/step-up.ts";
import { cachedHosts, corsFor } from "../_shared/cors.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const verify = createAdminVerifier({ supabaseUrl: url, anonKey: anon, supabaseAdmin: admin });
const hosts = cachedHosts(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").filter(Boolean),
  async () => {
    const { data, error } = await admin.from("site_domains").select("hostname").eq("is_active", true);
    if (error) throw error;
    return (data || []).map((x: {hostname: string}) => x.hostname);
  },
);
function json(value: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...cors } });
}
Deno.serve(async (req) => {
  const cors = await corsFor(req, hosts);
  cors["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({error:"Method not allowed"},405,cors);
  const auth = await verify(req);
  if (!auth.ok) return json({error:"Active admin access required"},403,cors);
  // Inviting another identity is privileged; always demand recent passkey
  // sign-in even when the global admin MFA toggle is not enabled.
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i,"") || null;
  const { data: u, error: ue } = await auth.callerClient!.auth.getUser();
  if (ue || !u.user) return json({error:"Unauthorized"},401,cors);
  if (!checkPasskeyStepUp(bearer,u.user,stepUpWindow(Deno.env.get("STEP_UP_MAX_AGE_SECONDS"))).ok)
    return json({error:"Sign in again with your passkey to invite a member",code:"reauth_required"},403,cors);
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({error:"Invalid JSON"},400,cors); }
  const email = String(payload.email ?? "").trim().toLowerCase();
  const displayName = String(payload.displayName ?? "").trim();
  const phone = String(payload.phone ?? "").trim();
  const type = payload.accountType === "business" ? "business" : "individual";
  const business = type === "business" ? String(payload.businessName ?? "").trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254 ||
      !displayName || displayName.length>80 ||
      (phone && !/^\+[1-9][0-9]{6,14}$/.test(phone)) ||
      (type==="business" && (business.length<2 || business.length>120)))
    return json({error:"Invalid invitation details"},400,cors);
  // Do not accept user-provided roles, passwords, status or confirmations.
  const {data,error}=await admin.auth.admin.inviteUserByEmail(email, {
    data: {display_name:displayName, account_type:type, business_name:business || undefined,
      phone:phone || undefined, requested_role:"freelancer"}
  });
  if(error) {
    console.error("admin invitation failed",error.code || "auth_error");
    return json({error:"Invitation could not be sent. The address may already be registered or email delivery is unavailable."},409,cors);
  }
  const { error: auditError } = await admin.from("audit_log").insert({
    actor_id:auth.userId, action:"account.invited",subject_type:"profile",subject_id:String(data.user?.id || ""),
    new_value:{invitation:true,manual_approval_required:true},
  });
  if(auditError) console.error("invitation audit failed",auditError.code || "database_error");
  return json({ok:true,message:"Invitation sent. The new account needs admin approval before it can use CPAY."},200,cors);
});
