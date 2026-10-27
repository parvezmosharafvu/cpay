-- CPAY — 20261027050000: remove Blink sweep overflow (owner's decision;
-- the BTCPay receive switch of 20261027040000 replaces it). Overflow was
-- off and never sent anything. Builds on 20261027040000.
--
-- Drops: setting blink_sweep_overflow_enabled (catalogue and value),
-- blink_overflows and its two service-role functions, 'overflow' in
-- system_blink_sweep_config() and 'overflows' in admin_blink_sweeps().
-- Rollback: re-run 20261027030000 §1–§3, then 20261027040000 §4 and §5.

-- 1. Setting --------------------------------------------------------------------
delete from public.platform_settings where key = 'blink_sweep_overflow_enabled';
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src not like '%blink_sweep_overflow_enabled%' then return; end if;
  src := regexp_replace(src, E'\\n[ \\t]*\\(''blink_sweep_overflow_enabled''[^\\n]*\\),', '');
  if src like '%blink_sweep_overflow_enabled%' then
    raise exception 'platform_setting_defaults: overflow row not removed';
  end if;
  execute src;
end $do$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

-- 2. Log and functions ------------------------------------------------------------
drop function if exists public.system_blink_overflow_begin(text, text, integer);
drop function if exists public.system_blink_overflow_finish(uuid, text, text);
drop table if exists public.blink_overflows;

-- 3. Config: without overflow -------------------------------------------------------
create or replace function public.system_blink_sweep_config()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_dest text;
begin
  if to_regclass('breez_wallet.brz_settings') is not null and to_regclass('breez_wallet.wallets') is not null then
    begin
      execute $q$
        select (s.value::jsonb) #>> '{address,lightning_address}'
          from breez_wallet.wallets w
          join breez_wallet.brz_settings s on encode(s.user_id, 'hex') = w.node_pubkey and s.key = 'lightning_address'
         where w.is_primary and w.status = 'active'
         limit 1 $q$ into v_dest;
    exception when others then v_dest := null;
    end;
  end if;
  return jsonb_build_object(
    'enabled', coalesce(platform_setting('blink_sweep_enabled') = 'true'::jsonb, false),
    'receive_switch', coalesce(platform_setting('blink_receive_switch_enabled') = 'true'::jsonb, false),
    'switch_below_usd', platform_setting('blink_receive_switch_below_usd'),
    'keep_usd', platform_setting('blink_sweep_keep_usd'),
    'min_usd', platform_setting('blink_sweep_min_usd'),
    'max_usd', platform_setting('blink_sweep_max_usd'),
    'destination', v_dest);
end $$;
revoke all on function public.system_blink_sweep_config() from public, anon, authenticated;
grant execute on function public.system_blink_sweep_config() to service_role;

-- 4. Admin read: without overflows ------------------------------------------------------
create or replace function public.admin_blink_sweeps(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'destination', public.system_blink_sweep_config() ->> 'destination',
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account', a.account, 'checked_at', a.checked_at, 'balance_cents', a.balance_cents,
               'can_send', a.can_send, 'withdraw_remaining_cents', a.withdraw_remaining_cents, 'result', a.result,
               'sent_24h_cents', (select coalesce(sum(b.amount_cents), 0) from public.blink_sweeps b
                                   where b.account = a.account and b.status in ('sent', 'sending', 'pending')
                                     and b.created_at > now() - interval '24 hours'))
             order by a.account::int)
        from public.blink_sweep_accounts a where a.checked_at > now() - interval '1 day'), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'account', b.account, 'created_at', b.created_at, 'updated_at', b.updated_at, 'status', b.status,
               'amount_cents', b.amount_cents, 'amount_sat', b.amount_sat, 'destination', b.destination,
               'payment_hash', b.payment_hash, 'error', b.error) order by b.created_at desc)
        from (select * from public.blink_sweeps order by created_at desc limit v_limit) b), '[]'::jsonb),
    'receiving', (select jsonb_build_object('account', r.account, 'key_kind', r.key_kind, 'result', r.result, 'checked_at', r.checked_at)
                    from public.blink_receive_state r),
    'switches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'created_at', s.created_at, 'from_account', s.from_account, 'to_account', s.to_account,
               'status', s.status, 'error', s.error) order by s.created_at desc)
        from (select * from public.blink_receive_switches order by created_at desc limit v_limit) s), '[]'::jsonb),
    'rescues', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'created_at', x.created_at, 'payment_id', x.payment_id, 'account', x.account,
               'amount_usd', x.amount_usd, 'outcome', x.outcome) order by x.created_at desc)
        from (select * from public.blink_rescues order by created_at desc limit v_limit) x), '[]'::jsonb));
end $$;
revoke all on function public.admin_blink_sweeps(integer) from public, anon;
grant execute on function public.admin_blink_sweeps(integer) to authenticated, service_role;
