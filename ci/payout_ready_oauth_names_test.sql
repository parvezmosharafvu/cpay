-- ============================================================
-- 20261015010000: payout-address ready time; names from Google sign-in
-- ============================================================
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

insert into auth.users(id, email, raw_user_meta_data) values
  ('5e5e5e5e-0000-4000-8000-000000000001', 'form.user@test.invalid', '{"display_name":"Form Name","full_name":"Ignored"}'),
  ('5e5e5e5e-0000-4000-8000-000000000002', 'google.user@test.invalid', '{"full_name":"Rina Akter","name":"Rina","avatar_url":"https://x"}'),
  ('5e5e5e5e-0000-4000-8000-000000000003', 'name.only@test.invalid', '{"name":"Only Name"}'),
  ('5e5e5e5e-0000-4000-8000-000000000004', 'plain.prefix@test.invalid', '{}');

do $$ begin
  if (select display_name from profiles where id = '5e5e5e5e-0000-4000-8000-000000000001') <> 'Form Name' then raise exception 'form display_name must win'; end if;
  if (select display_name from profiles where id = '5e5e5e5e-0000-4000-8000-000000000002') <> 'Rina Akter' then raise exception 'google full_name not used'; end if;
  if (select display_name from profiles where id = '5e5e5e5e-0000-4000-8000-000000000003') <> 'Only Name' then raise exception 'name not used'; end if;
  if (select display_name from profiles where id = '5e5e5e5e-0000-4000-8000-000000000004') <> 'plain.prefix' then raise exception 'email prefix fallback broken'; end if;
  if (select role from profiles where id = '5e5e5e5e-0000-4000-8000-000000000002') <> 'creator' then raise exception 'google user role changed'; end if;
  if not exists (select 1 from account_applications where user_id = '5e5e5e5e-0000-4000-8000-000000000002') then raise exception 'application row missing'; end if;
  raise notice 'ok: profile names from the form, then Google full_name / name, then the email prefix';
end $$;

insert into usdt_wallets(user_id, network, address) values
  ('5e5e5e5e-0000-4000-8000-000000000002', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'),
  ('5e5e5e5e-0000-4000-8000-000000000003', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');

do $$
declare b jsonb;
begin
  perform set_config('request.jwt.claim.sub', '5e5e5e5e-0000-4000-8000-000000000002', true);
  execute 'set local role authenticated';
  b := public.my_payout_book();
  execute 'reset role';
  if jsonb_array_length(b->'wallets') <> 1 then raise exception 'saw another user''s wallet: %', b; end if;
  if (b->'wallets'->0->>'usable_after') is null then raise exception 'usable_after missing: %', b; end if;
  if (b->'wallets'->0->>'usable_after')::timestamptz > now() + interval '1 minute' then raise exception 'usable_after not now (20261020040000): %', b; end if;
  raise notice 'ok: my_payout_book returns only own wallets with usable_after';
end $$;
rollback;
