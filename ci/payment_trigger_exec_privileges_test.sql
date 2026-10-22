-- Run on disposable PostgreSQL after every migration; test with the
-- production-like Supabase default EXECUTE grants in privcheck as well.
-- This asserts trigger bindings were retained and elevated trigger code
-- cannot be directly invoked by public client roles.
\set ON_ERROR_STOP on
DO $check$
DECLARE
  name text;
  sig regprocedure;
  missing text := '';
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'gate_custodial_payment',
    'gate_custodial_withdrawal',
    'gate_new_custodial_link',
    'guard_direct_payment_changes',
    'guard_direct_settlement_switch',
    'guard_link_settlement_mode',
    'guard_payment_settlement_mode',
    'guard_settlement_destination_changes'
  ] LOOP
    sig := to_regprocedure(format('public.%I()', name));
    IF sig IS NULL THEN
      RAISE EXCEPTION 'missing security trigger function: %', name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid = sig
      AND p.prosecdef AND p.prorettype = 'trigger'::regtype
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_trigger t WHERE t.tgfoid = sig AND NOT t.tgisinternal
    ) THEN
      RAISE EXCEPTION 'security trigger changed or became unbound: %', name;
    END IF;
    IF has_function_privilege('anon', sig, 'EXECUTE')
      OR has_function_privilege('authenticated', sig, 'EXECUTE')
      OR EXISTS (
        SELECT 1 FROM pg_proc p,
        LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = sig AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
      ) THEN
      RAISE EXCEPTION 'SECURITY DEFINER trigger executable by a public client role: %', name;
    END IF;
  END LOOP;
END
$check$;

SELECT 'payment trigger function privileges restricted without unbinding triggers' AS result;
