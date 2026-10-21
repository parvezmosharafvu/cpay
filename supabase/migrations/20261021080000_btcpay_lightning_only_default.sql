-- 20261021080000: register the btcpay_lightning_only default after
-- 20261021050000 (whose patch point it needs). 20261021042956 now sorts before
-- 050000, so on a fresh database it skips this step. Production already has
-- the default, so this is a no-op there. Additive and idempotent.
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
