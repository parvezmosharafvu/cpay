/** Formats a timestamp as Bangladesh time, e.g. "2026-10-21 05:48 (Dhaka)". */
export function dhakaTime(iso: string): string | null {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  const d = new Date(t.getTime() + 6 * 3600 * 1000); // Asia/Dhaka is UTC+6, no DST
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} (Dhaka)`;
}

type WalletRow = { label?: string; is_primary?: boolean; status?: string; synced_at?: string | null };

/** "last synced <Dhaka time>, <n> min ago" for the primary wallet from
 *  wallet_registry_list(); never "undefined". */
export function lastSyncedDetail(list: unknown, now: number): string {
  const wallets = (list as { wallets?: WalletRow[] } | null)?.wallets ?? [];
  const p = wallets.find((w) => w.is_primary && w.status === "active");
  if (!p) return "no primary wallet";
  const when = p.synced_at ? dhakaTime(p.synced_at) : null;
  if (!when) return `${p.label ?? "primary wallet"}: not synced yet`;
  const mins = Math.max(0, Math.round((now - new Date(p.synced_at!).getTime()) / 60000));
  return `${p.label ?? "primary wallet"} last synced ${when}, ${mins} min ago`;
}
