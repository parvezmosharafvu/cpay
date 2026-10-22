-- Run ONLY on the disposable CI PostgreSQL database after all migrations.
-- Rehearse the proposed search_path hardening with a complete rollback:
-- do not change the existing (already applied) migration, production grants,
-- user payment rows, or the final CI schema.
BEGIN;

CREATE TEMP TABLE cpay_forward_guard_probe (id integer PRIMARY KEY);
CREATE TRIGGER cpay_forward_guard_probe_no_delete
  BEFORE DELETE ON pg_temp.cpay_forward_guard_probe
  FOR EACH ROW EXECUTE FUNCTION public.payment_forwards_no_delete();

INSERT INTO pg_temp.cpay_forward_guard_probe(id) VALUES (1);

-- Positive control: the installed original trigger rejects deletion.
DO $check$
BEGIN
  BEGIN
    DELETE FROM pg_temp.cpay_forward_guard_probe WHERE id = 1;
    RAISE EXCEPTION 'forward guard allowed deletion before hardening';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'payment_forwards rows are never deleted' THEN
      RAISE;
    END IF;
  END;
END
$check$;

-- Match the reviewed, minimal future change. No role or body is altered.
ALTER FUNCTION public.payment_forwards_no_delete() SET search_path = '';

DO $check$
DECLARE
  valid_function boolean;
BEGIN
  SELECT NOT p.prosecdef
         AND p.proconfig @> ARRAY['search_path=']::text[]
         AND pg_get_function_result(p.oid) = 'trigger'
    INTO valid_function
  FROM pg_proc p
  WHERE p.oid = 'public.payment_forwards_no_delete()'::regprocedure;

  IF valid_function IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'forward delete trigger lost SECURITY INVOKER, pinned empty search_path, or trigger return type';
  END IF;

  BEGIN
    DELETE FROM pg_temp.cpay_forward_guard_probe WHERE id = 1;
    RAISE EXCEPTION 'forward guard allowed deletion after search_path hardening';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'payment_forwards rows are never deleted' THEN
      RAISE;
    END IF;
  END;

  IF NOT EXISTS (SELECT 1 FROM pg_temp.cpay_forward_guard_probe WHERE id = 1) THEN
    RAISE EXCEPTION 'forward guard removed a row despite raising its expected error';
  END IF;
END
$check$;

ROLLBACK;
