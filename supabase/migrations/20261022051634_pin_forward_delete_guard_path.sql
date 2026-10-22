-- Pin the only mutable search_path function reported in the 2026-10-22
-- CPAY Supabase Security Advisor review.
--
-- This migration keeps the trigger's body, privileges, SECURITY INVOKER
-- mode and delete-prevention behavior unchanged. Do not change or rename
-- an already applied migration. Apply only through normal reviewed release
-- procedures after production approval.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = to_regprocedure('public.payment_forwards_no_delete()')
      AND NOT p.prosecdef
      AND pg_get_function_result(p.oid) = 'trigger'
  ) THEN
    RAISE EXCEPTION
      'payment_forwards_no_delete is missing or has changed its security mode/return type';
  END IF;
END
$check$;

-- This function only raises an error and has no unqualified table, function,
-- or other schema references. An empty search_path is therefore safe.
ALTER FUNCTION public.payment_forwards_no_delete() SET search_path = '';
