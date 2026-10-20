import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dhakaTime, lastSyncedDetail } from "./synced.ts";

Deno.test("Dhaka time is UTC+6 and crosses midnight", () => {
  assertEquals(dhakaTime("2026-10-20T23:47:00Z"), "2026-10-21 05:47 (Dhaka)");
  assertEquals(dhakaTime("2026-10-20T18:30:00Z"), "2026-10-21 00:30 (Dhaka)");
  assertEquals(dhakaTime("nope"), null);
});

Deno.test("primary wallet's real time, never undefined", () => {
  const now = Date.parse("2026-10-20T23:50:00Z");
  const list = { wallets: [
    { label: "Wallet 2", is_primary: false, status: "active", synced_at: "2026-10-20T20:00:00Z" },
    { label: "Wallet 1", is_primary: true, status: "active", synced_at: "2026-10-20T23:47:00Z" },
  ] };
  assertEquals(lastSyncedDetail(list, now), "Wallet 1 last synced 2026-10-21 05:47 (Dhaka), 3 min ago");
  assertEquals(lastSyncedDetail({ wallets: [{ label: "Wallet 1", is_primary: true, status: "active", synced_at: null }] }, now), "Wallet 1: not synced yet");
  assertEquals(lastSyncedDetail(null, now), "no primary wallet");
  for (const l of [list, null, {}]) assertEquals(lastSyncedDetail(l, now).includes("undefined"), false);
});
