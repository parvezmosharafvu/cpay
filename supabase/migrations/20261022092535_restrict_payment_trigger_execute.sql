-- CPAY 2026-10-22: harden eight already-installed payment-protection
-- SECURITY DEFINER triggers. Only function EXECUTE ACLs change; function
-- bodies, trigger bindings, RLS, settlement and payment logic are untouched.
-- Source migration only: production changes need the owner's release approval.
DO $lock$
DECLARE
  name text;
  sig regprocedure;
  trigger_count integer;
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
      RAISE EXCEPTION 'security trigger %.() missing — release migration refused', name;
    END IF;
    SELECT count(*) INTO trigger_count
      FROM pg_trigger t WHERE t.tgfoid = sig AND NOT t.tgisinternal;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = sig AND p.prosecdef AND p.prorettype = 'trigger'::regtype
    ) OR trigger_count < 1 THEN
      RAISE EXCEPTION 'security trigger %.() has changed its return type, security mode or binding', name;
    END IF;

    -- PUBLIC is the inherited default; revoke it as well as direct grants.
    -- Trigger execution itself is not a REST RPC and its bindings persist.
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated', name);
    IF has_function_privilege('anon', sig, 'EXECUTE')
       OR has_function_privilege('authenticated', sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'trigger %.() remains exposed to a client role', name;
    END IF;
  END LOOP;
END
$lock$;
