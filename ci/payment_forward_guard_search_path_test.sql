-- Run ONLY on disposable CI PostgreSQL after every migration is applied.
-- Verify the actual migration pins an empty search_path, then prove the
-- delete guard survives an idempotent ALTER within a rolled-back transaction.
-- No production connection, live payment rows or persistent CI changes.
BEGIN;

CREATE TEMP TABLE cpay_forward_guard_probe (id integer PRIMARY KEY);
CREATE TRIGGER cpay_forward_guard_probe_no_delete
  BEFORE DELETE ON pg_temp.cpay_forward_guard_probe
  FOR EACH ROW EXECUTE FUNCTION public.payment_forwards_no_delete();

INSERT INTO pg_temp.cpay_forward_guard_probe(id) VALUES (1);

-- The current source migration must already have pinned the path.
-- Prevent a false green caused solely by the later rehearsal ALTER.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.oid = 'public.payment_forwards_no_delete()'::regprocedure
      AND NOT p.prosecdef
      AND pg_get_function_result(p.oid) = 'trigger'
      AND EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS cfg
        WHERE cfg LIKE 'search_path=%'
      )
  ) THEN
    RAISE EXCEPTION 'forward delete guard migration did not pin search_path';
  END IF;
END
$check$;

-- Positive control: the migrated trigger rejects deletion.
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

-- Reapplying the same setting is idempotent. No role or body is altered.
ALTER FUNCTION public.payment_forwards_no_delete() SET search_path = '';

DO $check$
DECLARE
  valid_function boolean;
BEGIN
  SELECT NOT p.prosecdef
         -- pg_proc may normalize the empty GUC as search_path="" rather
         -- than search_path=; inspect the setting by key, not serialization.
         AND EXISTS (
           SELECT 1 FROM unnest(p.proconfig) AS cfg
           WHERE cfg LIKE 'search_path=%'
         )
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
