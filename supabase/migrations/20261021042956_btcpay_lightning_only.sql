-- CPAY — 20261021042956 (was 20261021060000; renamed to the version production
-- recorded): Admin → Settings btcpay_lightning_only (default true).
-- When on, create-invoice asks BTCPay for a BTC-LN-only invoice, the same
-- request boltpay makes. Turn off to offer on-chain again.
-- Rollback: drop gateway_lightning_only(); re-run 20261021050000's patch.
do $do$
declare src text := pg_get_functiondef('public.platform_setting_defaults()'::regprocedure);
begin
  if src like '%btcpay_lightning_only%' then return; end if;
  -- The patch point comes from 20261021050000, which sorts after this
  -- version. On a fresh database it is not there yet: skip, and
  -- 20261021080000 registers the default after 050000. In production
  -- 050000 ran first, so this patched it there.
  if src not like '%(Lightning + on-chain)'')%' then return; end if;
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
