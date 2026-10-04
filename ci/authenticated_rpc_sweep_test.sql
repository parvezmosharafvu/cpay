-- ============================================================
-- Behavioural sweep: every reviewed SECURITY DEFINER function, called by
-- a signed-in user who does not own the victim's data
-- ============================================================
-- For each function in ci/authenticated_rpc_allowlist.sql, as two
-- attackers (a plain freelancer, and a reseller whose team does not include
-- the victim), call it with all-NULL arguments and again with each uuid
-- argument set to one of the victim's ids (user, reseller, link, payment,
-- support message, wallet). A call passes when it is refused (any error)
-- or when it returns none of the victim's identifiers and leaves the
-- victim's rows unchanged. Admin-kind functions must additionally return
-- nothing for a non-admin (error, null, false or empty).
--
-- This is broad, not deep: NULL/foreign-id calls do not reach every code
-- path. It complements the targeted tests (ci/reseller_authz_test.sql for
-- M1-M3, revenue_desk_access_test.sql, dashboards_test.sql, ...).
-- Public-kind functions are called with NULLs only: they return public
-- data by id on purpose. Runs inside BEGIN/ROLLBACK.
-- ============================================================
\set ON_ERROR_STOP on
\ir authenticated_rpc_allowlist.sql
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Victim reseller r1 with freelancer vf (referred and assigned). Attackers:
-- plain freelancer ax, reseller ar (no team).
insert into auth.users(id, email) values
  ('5b000000-0000-0000-0000-0000000000a1', 'sweep-victim-reseller@test.invalid'),
  ('5b000000-0000-0000-0000-0000000000f1', 'sweep-victim-freelancer@test.invalid'),
  ('5b000000-0000-0000-0000-0000000000e1', 'sweep-attacker-freelancer@test.invalid'),
  ('5b000000-0000-0000-0000-0000000000e2', 'sweep-attacker-reseller@test.invalid');
update profiles set account_status = 'active' where id::text like '5b000000-%';
update profiles set role = 'moderator' where id in ('5b000000-0000-0000-0000-0000000000a1', '5b000000-0000-0000-0000-0000000000e2');
update profiles set referred_by = '5b000000-0000-0000-0000-0000000000a1' where id = '5b000000-0000-0000-0000-0000000000f1';
insert into moderator_assignments(moderator_id, creator_id)
values ('5b000000-0000-0000-0000-0000000000a1', '5b000000-0000-0000-0000-0000000000f1');
insert into payment_links(id, user_id, slug)
values ('5b000000-0000-0000-0000-0000000001f1', '5b000000-0000-0000-0000-0000000000f1', 'sweep-victim-link');
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref, customer_city)
values ('5b000000-0000-0000-0000-0000000002f1', '5b000000-0000-0000-0000-0000000000f1', '5b000000-0000-0000-0000-0000000001f1',
        50, 'lightning', 'new', now() + interval '15 min', 'sweep-victim-invoice-ref', 'SweepVictimCity');
update payments set status = 'settled', amount_settled = 50, settled_at = now() where id = '5b000000-0000-0000-0000-0000000002f1';
insert into support_messages(id, user_id, sender, message)
values ('5b000000-0000-0000-0000-0000000003f1', '5b000000-0000-0000-0000-0000000000f1', 'creator', 'sweep victim message');
insert into usdt_wallets(id, user_id, network, address)
values ('5b000000-0000-0000-0000-0000000004f1', '5b000000-0000-0000-0000-0000000000f1', 'trc20', 'TSweepVictimWa11etAddressXXXXXXXXX');

-- Strings that must never come back to an attacker.
create temp table sweep_markers(m text primary key);
insert into sweep_markers values
  ('5b000000-0000-0000-0000-0000000000a1'), ('5b000000-0000-0000-0000-0000000000f1'),
  ('5b000000-0000-0000-0000-0000000001f1'), ('5b000000-0000-0000-0000-0000000002f1'),
  ('5b000000-0000-0000-0000-0000000003f1'), ('5b000000-0000-0000-0000-0000000004f1'),
  ('sweep-victim-reseller@test.invalid'), ('sweep-victim-freelancer@test.invalid'),
  ('sweep-victim-invoice-ref'), ('SweepVictimCity'), ('TSweepVictimWa11etAddressXXXXXXXXX'),
  ('sweep victim message');

-- uuid values tried in each uuid argument.
create temp table sweep_ids(id uuid primary key);
insert into sweep_ids select m::uuid from sweep_markers where m ~ '^5b000000-';

-- Fingerprint of everything the victims own.
create function pg_temp.victim_state() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from profiles t where t.id::text like '5b000000-0000-0000-0000-0000000000a1' or t.id::text like '5b000000-0000-0000-0000-0000000000f1'),
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from payment_links t where t.user_id::text like '5b000000-0000-0000-0000-0000000000_1'),
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from payments t where t.user_id::text like '5b000000-0000-0000-0000-0000000000_1'),
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from support_messages t where t.user_id::text like '5b000000-0000-0000-0000-0000000000_1'),
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from usdt_wallets t where t.user_id::text like '5b000000-0000-0000-0000-0000000000_1'),
    (select string_agg(to_jsonb(t)::text, ',' order by t.creator_id) from moderator_assignments t where t.moderator_id = '5b000000-0000-0000-0000-0000000000a1'),
    (select string_agg(to_jsonb(t)::text, ',' order by t.id) from withdrawals t where t.user_id::text like '5b000000-0000-0000-0000-0000000000_1')
  ))
$$;

create temp table sweep_results(attacker text, signature text, kind text, call text, outcome text, detail text);

do $$
declare
  v_baseline text := pg_temp.victim_state();
  v_attacker text;
  f record;
  v_types oid[];
  v_args text[];
  v_variants text[];
  v_call text;
  v_sql text;
  v_out text;
  v_err text;
  i int;
  j int;
  v_id uuid;
  v_hit text;
begin
  foreach v_attacker in array array['5b000000-0000-0000-0000-0000000000e1', '5b000000-0000-0000-0000-0000000000e2'] loop
    for f in
      select a.signature, a.kind, p.oid, p.proname, p.proargtypes, p.proretset, p.prorettype
        from authenticated_rpc_allowlist a
        join pg_proc p on p.oid = ('public.' || a.signature)::regprocedure
       order by a.signature
    loop
      v_types := string_to_array(nullif(f.proargtypes::text, ''), ' ')::oid[];
      v_variants := array[]::text[];

      -- variant 0: every argument NULL
      v_args := array[]::text[];
      for i in 1 .. coalesce(array_length(v_types, 1), 0) loop
        v_args := v_args || format('NULL::%s', format_type(v_types[i], null));
      end loop;
      v_variants := v_variants || array_to_string(v_args, ', ');

      -- variants 1..n: one uuid / uuid[] argument set to a victim id
      if f.kind <> 'public' then
        for i in 1 .. coalesce(array_length(v_types, 1), 0) loop
          if v_types[i] in ('uuid'::regtype, 'uuid[]'::regtype) then
            for v_id in select id from sweep_ids loop
              v_args := array[]::text[];
              for j in 1 .. array_length(v_types, 1) loop
                if j = i and v_types[j] = 'uuid'::regtype then
                  v_args := v_args || format('%L::uuid', v_id);
                elsif j = i then
                  v_args := v_args || format('array[%L]::uuid[]', v_id);
                else
                  v_args := v_args || format('NULL::%s', format_type(v_types[j], null));
                end if;
              end loop;
              v_variants := v_variants || array_to_string(v_args, ', ');
            end loop;
          end if;
        end loop;
      end if;

      foreach v_call in array v_variants loop
        v_call := format('public.%I(%s)', f.proname, v_call);
        if f.prorettype = 'void'::regtype then
          v_sql := format('select ''void'' from (select %s) s', v_call);
        else
          v_sql := format('select coalesce(jsonb_agg(to_jsonb(x))::text, '''') from %s x', v_call);
        end if;

        perform set_config('request.jwt.claim.sub', v_attacker, true);
        perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_attacker)::text, true);
        v_out := null; v_err := null;
        begin
          execute 'set local role authenticated';
          execute v_sql into v_out;
          execute 'reset role';
        exception when others then
          v_err := sqlerrm;
        end;
        perform set_config('request.jwt.claim.sub', '', true);

        if v_err is not null then
          insert into sweep_results values (v_attacker, f.signature, f.kind, v_call, 'refused', left(v_err, 120));
          continue;
        end if;

        select string_agg(m, ', ') into v_hit from sweep_markers where position(lower(m) in lower(coalesce(v_out, ''))) > 0;
        if v_hit is not null then
          insert into sweep_results values (v_attacker, f.signature, f.kind, v_call, 'LEAK', v_hit);
        elsif pg_temp.victim_state() <> v_baseline then
          insert into sweep_results values (v_attacker, f.signature, f.kind, v_call, 'CHANGED_VICTIM', null);
          v_baseline := pg_temp.victim_state();
        elsif f.kind = 'admin' and coalesce(v_out, '') not in ('', 'void', '[null]', '[false]', '[]') then
          insert into sweep_results values (v_attacker, f.signature, f.kind, v_call, 'ADMIN_RETURNED_DATA', left(v_out, 120));
        else
          insert into sweep_results values (v_attacker, f.signature, f.kind, v_call, 'ok', left(v_out, 60));
        end if;
      end loop;
    end loop;
  end loop;
end $$;

\echo 'Sweep outcomes:'
select outcome, count(*) as calls, count(distinct signature) as functions from sweep_results group by outcome order by outcome;

\echo 'Failures (must be empty):'
select attacker, signature, outcome, call, detail from sweep_results
 where outcome not in ('refused', 'ok') order by signature, attacker;

do $$
declare
  v_fail int;
  v_listed int;
  v_swept int;
begin
  select count(*) into v_fail from sweep_results where outcome not in ('refused', 'ok');
  select count(*) into v_listed from authenticated_rpc_allowlist;
  select count(distinct signature) into v_swept from sweep_results;
  if v_swept <> v_listed then
    raise exception 'sweep covered % of % allowlisted functions', v_swept, v_listed;
  end if;
  if v_fail > 0 then
    raise exception '% sweep call(s) leaked victim data, changed victim rows, or returned admin data to a non-admin (see the list above)', v_fail;
  end if;
end $$;

rollback;
select 'authenticated RPC behavioural sweep passed' as result;
