-- Machine-readable final-state inventory of the public schema (and cron /
-- realtime). Read-only. Output: one JSON document. Used to compare a fresh
-- migration replay with production (same query, read-only role).
select jsonb_pretty(jsonb_build_object(
 'tables', (select jsonb_agg(jsonb_build_object('t',c.relname,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner)) order by c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 'columns', (select jsonb_agg(table_name||'.'||column_name||':'||data_type||case when is_nullable='NO' then ' not null' else '' end order by table_name,ordinal_position)
   from information_schema.columns where table_schema='public' and table_name in (select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p'))),
 'constraints', (select jsonb_agg(conrelid::regclass||'.'||conname||':'||contype::text order by 1) from pg_constraint where connamespace='public'::regnamespace and conrelid<>0),
 'functions', (select jsonb_agg(jsonb_build_object('f',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,
      'search_path',(select string_agg(x,',') from unnest(p.proconfig) x where x like 'search_path=%'),
      'anon_exec',has_function_privilege('anon',p.oid,'execute'),'auth_exec',has_function_privilege('authenticated',p.oid,'execute')) order by p.oid::regprocedure::text)
   from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
     and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')),
 'policies', (select jsonb_agg(tablename||'.'||policyname||' '||cmd||' '||array_to_string(roles,',') order by tablename,policyname) from pg_policies where schemaname='public'),
 'triggers', (select jsonb_agg(tgrelid::regclass||'.'||tgname order by 1) from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace)),
 'cron', (select jsonb_agg(jobname||' '||schedule order by jobname) from cron.job),
 'realtime', (select jsonb_agg(schemaname||'.'||tablename order by 1) from pg_publication_tables where pubname='supabase_realtime'),
 'anon_table_privs', (select jsonb_agg(table_name||':'||privilege_type order by 1) from information_schema.role_table_grants where grantee='anon' and table_schema='public'),
 'authenticated_table_privs', (select jsonb_agg(table_name||':'||privilege_type order by 1) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public'),
 'legacy_objects', (select jsonb_agg(x order by x) from (
     select 'rel:'||relname x from pg_class where relnamespace='public'::regnamespace and relname ~* '(btcpay|reseller|commission|moderator)'
     union all select 'fn:'||oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname ~* '(btcpay|reseller|commission|moderator)'
     union all select 'col:'||table_name||'.'||column_name from information_schema.columns where table_schema='public' and column_name ~* '(btcpay|reseller|commission|moderator)') s),
 'role_values', (select jsonb_agg(distinct pg_get_constraintdef(oid)) from pg_constraint where conrelid='public.profiles'::regclass and pg_get_constraintdef(oid) ilike '%role%')
)) as inventory;
