-- Emergency stops are JSON booleans only (20261014010000). The SQL
-- withdrawal paths compare value::text = 'true', so a JSON string "true"
-- would leave withdrawals running while the admin panel showed "On".
-- BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
do $$
declare k text;
begin
  -- Why: the string form does not match the SQL check.
  if ('"true"'::jsonb)::text = 'true' then raise exception 'premise changed: "true"::jsonb::text equals true'; end if;
  if ('true'::jsonb)::text <> 'true' then raise exception 'premise changed: true::jsonb::text'; end if;

  foreach k in array array['emergency_payments_stop', 'emergency_withdrawals_stop'] loop
    insert into app_settings(key, value) values (k, 'false'::jsonb)
      on conflict (key) do update set value = 'false'::jsonb;

    -- Booleans are accepted.
    update app_settings set value = 'true'::jsonb where key = k;
    update app_settings set value = to_jsonb(false) where key = k;

    -- Strings, numbers, null and objects are refused.
    begin
      update app_settings set value = '"true"'::jsonb where key = k;
      raise exception 'string "true" accepted for %', k;
    exception when check_violation then null; end;
    begin
      update app_settings set value = '"false"'::jsonb where key = k;
      raise exception 'string "false" accepted for %', k;
    exception when check_violation then null; end;
    begin
      update app_settings set value = '1'::jsonb where key = k;
      raise exception 'number accepted for %', k;
    exception when check_violation then null; end;
    begin
      update app_settings set value = 'null'::jsonb where key = k;
      raise exception 'json null accepted for %', k;
    exception when check_violation then null; end;
    begin
      update app_settings set value = '{"value": true}'::jsonb where key = k;
      raise exception 'object accepted for %', k;
    exception when check_violation then null; end;
    begin
      delete from app_settings where key = k;
      insert into app_settings(key, value) values (k, '"true"'::jsonb);
      raise exception 'insert of string "true" accepted for %', k;
    exception when check_violation then null; end;
  end loop;

  -- Other settings keep any JSON type.
  insert into app_settings(key, value) values ('ci_emergency_type_other', '"true"'::jsonb)
    on conflict (key) do update set value = excluded.value;

  -- With a boolean stop, the withdrawal-path check sees it.
  update app_settings set value = 'true'::jsonb where key = 'emergency_withdrawals_stop';
  if coalesce((select value::text from app_settings where key = 'emergency_withdrawals_stop'), 'false') <> 'true' then
    raise exception 'boolean true not seen by the withdrawal check';
  end if;
  raise notice 'ok: emergency stops accept only JSON booleans';
end;
$$;
rollback;
