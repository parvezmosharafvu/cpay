-- CPAY — 20261021060000: Admin → Settings btcpay_lightning_only (default true).
-- When on, create-invoice asks BTCPay for a BTC-LN-only invoice, the same
-- request boltpay makes. Turn off to offer on-chain again.
-- Rollback: drop gateway_lightning_only(); re-run 20261021050000's patch.
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src like '%btcpay_lightning_only%' then return; end if;
  if src not like '%(Lightning + on-chain)'')%' then
    raise exception 'platform_setting_defaults: patch point not found';
  end if;
  src := replace(src, $r$(Lightning + on-chain)')$r$,
    $r$(Lightning + on-chain)'),
  ('btcpay_lightning_only',         'true'::jsonb,  'boolean', true,  'BTCPay Server: Lightning-only invoices (BTC-LN, same as boltpay). Off = on-chain too')$r$);
  execute src;
end $do$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

create or replace function public.gateway_lightning_only()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(platform_setting('btcpay_lightning_only') <> 'false'::jsonb, true) $$;
revoke all on function public.gateway_lightning_only() from public, anon, authenticated;
grant execute on function public.gateway_lightning_only() to service_role;
