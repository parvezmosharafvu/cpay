-- ============================================================
-- Production drift fixes (20261004020000): behaviour checks
-- ============================================================
-- Included (\ir) by ci/production_drift_test.sql (repo-built state) and
-- ci/production_drift_from_production_state_test.sql (production state
-- simulated, then the migration applied again). The caller owns the
-- transaction; this file only adds fixtures inside it.
-- ============================================================

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create or replace function pg_temp.act(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform set_config('request.jwt.claims',
    case when p_sub is null then '{"role":"anon"}'
         else json_build_object('role', 'authenticated', 'sub', p_sub)::text end, true);
end $$;
grant execute on function pg_temp.act(text) to anon, authenticated, service_role;

-- Table privileges as production has them (Supabase default privileges;
-- the plain CI database has none). Column UPDATE on profiles stays limited
-- to display_name, bio, public_slug by 20261003000000.
grant select, insert, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.usdt_wallets to authenticated;
grant select, insert, update, delete on public.payment_links to authenticated;

-- Expect a statement to fail; returns the error text, raises if it worked.
create or replace function pg_temp.must_fail(p_sql text, p_label text) returns text language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    return v_msg;
  end;
  raise exception 'expected failure but it succeeded: %', p_label;
end $$;
grant execute on function pg_temp.must_fail(text, text) to anon, authenticated, service_role;

-- People (fixed ids):
--   ad, a2 active admins   rc reseller C   ra reseller A (not B's)
--   fb freelancer referred to C at signup   fo freelancer, no reseller
--   fp pending freelancer
do $$ begin perform pg_temp.act(null); end $$;
insert into auth.users(id, email) values
  ('d1000000-0000-0000-0000-0000000000ad', 'drift-admin@test.invalid'),
  ('d1000000-0000-0000-0000-0000000000a2', 'drift-admin-two@test.invalid'),
  ('d1000000-0000-0000-0000-0000000000cc', 'drift-reseller-c@test.invalid'),
  ('d1000000-0000-0000-0000-0000000000aa', 'drift-reseller-a@test.invalid'),
  ('d1000000-0000-0000-0000-0000000000f0', 'drift-freelancer-o@test.invalid'),
  ('d1000000-0000-0000-0000-0000000000fd', 'drift-freelancer-p@test.invalid');
update profiles set role = 'admin',     account_status = 'active' where id in ('d1000000-0000-0000-0000-0000000000ad', 'd1000000-0000-0000-0000-0000000000a2');
update profiles set role = 'moderator', account_status = 'active' where id in ('d1000000-0000-0000-0000-0000000000cc', 'd1000000-0000-0000-0000-0000000000aa');
update profiles set role = 'creator',   account_status = 'active', display_name = 'Drift O' where id = 'd1000000-0000-0000-0000-0000000000f0';
update profiles set role = 'creator',   account_status = 'active'  where id = 'd1000000-0000-0000-0000-0000000000fd';  -- pending after its link exists
do $$
declare v_code text;
begin
  select affiliate_code into v_code from profiles where id = 'd1000000-0000-0000-0000-0000000000cc';
  insert into auth.users(id, email, raw_user_meta_data) values
    ('d1000000-0000-0000-0000-0000000000fb', 'drift-freelancer-b@test.invalid',
     jsonb_build_object('requested_role', 'freelancer', 'affiliate_code', upper(v_code)));
end $$;
update profiles set account_status = 'active', role = 'creator', display_name = 'Drift B' where id = 'd1000000-0000-0000-0000-0000000000fb';
do $$ begin
  if not exists (select 1 from profiles where id = 'd1000000-0000-0000-0000-0000000000fb'
                  and referred_by = 'd1000000-0000-0000-0000-0000000000cc') then
    raise exception 'fixture: freelancer B is not on reseller C''s team';
  end if;
end $$;

-- Links for B: active, inactive, deleted.
insert into payment_links(user_id, slug, display_name, is_active) values
  ('d1000000-0000-0000-0000-0000000000fb', 'drift-b-live', 'B live', true),
  ('d1000000-0000-0000-0000-0000000000fb', 'drift-b-off', 'B off', false),
  ('d1000000-0000-0000-0000-0000000000fb', 'drift-b-gone', 'B gone', true),
  ('d1000000-0000-0000-0000-0000000000fd', 'drift-p-live', 'P live', true);
update payment_links set deleted_at = now() where slug = 'drift-b-gone';
-- Link ids for callers that cannot read the link through RLS.
select set_config('drift.b_live', (select id::text from payment_links where slug = 'drift-b-live'), true);
update profiles set account_status = 'pending' where id = 'd1000000-0000-0000-0000-0000000000fd';

-- ============================================================
-- 1. Storefront
-- ============================================================
do $$
declare v_missing text;
begin
  select string_agg(c, ', ') into v_missing
    from unnest(array['store_tagline','store_bio','store_avatar_url','store_theme','store_accent','store_cta']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'profiles' and column_name = c);
  if v_missing is not null then raise exception 'store columns missing: %', v_missing; end if;
  if (select store_theme || store_accent || store_cta from profiles where id = 'd1000000-0000-0000-0000-0000000000fb')
     <> 'midnight#00D632Pay now' then
    raise exception 'store column defaults are wrong';
  end if;
  perform pg_temp.must_fail($q$update profiles set store_theme = 'neon' where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'invalid store_theme');
  if pg_get_function_result('public.get_public_store(uuid)'::regprocedure)
     <> 'TABLE(display_name text, tagline text, bio text, avatar_url text, theme text, accent text, cta text, links jsonb)' then
    raise exception 'get_public_store return shape changed: %', pg_get_function_result('public.get_public_store(uuid)'::regprocedure);
  end if;
  if not has_function_privilege('anon', 'public.get_public_store(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_public_store(uuid)', 'execute') then
    raise exception 'get_public_store must be executable by anon and authenticated';
  end if;
  raise notice 'ok: store columns, defaults, theme check, return shape and grants';
end $$;

set local role anon;
do $$
declare r record; v_n int;
begin
  perform pg_temp.act(null);
  select * into r from public.get_public_store('d1000000-0000-0000-0000-0000000000fb');
  if r.display_name <> 'Drift B' or r.theme <> 'midnight' or r.cta <> 'Pay now' then
    raise exception 'anon store: wrong header %', row_to_json(r);
  end if;
  if jsonb_array_length(r.links) <> 1 or r.links->0->>'slug' <> 'drift-b-live' then
    raise exception 'anon store: only the active, non-deleted link may be listed, got %', r.links;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(r.links->0) k) <> array['display_name','og_image','slug','theme'] then
    raise exception 'anon store: link fields beyond the public set: %', r.links->0;
  end if;
  if r::text ilike '%@test.invalid%' then raise exception 'anon store leaks an email'; end if;
  select count(*) into v_n from public.get_public_store('d1000000-0000-0000-0000-0000000000fd');
  if v_n <> 0 then raise exception 'a pending account must not have a public store'; end if;
  select count(*) into v_n from public.get_public_store('d1000000-0000-0000-0000-0000000000ad');
  if v_n <> 0 then raise exception 'an admin profile must not have a public store'; end if;
  select count(*) into v_n from public.get_public_store('00000000-0000-0000-0000-000000000000');
  if v_n <> 0 then raise exception 'unknown id must return no store'; end if;
  raise notice 'ok: anon sees the active store with public fields only; pending, admin and unknown ids get nothing';
end $$;
reset role;

-- ============================================================
-- 2. Payout wallets
-- ============================================================
do $$ begin perform pg_temp.act(null); end $$;
insert into usdt_wallets(user_id, network, address)
values ('d1000000-0000-0000-0000-0000000000f0', 'tron', 'TAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

do $$
declare v_qual text; v_check text; v_sig text;
begin
  select qual, with_check into v_qual, v_check from pg_policies
   where schemaname = 'public' and tablename = 'usdt_wallets' and policyname = 'usdt_wallets_own';
  if v_qual is distinct from '(user_id = auth.uid())' or v_check is distinct from '(user_id = auth.uid())' then
    raise exception 'usdt_wallets_own must be own rows only, got USING % CHECK %', v_qual, v_check;
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'usdt_wallets') <> 1 then
    raise exception 'unexpected extra policy on usdt_wallets';
  end if;
  foreach v_sig in array array['public.my_payout_book()', 'public.set_my_payout_prefs(numeric, text, boolean)',
                               'public.set_my_usdt_wallet(text, text)', 'public.delete_my_usdt_wallet(text)',
                               'public.my_withdraw_settings()'] loop
    if has_function_privilege('anon', v_sig, 'execute') then raise exception 'anon can still execute %', v_sig; end if;
    if not has_function_privilege('authenticated', v_sig, 'execute') then raise exception 'authenticated lost %', v_sig; end if;
    if exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = v_sig::regprocedure and a.grantee = 0) then
      raise exception 'PUBLIC can still execute %', v_sig;
    end if;
  end loop;
  raise notice 'ok: own-rows policy; wallet functions are authenticated-only';
end $$;

-- An active admin gets nothing through the table directly.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$
declare v_n int;
begin
  select count(*) into v_n from usdt_wallets where user_id = 'd1000000-0000-0000-0000-0000000000f0';
  if v_n <> 0 then raise exception 'admin read another user''s wallet directly'; end if;
  update usdt_wallets set address = 'TBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' where user_id = 'd1000000-0000-0000-0000-0000000000f0';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'admin updated another user''s wallet directly'; end if;
  delete from usdt_wallets where user_id = 'd1000000-0000-0000-0000-0000000000f0';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'admin deleted another user''s wallet directly'; end if;
  perform pg_temp.must_fail($q$insert into usdt_wallets(user_id, network, address) values ('d1000000-0000-0000-0000-0000000000f0', 'bsc', '0x1111111111111111111111111111111111111111')$q$, 'admin direct insert');
  raise notice 'ok: admin has no direct table access to other users'' wallets';
end $$;
-- The audited RPCs still work for the admin.
do $$
declare v_n int; v_old jsonb; v_new jsonb;
begin
  select count(*) into v_n from public.admin_list_user_wallets() where user_id = 'd1000000-0000-0000-0000-0000000000f0';
  if v_n <> 1 then raise exception 'admin_list_user_wallets lost the wallet'; end if;
  perform public.admin_set_user_usdt_wallet('d1000000-0000-0000-0000-0000000000f0', 'tron', 'TCcccccccccccccccccccccccccccccccc');
  perform public.admin_set_user_usdt_wallet('d1000000-0000-0000-0000-0000000000f0', 'bsc', '0x2222222222222222222222222222222222222222');
end $$;
reset role;
do $$
declare v_old jsonb; v_new jsonb; v_actor uuid;
begin
  if (select address from usdt_wallets where user_id = 'd1000000-0000-0000-0000-0000000000f0' and network = 'tron')
     <> 'TCcccccccccccccccccccccccccccccccc' then
    raise exception 'admin_set_user_usdt_wallet did not change the address';
  end if;
  select old_value, new_value, actor_id into v_old, v_new, v_actor from audit_log
   where action = 'payout_wallet.admin_set' and subject_id = 'd1000000-0000-0000-0000-0000000000f0'
     and new_value->>'network' = 'tron';
  if v_actor is distinct from 'd1000000-0000-0000-0000-0000000000ad'
     or v_old->>'address' <> 'TAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     or v_new->>'address' <> 'TCcccccccccccccccccccccccccccccccc' then
    raise exception 'admin wallet change audit missing or wrong: actor % old % new %', v_actor, v_old, v_new;
  end if;
  select old_value, new_value into v_old, v_new from audit_log
   where action = 'payout_wallet.admin_set' and subject_id = 'd1000000-0000-0000-0000-0000000000f0'
     and new_value->>'network' = 'bsc';
  if v_old->>'address' is not null or v_new->>'address' <> '0x2222222222222222222222222222222222222222' then
    raise exception 'admin wallet creation audit wrong: old % new %', v_old, v_new;
  end if;
  raise notice 'ok: admin payout-address changes go through the RPC and are audited with old and new address';
end $$;
-- Non-admins cannot use the admin RPCs.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ begin
  perform pg_temp.must_fail($q$select public.admin_set_user_usdt_wallet('d1000000-0000-0000-0000-0000000000f0', 'tron', 'TDdddddddddddddddddddddddddddddddd')$q$, 'reseller admin_set_user_usdt_wallet');
  perform pg_temp.must_fail($q$select * from public.admin_list_user_wallets()$q$, 'reseller admin_list_user_wallets');
  raise notice 'ok: non-admins cannot use the admin wallet RPCs';
end $$;
reset role;

-- Self-management still works.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000fb'); end $$;
set local role authenticated;
do $$
declare v_book jsonb; v_set jsonb; v_n int;
begin
  perform public.set_my_usdt_wallet('tron', 'TEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  perform public.set_my_usdt_wallet('bsc', '0x3333333333333333333333333333333333333333');
  perform public.set_my_payout_prefs(10, 'bsc', true);
  v_book := public.my_payout_book();
  if jsonb_array_length(v_book->'wallets') <> 2 or v_book->>'preferred_usdt_network' <> 'bsc' then
    raise exception 'my_payout_book wrong: %', v_book;
  end if;
  v_set := public.my_withdraw_settings();
  if not (v_set ? 'withdraw_threshold' and v_set ? 'preferred_usdt_network' and v_set ? 'auto_withdraw_enabled' and v_set ? 'fee_percent')
     or v_set->>'preferred_usdt_network' <> 'bsc' or (v_set->>'withdraw_threshold')::numeric <> 10 then
    raise exception 'my_withdraw_settings (production version) wrong: %', v_set;
  end if;
  perform public.delete_my_usdt_wallet('bsc');
  if (select preferred_usdt_network from profiles where id = auth.uid()) is not null then
    raise exception 'delete_my_usdt_wallet must clear the preferred network it pointed at';
  end if;
  select count(*) into v_n from usdt_wallets where user_id = auth.uid();
  if v_n <> 1 then raise exception 'own direct read of wallets broken (got %)', v_n; end if;
  update usdt_wallets set address = 'TFffffffffffffffffffffffffffffffff' where user_id = auth.uid() and network = 'tron';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'own direct wallet update broken'; end if;
  raise notice 'ok: self wallet management works (RPCs and own rows)';
end $$;
reset role;
set local role anon;
do $$ begin
  perform pg_temp.act(null);
  perform pg_temp.must_fail($q$select public.my_payout_book()$q$, 'anon my_payout_book');
  perform pg_temp.must_fail($q$select public.set_my_usdt_wallet('tron', 'TAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$q$, 'anon set_my_usdt_wallet');
  perform pg_temp.must_fail($q$select public.delete_my_usdt_wallet('tron')$q$, 'anon delete_my_usdt_wallet');
  perform pg_temp.must_fail($q$select public.set_my_payout_prefs(null, null, false)$q$, 'anon set_my_payout_prefs');
  raise notice 'ok: anon cannot call the wallet functions';
end $$;
reset role;

-- ============================================================
-- 3. Cost / price lock (D4)
-- ============================================================
-- Reseller C prices and locks freelancer B (on C's team).
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ begin
  perform public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000fb', 3, true);
end $$;
reset role;
do $$ begin
  if (select cost_percent::text || cost_locked::text from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') <> '3.000true' then
    raise exception 'reseller could not price and lock their own team member';
  end if;
  raise notice 'ok: reseller sets and locks the price of an assigned freelancer';
end $$;

-- Reseller A (not B's reseller) cannot, by RPC or by any definer path.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000aa'); end $$;
set local role authenticated;
do $$ begin
  perform pg_temp.must_fail($q$select public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000fb', 0, false)$q$, 'other reseller RPC');
end $$;
reset role;
do $$ declare v text; begin
  -- As a SECURITY DEFINER function would: postgres, with A's auth.uid().
  v := pg_temp.must_fail($q$update profiles set cost_percent = 0 where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'other reseller definer cost');
  v := pg_temp.must_fail($q$update profiles set cost_locked = false where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'other reseller definer unlock');
  v := pg_temp.must_fail($q$update profiles set team_cost_percent = 1 where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'other user team_cost_percent');
  raise notice 'ok: a reseller cannot price someone else''s freelancer';
end $$;

-- Freelancer B cannot unlock or change the locked price by any path.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000fb'); end $$;
set local role authenticated;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$update profiles set cost_locked = false where id = auth.uid()$q$, 'B PATCH cost_locked');
  v := pg_temp.must_fail($q$update profiles set cost_percent = 0 where id = auth.uid()$q$, 'B PATCH cost_percent');
  v := pg_temp.must_fail($q$select public.set_my_cost_percent(0)$q$, 'B set_my_cost_percent while locked');
  v := pg_temp.must_fail($q$select public.set_link_cost_percent(current_setting('drift.b_live')::uuid, 0)$q$, 'B set_link_cost_percent while locked');
  v := pg_temp.must_fail($q$update payment_links set cost_percent = 0 where slug = 'drift-b-live'$q$, 'B PATCH link cost while locked');
  if v not like '%locked%' then raise exception 'link PATCH refused for the wrong reason: %', v; end if;
  v := pg_temp.must_fail($q$insert into payment_links(user_id, slug, display_name, cost_percent) values (auth.uid(), 'drift-b-cheap', 'cheap', 0)$q$, 'B insert link with cost while locked');
  if v not like '%locked%' then raise exception 'link INSERT refused for the wrong reason: %', v; end if;
  -- Non-price link edits still work while locked.
  update payment_links set display_name = 'B live renamed' where slug = 'drift-b-live';
  raise notice 'ok: locked freelancer: PATCH profile/link cost, RPCs and link insert with cost all refused; other link edits work';
end $$;
reset role;
do $$ declare v text; begin
  -- Definer path with B's auth.uid() (the trigger rule itself).
  v := pg_temp.must_fail($q$update profiles set cost_locked = false where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'B definer unlock');
  if v not like '%reseller or an admin%' then raise exception 'unlock refused for the wrong reason: %', v; end if;
  v := pg_temp.must_fail($q$update profiles set cost_percent = 0 where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'B definer cost change');
  if v not like '%locked%' then raise exception 'locked cost refused for the wrong reason: %', v; end if;
  v := pg_temp.must_fail($q$update profiles set team_cost_percent = 1 where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'freelancer team_cost_percent');
  if (select cost_percent::text || cost_locked::text from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') <> '3.000true' then
    raise exception 'B''s locked price changed';
  end if;
  raise notice 'ok: the profile guard refuses unlock, locked cost change and team rate for the freelancer';
end $$;

-- Team lock and unlock by reseller C.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ declare v_n int; begin
  v_n := public.reseller_lock_team_cost(5, true);
  if v_n < 1 then raise exception 'team lock touched no accounts'; end if;
end $$;
reset role;
do $$ begin
  if (select cost_percent::text || cost_locked::text from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') <> '5.000true'
     or (select team_cost_percent from profiles where id = 'd1000000-0000-0000-0000-0000000000cc') <> 5 then
    raise exception 'team lock did not apply';
  end if;
  if (select cost_locked from profiles where id = 'd1000000-0000-0000-0000-0000000000f0') then
    raise exception 'team lock touched a freelancer outside the team';
  end if;
end $$;
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ begin perform public.reseller_lock_team_cost(5, false); end $$;
reset role;
do $$ begin
  if (select cost_locked from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') then
    raise exception 'team unlock did not apply';
  end if;
  raise notice 'ok: reseller team lock and unlock apply to the team only';
end $$;
-- Unlocked: B manages their own rate again (RPC and link).
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000fb'); end $$;
set local role authenticated;
do $$ begin
  perform public.set_my_cost_percent(2);
  perform public.set_link_cost_percent(current_setting('drift.b_live')::uuid, 1.5);
  update payment_links set cost_percent = 1.25 where slug = 'drift-b-live';
end $$;
reset role;
do $$ begin
  if (select cost_percent from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') <> 2
     or (select cost_percent from payment_links where slug = 'drift-b-live') <> 1.25 then
    raise exception 'unlocked freelancer could not set their own rates';
  end if;
  raise notice 'ok: an unlocked freelancer sets their own profile and link rates';
end $$;
-- A freelancer with no reseller is unaffected.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000f0'); end $$;
set local role authenticated;
do $$ begin perform public.set_my_cost_percent(4); end $$;
reset role;
do $$ begin
  if (select cost_percent from profiles where id = 'd1000000-0000-0000-0000-0000000000f0') <> 4 then
    raise exception 'freelancer without reseller cannot set own rate';
  end if;
  raise notice 'ok: a freelancer without a reseller sets their own rate';
end $$;
-- Admin manages any price and lock.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$ begin
  perform public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000f0', 6, true);
  perform public.admin_set_cost_percent('d1000000-0000-0000-0000-0000000000f0', 7);
end $$;
reset role;
do $$ begin
  update profiles set cost_locked = false where id = 'd1000000-0000-0000-0000-0000000000f0';  -- definer path, admin uid
  if (select cost_percent::text || cost_locked::text from profiles where id = 'd1000000-0000-0000-0000-0000000000f0') <> '7.000false' then
    raise exception 'admin could not manage price and lock';
  end if;
  raise notice 'ok: admin sets, locks and unlocks any price';
end $$;
-- A suspended reseller loses pricing power over their team.
do $$ begin perform pg_temp.act(null); end $$;
update profiles set account_status = 'suspended' where id = 'd1000000-0000-0000-0000-0000000000cc';
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$select public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000fb', 0, true)$q$, 'suspended reseller RPC');
  v := pg_temp.must_fail($q$update profiles set cost_locked = true where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'suspended reseller definer lock');
  raise notice 'ok: a suspended reseller cannot price their team';
end $$;
do $$ begin perform pg_temp.act(null); end $$;
update profiles set account_status = 'active' where id = 'd1000000-0000-0000-0000-0000000000cc';

-- ============================================================
-- 4. Nobody changes their own role or account status
-- ============================================================
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$update profiles set account_status = 'suspended' where id = auth.uid()$q$, 'admin PATCH own status');
  v := pg_temp.must_fail($q$update profiles set role = 'creator' where id = auth.uid()$q$, 'admin PATCH own role');
  v := pg_temp.must_fail($q$select public.admin_set_role(auth.uid(), 'creator')$q$, 'admin_set_role on self');
  if v not like '%your own role%' then raise exception 'admin_set_role self refused for the wrong reason: %', v; end if;
  v := pg_temp.must_fail($q$select public.admin_update_account_control(auth.uid(), 'admin', 'suspended', null)$q$, 'account control on self');
  -- Changing another account still works.
  perform public.admin_update_account_control('d1000000-0000-0000-0000-0000000000a2', 'admin', 'suspended', 'drift test');
  perform public.admin_set_role('d1000000-0000-0000-0000-0000000000f0', 'creator');
  raise notice 'ok: admin cannot change own role or status (PATCH, admin_set_role, account control); other accounts still work';
end $$;
reset role;
do $$ declare v text; begin
  -- Definer path with the admin's own uid.
  v := pg_temp.must_fail($q$update profiles set account_status = 'suspended' where id = 'd1000000-0000-0000-0000-0000000000ad'$q$, 'admin definer own status');
  v := pg_temp.must_fail($q$update profiles set role = 'moderator' where id = 'd1000000-0000-0000-0000-0000000000ad'$q$, 'admin definer own role');
  if (select role || account_status from profiles where id = 'd1000000-0000-0000-0000-0000000000ad') <> 'adminactive' then
    raise exception 'admin''s own role/status changed';
  end if;
  if (select account_status from profiles where id = 'd1000000-0000-0000-0000-0000000000a2') <> 'suspended' then
    raise exception 'admin could not change another admin';
  end if;
end $$;
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000f0'); end $$;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$update profiles set account_status = 'active', role = 'admin' where id = 'd1000000-0000-0000-0000-0000000000f0'$q$, 'freelancer definer own role');
  raise notice 'ok: own role/status refused on the definer path too';
end $$;
-- No session (service role, signup trigger) is unaffected.
do $$ begin perform pg_temp.act(null); end $$;
update profiles set account_status = 'active' where id = 'd1000000-0000-0000-0000-0000000000a2';

-- ============================================================
-- 3b. Applying a lock clears the freelancer's link-level overrides
-- ============================================================
-- State here: B unlocked, profile cost 2, link drift-b-live cost 1.25.
do $$ begin perform pg_temp.act(null); end $$;
insert into payment_links(user_id, slug, display_name, is_active, cost_percent) values
  ('d1000000-0000-0000-0000-0000000000fb', 'drift-b-paused', 'B paused', false, 2.5);
update payment_links set cost_percent = 9 where slug = 'drift-b-gone';  -- deleted link
select set_config('drift.b_paused', (select id::text from payment_links where slug = 'drift-b-paused'), true);
create or replace function pg_temp.link_costs() returns text language sql as $$
  select string_agg(slug || '=' || coalesce(cost_percent::text, 'null'), ',' order by slug)
    from payment_links where user_id = 'd1000000-0000-0000-0000-0000000000fb'
$$;
grant execute on function pg_temp.link_costs() to anon, authenticated, service_role;
do $$ begin
  if pg_temp.link_costs() <> 'drift-b-gone=9.000,drift-b-live=1.250,drift-b-off=null,drift-b-paused=2.500' then
    raise exception 'fixture: unexpected link costs %', pg_temp.link_costs();
  end if;
end $$;

-- Atomic: the clear happens inside the lock statement and rolls back with it.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$
declare v_inside text;
begin
  begin
    perform public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000fb', 3, true);
    v_inside := pg_temp.link_costs();
    raise exception 'drift-test-abort';
  exception when raise_exception then
    if sqlerrm <> 'drift-test-abort' then raise; end if;
  end;
  if v_inside <> 'drift-b-gone=9.000,drift-b-live=null,drift-b-off=null,drift-b-paused=null' then
    raise exception 'lock did not clear link overrides in the same statement: %', v_inside;
  end if;
  if pg_temp.link_costs() <> 'drift-b-gone=9.000,drift-b-live=1.250,drift-b-off=null,drift-b-paused=2.500' then
    raise exception 'rolled-back lock left links changed: %', pg_temp.link_costs();
  end if;
  if (select cost_locked from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') then
    raise exception 'rolled-back lock left the profile locked';
  end if;
  raise notice 'ok: lock and link clear commit or roll back together';
end $$;
reset role;

-- A reseller outside B's team cannot lock B, so cannot trigger the clear,
-- and cannot clear B's links any other way.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000aa'); end $$;
set local role authenticated;
do $$ declare v text; v_n int; begin
  v := pg_temp.must_fail($q$select public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000fb', 3, true)$q$, 'non-team reseller lock');
  v := pg_temp.must_fail($q$select public.set_link_cost_percent(current_setting('drift.b_live')::uuid, null)$q$, 'non-team reseller link clear');
  if v <> 'Not authorized' then raise exception 'non-team clear refused for the wrong reason: %', v; end if;
  update payment_links set cost_percent = null where user_id = 'd1000000-0000-0000-0000-0000000000fb';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'non-team reseller changed B''s links through REST'; end if;
  perform public.reseller_lock_team_cost(1, true);  -- A's own (empty) team
end $$;
reset role;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$update profiles set cost_locked = true where id = 'd1000000-0000-0000-0000-0000000000fb'$q$, 'non-team reseller definer lock');
  if pg_temp.link_costs() <> 'drift-b-gone=9.000,drift-b-live=1.250,drift-b-off=null,drift-b-paused=2.500'
     or (select cost_locked from profiles where id = 'd1000000-0000-0000-0000-0000000000fb') then
    raise exception 'non-team reseller changed B''s lock or links: %', pg_temp.link_costs();
  end if;
  raise notice 'ok: a reseller outside the team cannot trigger or perform the clear';
end $$;

-- B's own reseller locks B: overrides cleared, effective cost = profile rate.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ begin perform public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000fb', 3, true); end $$;
reset role;
do $$ declare v_old jsonb; v_actor uuid; begin
  if pg_temp.link_costs() <> 'drift-b-gone=9.000,drift-b-live=null,drift-b-off=null,drift-b-paused=null' then
    raise exception 'lock did not clear the non-deleted link overrides: %', pg_temp.link_costs();
  end if;
  if (select cost_percent from public.get_link_preview('drift-b-live')) <> 3 then
    raise exception 'effective cost after lock is not the profile rate: %', (select cost_percent from public.get_link_preview('drift-b-live'));
  end if;
  select old_value, actor_id into v_old, v_actor from audit_log
   where action = 'link.cost_cleared_by_lock' and subject_id = 'd1000000-0000-0000-0000-0000000000fb';
  if v_actor is distinct from 'd1000000-0000-0000-0000-0000000000cc'
     or jsonb_array_length(v_old->'links') <> 2
     or v_old::text not like '%drift-b-live%1.25%' or v_old::text not like '%drift-b-paused%2.5%' then
    raise exception 'lock clear audit missing or wrong: % %', v_actor, v_old;
  end if;
  raise notice 'ok: lock clears link overrides (active and paused, not deleted), effective cost = profile rate, old values audited';
end $$;

-- The link guard still refuses a locked owner (and the reseller) a link cost.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000fb'); end $$;
set local role authenticated;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$update payment_links set cost_percent = 0.5 where slug = 'drift-b-live'$q$, 'locked owner PATCH link cost after clear');
  if v not like '%locked%' then raise exception 'wrong refusal: %', v; end if;
  v := pg_temp.must_fail($q$select public.set_link_cost_percent(current_setting('drift.b_paused')::uuid, 0.5)$q$, 'locked owner RPC link cost');
  v := pg_temp.must_fail($q$insert into payment_links(user_id, slug, display_name, cost_percent) values (auth.uid(), 'drift-b-new', 'new', 0.5)$q$, 'locked owner insert with cost');
end $$;
reset role;
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$select public.set_link_cost_percent(current_setting('drift.b_live')::uuid, 0.5)$q$, 'reseller per-link price');
  if v not like '%another user%' then raise exception 'reseller per-link price refused for the wrong reason: %', v; end if;
  raise notice 'ok: link guard still blocks a locked owner, and reseller per-link pricing stays blocked';
end $$;
-- Unlock restores nothing.
do $$ begin perform public.reseller_lock_team_cost(3, false); end $$;
reset role;
do $$ begin
  if (select cost_locked from profiles where id = 'd1000000-0000-0000-0000-0000000000fb')
     or pg_temp.link_costs() <> 'drift-b-gone=9.000,drift-b-live=null,drift-b-off=null,drift-b-paused=null' then
    raise exception 'unlock restored link overrides or did not unlock: %', pg_temp.link_costs();
  end if;
  raise notice 'ok: unlocking does not restore old link overrides';
end $$;

-- Team lock clears too, including for a suspended team member.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000fb'); end $$;
set local role authenticated;
do $$ begin perform public.set_link_cost_percent(current_setting('drift.b_live')::uuid, 1.75); end $$;
reset role;
-- The clear exemption is for locked owners only: B is unlocked here, so
-- B's reseller still cannot clear (or price) B's link.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$select public.set_link_cost_percent(current_setting('drift.b_live')::uuid, null)$q$, 'reseller clears an unlocked member''s link');
  if v not like '%another user%' then raise exception 'refused for the wrong reason: %', v; end if;
  raise notice 'ok: no clear exemption for an unlocked owner''s link';
end $$;
reset role;
do $$ begin perform pg_temp.act(null); end $$;
update profiles set account_status = 'suspended' where id = 'd1000000-0000-0000-0000-0000000000fb';
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
set local role authenticated;
do $$ begin perform public.reseller_lock_team_cost(4, true); end $$;
reset role;
do $$ begin perform pg_temp.act(null); end $$;
update profiles set account_status = 'active' where id = 'd1000000-0000-0000-0000-0000000000fb';
do $$ begin
  if pg_temp.link_costs() <> 'drift-b-gone=9.000,drift-b-live=null,drift-b-off=null,drift-b-paused=null'
     or (select cost_percent from public.get_link_preview('drift-b-live')) <> 4 then
    raise exception 'team lock did not clear (suspended member): % / %', pg_temp.link_costs(), (select cost_percent from public.get_link_preview('drift-b-live'));
  end if;
  raise notice 'ok: team lock clears overrides, also for a suspended member; effective cost = team rate';
end $$;

-- Admin lock path clears too.
do $$ begin perform pg_temp.act(null); end $$;
insert into payment_links(user_id, slug, display_name, is_active, cost_percent) values
  ('d1000000-0000-0000-0000-0000000000f0', 'drift-o-live', 'O live', true, 2);
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$ begin perform public.reseller_set_freelancer_cost('d1000000-0000-0000-0000-0000000000f0', 6, true); end $$;
reset role;
do $$ begin
  if (select cost_percent from payment_links where slug = 'drift-o-live') is not null
     or (select cost_percent from public.get_link_preview('drift-o-live')) <> 6 then
    raise exception 'admin lock did not clear the link override';
  end if;
  raise notice 'ok: admin lock path clears link overrides';
end $$;
-- The exemption covers a pure clear only: with O locked and an admin-set
-- override, another user's definer path cannot clear AND change the link.
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000ad'); end $$;
set local role authenticated;
do $$ begin perform public.set_link_cost_percent((select id from payment_links where slug = 'drift-o-live'), 2); end $$;
reset role;
do $$ begin perform pg_temp.act('d1000000-0000-0000-0000-0000000000cc'); end $$;
do $$ declare v text; begin
  v := pg_temp.must_fail($q$update payment_links set cost_percent = null, display_name = 'taken over' where slug = 'drift-o-live'$q$, 'clear plus another change');
  if (select display_name || cost_percent::text from payment_links where slug = 'drift-o-live') <> 'O live2.000' then
    raise exception 'O''s link changed';
  end if;
  raise notice 'ok: the clear exemption allows nothing but clearing cost_percent';
end $$;

-- ============================================================
-- 5. get_my_analytics(): signed-in only
-- ============================================================
do $$ begin
  if has_function_privilege('anon', 'public.get_my_analytics()', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.get_my_analytics()'::regprocedure and a.grantee = 0)
     or not has_function_privilege('authenticated', 'public.get_my_analytics()', 'execute') then
    raise exception 'get_my_analytics grants wrong: %', (select proacl from pg_proc where oid = 'public.get_my_analytics()'::regprocedure);
  end if;
  raise notice 'ok: get_my_analytics is authenticated + service_role only';
end $$;

-- ============================================================
-- 6. telegram_context(): service role only
-- ============================================================
do $$ begin
  if to_regprocedure('public.telegram_context(text, integer)') is null then
    raise exception 'telegram_context missing';
  end if;
  if has_function_privilege('anon', 'public.telegram_context(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.telegram_context(text, integer)', 'execute')
     or not has_function_privilege('service_role', 'public.telegram_context(text, integer)', 'execute') then
    raise exception 'telegram_context must be service-role only';
  end if;
end $$;
set local role service_role;
do $$ declare v jsonb; begin
  v := public.telegram_context('7d', 7);
  if not (v ? 'global' and v ? 'daily' and v->>'range' = '7d') then raise exception 'telegram_context result wrong: %', v; end if;
  raise notice 'ok: telegram_context is service-role only and still works';
end $$;
reset role;
set local role authenticated;
do $$ declare v text; begin
  perform pg_temp.act('d1000000-0000-0000-0000-0000000000ad');
  v := pg_temp.must_fail($q$select public.telegram_context('today', 1)$q$, 'admin telegram_context');
end $$;
reset role;

select 'production drift checks passed' as result;
