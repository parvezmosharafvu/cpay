-- 20261021070000 applies over a database that already has finished
-- (forwarded) USDT forwards: the backfill skips them and the guard is
-- untouched. Re-runs the migration inside BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
insert into auth.users(id, email) values ('e9200000-0000-0000-0000-0000000000d1', 'fwd-backfill@test.invalid');
update profiles set account_status = 'active', platform_fee_percent = 2 where id = 'e9200000-0000-0000-0000-0000000000d1';
insert into payment_links(id, user_id, slug) values ('e9200000-0000-0000-0000-0000000001d1', 'e9200000-0000-0000-0000-0000000000d1', 'fwd-backfill-link');
insert into usdt_wallets(user_id, network, address) values ('e9200000-0000-0000-0000-0000000000d1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
insert into receive_settings(user_id, method, usdt_network) values ('e9200000-0000-0000-0000-0000000000d1', 'usdt', 'tron')
  on conflict (user_id) do update set method = 'usdt', usdt_network = 'tron';
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"') on conflict (key) do update set value = excluded.value;
-- Seed as production looks before this migration: no wallet id filled.
alter table payment_forwards disable trigger trg_payment_forwards_fill_destination;
alter table forward_batches disable trigger trg_forward_batches_fill_destination;
create function pg_temp.pay(p_id text) returns void language plpgsql as $$
begin
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values (p_id::uuid, 'e9200000-0000-0000-0000-0000000000d1', 'e9200000-0000-0000-0000-0000000001d1', 3, 'lightning', 'new', now() + interval '15 min', 'fb-' || p_id);
  update payments set status = 'settled', amount_settled = 3, amount_sat = 3000, settled_at = now() where id = p_id::uuid;
end $$;
select pg_temp.pay('e9200000-0000-0000-0000-0000000002d1');
do $$ declare b forward_batches; begin
  select * into b from system_usdt_batch_create('e9200000-0000-0000-0000-0000000000d1', 'tron', 'orchestra:tron:usdt');
  perform system_usdt_batch_finish(b.id, 'forwarded', 'ref-seed', '2.90', 0.04);
end $$;
select pg_temp.pay('e9200000-0000-0000-0000-0000000002d2');  -- stays queued
alter table payment_forwards enable trigger trg_payment_forwards_fill_destination;
alter table forward_batches enable trigger trg_forward_batches_fill_destination;
do $$ begin
  if (select status from payment_forwards where payment_id = 'e9200000-0000-0000-0000-0000000002d1') <> 'forwarded' then raise exception 'seed not forwarded'; end if;
  if exists (select 1 from payment_forwards where user_id = 'e9200000-0000-0000-0000-0000000000d1' and usdt_wallet_id is not null) then raise exception 'seed already filled'; end if;
end $$;

\i supabase/migrations/20261021070000_forward_traceability.sql

do $$ declare w uuid; begin
  select id into w from usdt_wallets where user_id = 'e9200000-0000-0000-0000-0000000000d1';
  if (select usdt_wallet_id from payment_forwards where payment_id = 'e9200000-0000-0000-0000-0000000002d1') is not null then raise exception 'finished row changed'; end if;
  if (select usdt_wallet_id from payment_forwards where payment_id = 'e9200000-0000-0000-0000-0000000002d2') is distinct from w then raise exception 'queued row not backfilled'; end if;
  if (select usdt_wallet_id from forward_batches where user_id = 'e9200000-0000-0000-0000-0000000000d1') is distinct from w then raise exception 'batch not backfilled'; end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_payment_forwards_guard' and tgenabled = 'O') then raise exception 'guard changed'; end if;
end $$;
rollback;
\echo forward traceability backfill OK
