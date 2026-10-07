-- ============================================================
-- Money is exact: no float column or float cast anywhere in public.
-- ============================================================
-- Ledger, fee and withdrawal math is numeric (SQL) or integer cents /
-- sats (JS). A double precision / real / money column, or a ::float cast
-- inside a public function, would reintroduce binary rounding. Fails the
-- build if one appears.
\set ON_ERROR_STOP on
do $$
declare v text;
begin
  select string_agg(table_name || '.' || column_name || ' ' || data_type, ', ') into v
    from information_schema.columns
   where table_schema = 'public' and data_type in ('double precision', 'real', 'money');
  if v is not null then raise exception 'float/money-typed columns in public: %', v; end if;

  select string_agg(p.proname, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~* '(::\s*(float|float4|float8|real|double precision)\M|\mdouble precision\M)';
  if v is not null then raise exception 'public functions using float arithmetic: %', v; end if;

  -- The rounding contract the payment service mirrors (splitFeeCents).
  if round(100.00 * (1 - 2.125 / 100), 2) <> 97.88 then raise exception 'numeric half-up rounding changed'; end if;
end $$;
select 'money types check passed' as result;
