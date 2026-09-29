// Sends queued Telegram messages (migration 0106). See handler.ts.
//
// Secrets (Dashboard > Edge Functions > Secrets):
//   CRON_SECRET               the x-cron-secret pg_cron sends
//   ALERT_TELEGRAM_BOT_TOKEN  the cpay bot, from @BotFather. Add it to each
//                             reseller's group and to the admin group.
//   ALERT_TELEGRAM_CHAT_ID    optional: the admin group
//   ALERT_ON_SETTLED          optional: false stops payment messages to the
//                             admin group (resellers still get theirs)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHandler, outboxFromSupabase } from "./handler.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(createHandler({
  cronSecret: Deno.env.get("CRON_SECRET") ?? "",
  botToken: (Deno.env.get("ALERT_TELEGRAM_BOT_TOKEN") ?? "").trim(),
  adminChatId: (Deno.env.get("ALERT_TELEGRAM_CHAT_ID") ?? "").trim(),
  settledToAdmin: (Deno.env.get("ALERT_ON_SETTLED") ?? "true").toLowerCase() !== "false",
  // Fixed on purpose: the bot token is only ever sent to Telegram.
  telegramApi: "https://api.telegram.org",
  outbox: outboxFromSupabase(supabase),
}));
