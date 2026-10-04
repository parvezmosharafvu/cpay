-- ============================================================
-- Which SECURITY DEFINER functions can a signed-in user call?
-- ============================================================
-- The anon check (ci/anon_rpc_allowlist.sql) never looked at the
-- authenticated role, and that is how attach_freelancer_to_reseller()
-- shipped callable by every signed-in user: its migration revoked PUBLIC
-- and anon, and Supabase's default privileges left authenticated in place.
--
-- Run against the database built with Supabase's default privileges. Rules:
--
--   1. Internal functions are not executable by anon, authenticated or
--      PUBLIC, and stay executable by service_role.
--   2. STRICT ALLOWLIST: the set of SECURITY DEFINER functions authenticated
--      can execute must equal ci/authenticated_rpc_allowlist.sql exactly.
--      New functions fail until reviewed; removed ones fail until the entry
--      is deleted.
--   3. TRIPWIRE (not an authorization proof): each entry's body, with
--      comments stripped, must still mention the check its kind implies.
--      A string literal or an unrelated use of the token would satisfy it;
--      it only catches gross drift such as a guard being deleted.
--
-- Behaviour is tested by ci/authenticated_rpc_sweep_test.sql (every listed
-- function called as a non-owner) and ci/reseller_authz_test.sql (M1-M3).
-- ============================================================
\set ON_ERROR_STOP on
\ir authenticated_rpc_allowlist.sql

do $$
declare
  v_bad text;
begin
  -- 1. Internal functions.
  select string_agg(i.signature || ' [' || r.rolname || ']', ', ' order by i.signature, r.rolname)
    into v_bad
    from internal_only i
    cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
   where has_function_privilege(r.rolname, ('public.' || i.signature)::regprocedure, 'execute');
  if v_bad is not null then
    raise exception 'internal function(s) executable by a client role: %. Revoke EXECUTE from public, anon, authenticated.', v_bad;
  end if;

  select string_agg(i.signature, ', ' order by i.signature)
    into v_bad
    from internal_only i
    join pg_proc p on p.oid = ('public.' || i.signature)::regprocedure
    cross join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where a.grantee = 0 and a.privilege_type = 'EXECUTE';
  if v_bad is not null then
    raise exception 'internal function(s) executable by PUBLIC: %', v_bad;
  end if;

  select string_agg(i.signature, ', ' order by i.signature)
    into v_bad
    from internal_only i
   where not has_function_privilege('service_role', ('public.' || i.signature)::regprocedure, 'execute');
  if v_bad is not null then
    raise exception 'service_role lost EXECUTE on internal function(s): %', v_bad;
  end if;

  -- 2. Strict allowlist, both directions.
  select string_agg(f.signature, ', ' order by f.signature)
    into v_bad
    from authenticated_definer_functions f
   where f.signature not in (select signature from authenticated_rpc_allowlist);
  if v_bad is not null then
    raise exception 'authenticated can EXECUTE unreviewed SECURITY DEFINER function(s): %. Review each one, then add it to ci/authenticated_rpc_allowlist.sql with its kind and a reason, or revoke EXECUTE from authenticated.', v_bad;
  end if;

  select string_agg(a.signature, ', ' order by a.signature)
    into v_bad
    from authenticated_rpc_allowlist a
   where a.signature not in (select signature from authenticated_definer_functions);
  if v_bad is not null then
    raise exception 'stale ci/authenticated_rpc_allowlist.sql entries (missing, not SECURITY DEFINER, or no longer executable by authenticated): %', v_bad;
  end if;

  -- 3. Tripwire.
  select string_agg(a.signature || ' (' || a.kind || ')', ', ' order by a.signature)
    into v_bad
    from authenticated_rpc_allowlist a
    join authenticated_definer_functions f using (signature)
   where case a.kind
           when 'admin'         then f.src !~ 'is_admin\(\)'
           when 'self'          then f.src !~ 'auth\.uid\(\)'
           when 'self_or_admin' then f.src !~ 'auth\.uid\(\)' or f.src !~ 'is_admin\(\)'
           when 'reseller'      then f.src !~ '(is_reseller\(\)|is_moderator\(\)|reseller_owns\()'
           else false
         end;
  if v_bad is not null then
    raise exception 'tripwire: these bodies (comments stripped) no longer mention the caller check their kind implies: %. Re-review the function and fix it or its allowlist kind.', v_bad;
  end if;
end $$;

\echo 'Reviewed SECURITY DEFINER functions executable by authenticated, by kind:'
select kind, count(*) from authenticated_rpc_allowlist group by kind order by kind;

select 'authenticated RPC allowlist check passed (strict list + tripwire; behaviour is tested separately)' as result;
