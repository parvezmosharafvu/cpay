-- ============================================================
-- 0100: withdrawal platform fee defaults to 0%
-- ============================================================
-- Decision: no platform cut on withdrawals by default. On an instant
-- stablecoin withdrawal the user pays only the network fee (swap plus
-- network) from the quote. The per-account platform fee stays in the code
-- and in the admin panel, and an admin can still set one per account.
--
--   * default_withdrawal_fee_percent, which handle_new_user() copies onto
--     every new profile, is set to 0.
--   * profiles.withdrawal_fee_percent defaults to 0 (was 3.0 since 0001),
--     for any insert that does not go through handle_new_user().
--   * The coalesce(withdrawal_fee_percent, …) fallbacks in 0095/0097 are 0.
--
-- Existing profiles keep the fee they have. To drop an account to 0%, use
-- the admin panel (Accounts → fee) or admin_update_creator_fee(), which
-- also writes the audit log.
--
-- 0101 turns the per-account fee into an optional override (NULL = inherit).
-- Safe to re-run.
-- ============================================================

insert into app_settings (key, value, updated_at)
values ('default_withdrawal_fee_percent', '{"percent": 0}'::jsonb, now())
on conflict (key) do update set value = excluded.value, updated_at = now();

alter table profiles alter column withdrawal_fee_percent set default 0;
