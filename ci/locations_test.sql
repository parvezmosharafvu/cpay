-- 20261020060000: coarse locations. Owner-only payment details through RLS;
-- account location set through the RPC only; last-seen country only from
-- the request's cf-ipcountry header; admin view needs aal2; link location
-- label is capped. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
-- Production has Supabase's default table grants; RLS is what limits rows.
grant select on public.payments, public.payment_links to authenticated;
insert into auth.users(id, email) values
  ('e9100000-0000-0000-0000-0000000000a1', 'loc-a@test.invalid'),
  ('e9100000-0000-0000-0000-0000000000b1', 'loc-b@test.invalid'),
  ('e9100000-0000-0000-0000-0000000000c1', 'loc-admin@test.invalid');
update profiles set account_status = 'active', platform_fee_percent = 2
 where id in ('e9100000-0000-0000-0000-0000000000a1', 'e9100000-0000-0000-0000-0000000000b1');
update profiles set account_status = 'active', role = 'admin' where id = 'e9100000-0000-0000-0000-0000000000c1';
insert into payment_links(id, user_id, slug, location_label) values
  ('e9100000-0000-0000-0000-0000000001a1', 'e9100000-0000-0000-0000-0000000000a1', 'loc-link-a', 'Dhanmondi, Dhaka');
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref,
                     customer_country, customer_region, customer_city)
values ('e9100000-0000-0000-0000-0000000002a1', 'e9100000-0000-0000-0000-0000000000a1', 'e9100000-0000-0000-0000-0000000001a1',
        50, 'lightning', 'new', now() + interval '15 min', 'loc-1', 'BD', 'Dhaka Division', 'Dhaka');
update payments set status = 'settled', amount_settled = 50, amount_sat = 50000, btc_usd_rate = 100000, settled_at = now()
 where id = 'e9100000-0000-0000-0000-0000000002a1';

-- 0. Helpers.
do $$ begin
  if geo_country(' bd ') <> 'BD' or geo_country('XX') is not null or geo_country('T1') is not null or geo_country('Bangladesh') is not null then
    raise exception 'geo_country'; end if;
  if geo_clean(e'  Old\n Dhaka  ') <> 'Old Dhaka' or geo_clean('   ') is not null or char_length(geo_clean(repeat('x', 200))) <> 80 then
    raise exception 'geo_clean'; end if;
end $$;
do $$ begin
  update payment_links set location_label = repeat('x', 81) where id = 'e9100000-0000-0000-0000-0000000001a1';
  raise exception 'long link location accepted';
exception when check_violation then null; end $$;

-- 1. The owner sees the payment in full; another user and anon see nothing.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', 'e9100000-0000-0000-0000-0000000000a1')::text, true);
do $$ declare d jsonb := get_my_payment_details('e9100000-0000-0000-0000-0000000002a1'); begin
  if d is null then raise exception 'owner cannot see own payment'; end if;
  if d->>'payer_country' <> 'BD' or d->>'payer_region' <> 'Dhaka Division' or d->>'payer_city' <> 'Dhaka' then raise exception 'location %', d; end if;
  if d->>'link_slug' <> 'loc-link-a' or d->>'link_location' <> 'Dhanmondi, Dhaka' then raise exception 'link %', d; end if;
  if (d->>'platform_fee_amount')::numeric <> 1 or (d->>'you_receive')::numeric <> 49 then raise exception 'fees %', d; end if;
  if d->>'status' <> 'settled' then raise exception 'status %', d; end if;
end $$;
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', 'e9100000-0000-0000-0000-0000000000b1')::text, true);
do $$ begin
  if get_my_payment_details('e9100000-0000-0000-0000-0000000002a1') is not null then raise exception 'another user saw the payment'; end if;
  if exists (select 1 from payments where id = 'e9100000-0000-0000-0000-0000000002a1') then raise exception 'RLS let another user read the row'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
  perform get_my_payment_details('e9100000-0000-0000-0000-0000000002a1'); raise exception 'anon ran payment details';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform admin_locations(); raise exception 'anon ran admin_locations';
exception when insufficient_privilege then null; end $$;
reset role;

-- 2. Account location: RPC only, validated; no direct writes.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-0000000000b1', true);
do $$ declare l jsonb := set_my_location('bd', 'Chattogram', ' Cox''s Bazar ', 'Kolatoli'); begin
  if l->>'country' <> 'BD' or l->>'division' <> 'Chattogram' or l->>'district' <> 'Cox''s Bazar' or l->>'area' <> 'Kolatoli' then raise exception 'saved %', l; end if;
end $$;
do $$ begin
  perform set_my_location('Bangladesh'); raise exception 'free-text country accepted';
exception when raise_exception then if sqlerrm not like 'Choose a country%' then raise; end if; end $$;
do $$ begin
  update profile_locations set country = 'US' where user_id = auth.uid();
  raise exception 'direct update allowed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into profile_locations(user_id, country) values ('e9100000-0000-0000-0000-0000000000a1', 'US');
  raise exception 'direct insert allowed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  if (select count(*) from profile_locations) <> 1 then raise exception 'saw another user''s location'; end if;
end $$;

-- 3. Last seen: country from the cf-ipcountry request header only.
select set_config('request.headers', '{"cf-ipcountry":"XX","cf-ipcity":"Spoofed"}', true);
select touch_my_last_seen();
do $$ begin if (my_location()->>'last_seen_country') is not null then raise exception 'unknown country stored'; end if; end $$;
select set_config('request.headers', '{"cf-ipcountry":"BD"}', true);
select touch_my_last_seen();
do $$ begin if my_location()->>'last_seen_country' <> 'BD' then raise exception 'last seen not stored'; end if; end $$;
reset role;
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'profile_locations' and column_name ilike '%ip%' and column_name <> 'updated_at') then
    raise exception 'an ip column exists'; end if;
end $$;

-- 4. Admin view needs an admin with aal2.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-0000000000a1', true);
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
do $$ begin
  perform admin_locations(); raise exception 'non-admin ran admin_locations';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-0000000000c1', true);
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal1')::text, true);
do $$ begin
  perform admin_locations(); raise exception 'admin without aal2 ran admin_locations';
exception when raise_exception then if sqlerrm not like 'Enter your authenticator code%' then raise; end if; end $$;
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'aal', 'aal2')::text, true);
do $$ declare r jsonb := admin_locations('BD', 'dhaka'); begin
  if jsonb_array_length(r->'payments') <> 1 or r->'payments'->0->>'link_location' <> 'Dhanmondi, Dhaka' then raise exception 'payments %', r->'payments'; end if;
  if (r->'payments_by_area'->0->>'payments')::int <> 1 then raise exception 'summary %', r->'payments_by_area'; end if;
  if jsonb_array_length(admin_locations('BD', 'Kolatoli')->'users') <> 1 then raise exception 'users filter'; end if;
  if jsonb_array_length(admin_locations('US')->'payments') <> 0 then raise exception 'country filter'; end if;
end $$;
reset role;
select 'locations_test ok';
rollback;
