-- ============================================================
-- attach_freelancer_to_reseller(): two concurrent calls, one freelancer
-- ============================================================
-- Deterministic race. Session A attaches freelancer F to reseller R1 and
-- keeps its transaction open. Session B (a second connection via dblink)
-- tries to attach F to R2. The test waits until B is blocked by A on F's
-- row lock, commits A, then reads B's result.
--
-- Expected: B returns false and writes nothing, so F has exactly one
-- reseller (referred_by = R1) and one assignment (R1). A version without
-- the row lock (check, then update, then insert) lets B insert a second
-- assignment for R2 after A commits.
--
-- Both calls run with no session (auth.uid() is null in ci/bootstrap.sql),
-- the signup/service-role path the function allows. The fixtures must be
-- committed for B to see them, so they are removed at the end.
-- Needs the dblink extension (postgres contrib, in the CI image); it is
-- dropped again afterwards if this test created it.
-- ============================================================
\set ON_ERROR_STOP on

select not exists (select 1 from pg_extension where extname = 'dblink') as created_dblink \gset
create extension if not exists dblink;
select format('dbname=%s host=localhost user=postgres password=postgres', current_database()) as conninfo \gset

insert into auth.users(id, email) values
  ('5c000000-0000-0000-0000-0000000000a1', 'race-reseller-1@test.invalid'),
  ('5c000000-0000-0000-0000-0000000000a2', 'race-reseller-2@test.invalid'),
  ('5c000000-0000-0000-0000-0000000000f1', 'race-freelancer@test.invalid');
update profiles set role = 'moderator', account_status = 'active'
 where id in ('5c000000-0000-0000-0000-0000000000a1', '5c000000-0000-0000-0000-0000000000a2');
update profiles set role = 'creator', account_status = 'active'
 where id = '5c000000-0000-0000-0000-0000000000f1';

select dblink_connect('race_b', :'conninfo');
select pid as b_pid from dblink('race_b', 'select pg_backend_pid()') as t(pid int) \gset

-- Session A: attach F to R1 and hold the transaction open.
begin;
do $$
begin
  if not public.attach_freelancer_to_reseller('5c000000-0000-0000-0000-0000000000f1', '5c000000-0000-0000-0000-0000000000a1') then
    raise exception 'session A: attach to R1 returned false';
  end if;
end $$;

-- Session B: attach F to R2, asynchronously.
select dblink_send_query('race_b',
  $q$select public.attach_freelancer_to_reseller('5c000000-0000-0000-0000-0000000000f1', '5c000000-0000-0000-0000-0000000000a2')$q$);

-- Wait (up to 10 s) until B is blocked by A.
select set_config('race.b_pid', :'b_pid', false);
do $$
declare
  v_b int := current_setting('race.b_pid')::int;
  v_a int := pg_backend_pid();
  v_tries int := 0;
begin
  while not (pg_blocking_pids(v_b) @> array[v_a]) loop
    v_tries := v_tries + 1;
    if v_tries > 200 then
      raise exception 'session B never blocked on session A (blocking pids: %)', pg_blocking_pids(v_b);
    end if;
    perform pg_sleep(0.05);
  end loop;
  raise notice 'ok: session B is waiting for session A''s lock on the freelancer row';
end $$;

commit;

-- B resumes after A commits.
create temp table race_b_result as
select ok from dblink_get_result('race_b') as t(ok boolean);
select * from dblink_get_result('race_b') as t(ok boolean);  -- drain
select dblink_disconnect('race_b');

do $$
declare
  v_b boolean := (select ok from race_b_result);
  v_ref uuid := (select referred_by from profiles where id = '5c000000-0000-0000-0000-0000000000f1');
  v_assigned text := (select string_agg(moderator_id::text, ',' order by moderator_id)
                        from moderator_assignments where creator_id = '5c000000-0000-0000-0000-0000000000f1');
begin
  if v_b is distinct from false then
    raise exception 'session B returned % (expected false: F already belongs to R1)', v_b;
  end if;
  if v_ref is distinct from '5c000000-0000-0000-0000-0000000000a1' then
    raise exception 'F.referred_by is %, expected R1', v_ref;
  end if;
  if v_assigned is distinct from '5c000000-0000-0000-0000-0000000000a1' then
    raise exception 'F is assigned to %, expected only R1', v_assigned;
  end if;
  raise notice 'ok: concurrent attach left F with one reseller and one assignment';
end $$;

-- Clean up the committed fixtures (F first: referred_by points at R1).
delete from auth.users where id = '5c000000-0000-0000-0000-0000000000f1';
delete from auth.users where id in ('5c000000-0000-0000-0000-0000000000a1', '5c000000-0000-0000-0000-0000000000a2');
select :'created_dblink'::boolean as drop_dblink \gset
\if :drop_dblink
drop extension dblink;
\endif

select 'attach_freelancer_to_reseller concurrency check passed' as result;
