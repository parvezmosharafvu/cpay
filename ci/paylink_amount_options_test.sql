-- M2: multi-rail link bounds, public projection, owner isolation.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;

insert into auth.users(id,email) values
 ('d3200000-0000-0000-0000-000000000001','m2-member@test.invalid'),
 ('d3200000-0000-0000-0000-000000000002','m2-other@test.invalid');
update public.profiles set account_status='active' where id in
 ('d3200000-0000-0000-0000-000000000001','d3200000-0000-0000-0000-000000000002');
insert into public.payment_links(id,user_id,slug,display_name,is_active) values
 ('e3200000-0000-0000-0000-000000000001',
  'd3200000-0000-0000-0000-000000000001',
  'm2-link-amount-test','M2 Link Amount Test',true);

-- A freshly migrated legacy link still has NULL options (unchanged cap).
do $$ declare o record;
begin
 select * into o from get_link_amount_options('m2-link-amount-test');
 if not found or o.min_usd is not null or o.max_usd is not null then
  raise exception 'legacy link options not backward compatible';
 end if;
end $$;

select set_config('request.jwt.claim.sub','d3200000-0000-0000-0000-000000000001',true);
set local role authenticated;
select set_link_amount_options(
 'e3200000-0000-0000-0000-000000000001',10,1000,array[10,25,50,100,250,500]::numeric[],
 'A checkout note');
do $$ declare o record;
begin
 select * into o from get_link_amount_options('m2-link-amount-test');
 if o.min_usd<>10 or o.max_usd<>1000 or cardinality(o.quick_amounts)<>6 or o.note<>'A checkout note'
 then raise exception 'configured options missing'; end if;
end $$;
-- A link owner may not set limits outside $10-$1000, duplicate chips,
-- out-of-range chips, or edit the other person's link.
do $$
begin
 begin
  perform set_link_amount_options('e3200000-0000-0000-0000-000000000001',9.99,1000,array[10]::numeric[],'');
  raise exception 'accepted a low minimum';
 exception when raise_exception then
  if sqlerrm <> 'Invalid amount options' then raise; end if;
 end;
 begin
  perform set_link_amount_options('e3200000-0000-0000-0000-000000000001',10,1000,array[10,10]::numeric[],'');
  raise exception 'accepted duplicate chips';
 exception when raise_exception then
  if sqlerrm <> 'Invalid amount options' then raise; end if;
 end;
 begin
  perform set_link_amount_options('e3200000-0000-0000-0000-000000000001',10,1000,array[10,1000.01]::numeric[],'');
  raise exception 'accepted over-limit quick amount';
 exception when raise_exception then
  if sqlerrm <> 'Invalid amount options' then raise; end if;
 end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','d3200000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$
begin
 begin
  perform set_link_amount_options('e3200000-0000-0000-0000-000000000001',10,1000,array[10]::numeric[],'');
  raise exception 'other owner updated options';
 exception when raise_exception then
  if sqlerrm <> 'Not authorized' then raise; end if;
 end;
end $$;
reset role;
-- Public gets only four safe columns and never sees account contact data.
set local role anon;
do $$ declare o record;
begin
 select * into o from get_link_amount_options('m2-link-amount-test');
 if o.min_usd<>10 or o.max_usd<>1000 then raise exception 'anon projection failed'; end if;
end $$;
reset role;
rollback;
\echo 'paylink_amount_options_test: passed'
