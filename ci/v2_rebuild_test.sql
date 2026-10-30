-- Rebuild-v2: no provider dependency; route uses strictly scoped owner RPC.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
insert into auth.users(id,email) values
('d3300000-0000-0000-0000-000000000001','v2-owner@test.invalid'),
('d3300000-0000-0000-0000-000000000002','v2-other@test.invalid');
update profiles set account_status='active' where id='d3300000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub','d3300000-0000-0000-0000-000000000001',true);
set local role authenticated;
select v2_create_link('v2-test-shop','V2 Test Shop','Example note',10,1000,array[10,25,50]::numeric[]);
do $$ declare r record;
begin
 select * into r from v2_public_link('v2-test-shop');
 if not found or r.min_usd<>10 or r.max_usd<>1000 or r.note<>'Example note'
 then raise exception 'v2 public projection incorrect'; end if;
end $$;
reset role;
-- A pending account must not open a payment link.
select set_config('request.jwt.claim.sub','d3300000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$
begin
 begin
  perform v2_create_link('v2-pending-shop','Pending','',10,1000,array[10]::numeric[]);
  raise exception 'pending account made link';
 exception when raise_exception then
  if sqlerrm<>'Active account required' then raise; end if;
 end;
end $$;
reset role;
-- A pending v2 payment has no access to legacy BTCPay or wallet settlement.
insert into public.v2_invoices(link_id,owner_id,request_id,status,amount_usd,amount_sats,btc_usd_rate,btc_rate_sources,
platform_fee_pct,platform_fee_usd,net_usd,payment_hash,bolt11,expires_at)
select id,owner_id,'d3300000-0000-0000-0000-000000000009','pending',25,2500,100000,array['coinbase','kraken'],0,0,25,
repeat('a',64),'lnbc2500n1testonly',now()+interval '1 hour' from public.v2_links where slug='v2-test-shop';
set local role service_role;
do $$
declare v text; events int;
begin
 begin
  perform v2_reconcile_invoice(repeat('a',64),'settled',2000);
  raise exception 'underpayment accepted';
 exception when raise_exception then
  if sqlerrm<>'Unproven invoice amount' then raise; end if;
 end;
 v:=v2_reconcile_invoice(repeat('a',64),'settled',2500);
 if v<>'settled' then raise exception 'settlement not recorded'; end if;
 v:=v2_reconcile_invoice(repeat('a',64),'settled',2500);
 if v<>'settled' then raise exception 'settlement not idempotent'; end if;
 select count(*) into events from v2_payment_events where payment_hash=repeat('a',64);
 if events<>1 then raise exception 'duplicate settlement events'; end if;
 if not exists(select 1 from v2_invoices where payment_hash=repeat('a',64) and
    amount_usd=25 and net_usd=25 and confirmed_sats=2500 and settled_at is not null)
 then raise exception 'amount or settlement proof changed'; end if;
end $$;
reset role;
-- Public and logged-in member cannot write directly into authoritative ledger.
select set_config('request.jwt.claim.sub','d3300000-0000-0000-0000-000000000001',true);
set local role authenticated;
do $$
begin
 begin
  update public.v2_invoices set status='settled';
  raise exception 'member modified settlement';
 exception when others then
  if sqlerrm='member modified settlement' then raise; end if;
 end;
end $$;
reset role;
rollback;
\echo 'v2_rebuild_test: passed'
