// settlement-destination: a signed-in Freelancer checks, saves or removes the
// Lightning address their direct payments go to (direct settlement,
// docs/NON-CUSTODIAL-ARCHITECTURE.md). CPAY stores only the address; it
// never has a key for that wallet.
//
//   check   { address }  ask the provider for one unpaid test invoice and its
//                        LUD-21 confirmation; nothing is saved
//   save    { address }  needs a fresh sign-in (step-up, like a payout); the
//                        address is checked again here, then saved and used
//                        24 hours later (the wait is in SQL)
//   remove               needs a fresh sign-in; direct links stop taking
//                        payments at once (they are never switched to the
//                        CPAY balance)
//
// Pure: everything outside is injected; handler_test.ts covers it.

import { type DestinationCheck, merchantMessage, type SettlementProvider } from "../_shared/direct-settlement.ts";
import { type StepUp, STEP_UP_MESSAGE } from "../_shared/step-up.ts";

export type User = { id: string; factors?: Array<{ status?: string }> | null };

export interface Db {
  claimLimit(userId: string): Promise<boolean | undefined>;
  save(userId: string, d: DestinationCheck): Promise<{ address: string; ready_at: string; unchanged: boolean } | { error: string }>;
  remove(userId: string): Promise<number | { error: string }>;
}

export type Deps = {
  getUser(authHeader: string): Promise<User | null>;
  stepUp(token: string | null, user: User): StepUp;
  provider: SettlementProvider;
  db: Db;
  cors(req: Request): Promise<Record<string, string>>;
  log?: (msg: string, extra?: unknown) => void;
};

// Messages a database function may raise that are written for the user.
const USER_ERRORS = [
  "Direct payments are not available yet",
  "Account approval is required first",
  "Direct payments are turned off for this account. Contact support.",
];

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(m, e ?? ""));
  return async (req) => {
    const cors = await deps.cors(req);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const user = await deps.getUser(authHeader);
    if (!user) return json({ error: "Invalid session" }, 401);
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const action = String(body.action ?? "");
    const token = /^Bearer\s+(\S+)$/.exec(authHeader.trim())?.[1] ?? null;
    const userError = (e: string) => USER_ERRORS.find((m) => e.startsWith(m)) ?? "Could not save that. Try again in a moment.";

    if (action === "check" || action === "save") {
      if (action === "save") {
        const s = deps.stepUp(token, user);
        if (!s.ok) {
          return json({ error: STEP_UP_MESSAGE.replace("confirm this payout", "change where your payments go"), code: "reauth_required", reason: s.reason }, 403);
        }
      }
      const allowed = await deps.db.claimLimit(user.id);
      if (allowed === undefined) return json({ error: "Temporarily unavailable. Try again in a moment." }, 503);
      if (!allowed) return json({ error: "Too many checks. Wait a few minutes and try again." }, 429);
      let d: DestinationCheck;
      try {
        d = await deps.provider.checkDestination(String(body.address ?? ""));
      } catch (e) {
        log("destination check refused", { user: user.id, error: String((e as Error)?.message ?? e) });
        return json({ error: merchantMessage(e) }, 422);
      }
      const summary = {
        address: d.address,
        domain: d.domain,
        minSats: Number((d.minSendableMsat + 999n) / 1000n),
        maxSats: Number(d.maxSendableMsat / 1000n),
        confirmsPayments: true,
      };
      if (action === "check") return json({ ok: true, ...summary });
      const saved = await deps.db.save(user.id, d);
      if ("error" in saved) {
        log("destination save failed", { user: user.id, error: saved.error });
        return json({ error: userError(saved.error) }, 409);
      }
      return json({ ok: true, ...summary, readyAt: saved.ready_at, unchanged: saved.unchanged });
    }

    if (action === "remove") {
      const s = deps.stepUp(token, user);
      if (!s.ok) {
        return json({ error: STEP_UP_MESSAGE.replace("confirm this payout", "change where your payments go"), code: "reauth_required", reason: s.reason }, 403);
      }
      const n = await deps.db.remove(user.id);
      if (typeof n !== "number") {
        log("destination remove failed", { user: user.id, error: n.error });
        return json({ error: "Could not remove it. Try again in a moment." }, 500);
      }
      return json({ ok: true, removed: n });
    }
    return json({ error: "Unknown action" }, 400);
  };
}
