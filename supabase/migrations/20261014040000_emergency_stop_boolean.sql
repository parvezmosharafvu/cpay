-- Emergency stops must be stored as JSON booleans.
--
-- create-invoice treats both true and "true" as "stopped", and so does the
-- admin panel's On/Off label. Every SQL withdrawal path instead checks
--   coalesce((select value::text from app_settings where key='emergency_withdrawals_stop'),'false') = 'true'
-- and the text form of the JSON string "true" is '"true"', not 'true'. A
-- value written by hand as a JSON string would show "On" in the admin panel
-- and stop new payments while every withdrawal path kept running.
--
-- admin_set_feature_toggle() already writes to_jsonb(boolean). This refuses
-- anything else for the two emergency keys (direct PostgREST writes by an
-- admin, the SQL editor, a future migration). Production rows were checked
-- read-only on 2026-10-14: both are jsonb_typeof = 'boolean'.
--
-- Schema-only: no row is changed. If a non-boolean row exists the migration
-- stops with a clear message instead of guessing what was meant.
do $$
begin
  if exists (
    select 1 from public.app_settings
    where key in ('emergency_payments_stop', 'emergency_withdrawals_stop')
      and jsonb_typeof(value) <> 'boolean'
  ) then
    raise exception 'app_settings has a non-boolean emergency stop; set it with admin_set_feature_toggle() first';
  end if;
end;
$$;

alter table public.app_settings
  drop constraint if exists app_settings_emergency_stop_boolean;
alter table public.app_settings
  add constraint app_settings_emergency_stop_boolean
  check (
    key not in ('emergency_payments_stop', 'emergency_withdrawals_stop')
    or jsonb_typeof(value) = 'boolean'
  );
