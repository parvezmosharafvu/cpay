-- 20261028020000: service_role may write only the admin Edge Functions' own
-- audit rows (each with its subject type and an actor); everything else from
-- it, and anything from clients, is still refused; the log stays
-- append-only. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id, email) values ('e8000000-0000-0000-0000-0000000000a1', 'audit-admin@test.invalid');
grant insert, select on public.audit_log to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;

set local role service_role;
insert into audit_log(actor_id, action, subject_type, subject_id, new_value)
values ('e8000000-0000-0000-0000-0000000000a1', 'settings.secret', 'settings', 'supabase:X', '{"action":"set"}'),
       ('e8000000-0000-0000-0000-0000000000a1', 'settings.cloudflare', 'settings', 'always_use_https', '{"on":true}'),
       ('e8000000-0000-0000-0000-0000000000a1', 'settings.signup_email_confirmation', 'settings', 'auth', '{}'),
       ('e8000000-0000-0000-0000-0000000000a1', 'withdrawal.rejected_by_admin', 'withdrawal', '1', '{}'),
       ('e8000000-0000-0000-0000-0000000000a1', 'withdrawal.marked_paid_manual', 'withdrawal', '2', '{}');
do $$ begin
  insert into audit_log(action, subject_type, subject_id) values ('settings.secret', 'settings', 'no actor');
  raise exception 'row without an actor accepted';
exception when raise_exception then if sqlerrm not like 'audit_log accepts writes only%' then raise; end if; end $$;
do $$ begin
  insert into audit_log(actor_id, action, subject_type) values ('e8000000-0000-0000-0000-0000000000a1', 'settings.secret', 'withdrawal');
  raise exception 'action under another subject type accepted';
exception when raise_exception then if sqlerrm not like 'audit_log accepts writes only%' then raise; end if; end $$;
do $$ begin
  insert into audit_log(actor_id, action, subject_type) values ('e8000000-0000-0000-0000-0000000000a1', 'account.status_changed', 'profile');
  raise exception 'other service_role action accepted';
exception when raise_exception then if sqlerrm not like 'audit_log accepts writes only%' then raise; end if; end $$;
do $$ begin
  update audit_log set note = 'x' where action = 'settings.secret';
  raise exception 'update allowed';
exception when raise_exception then if sqlerrm not like 'audit_log is append-only%' then raise; end if;
          when insufficient_privilege then null; end $$;
reset role;

do $$ begin
  if (select count(*) from audit_log where actor_id = 'e8000000-0000-0000-0000-0000000000a1') <> 5 then
    raise exception 'expected 5 admin rows';
  end if;
end $$;

set local role authenticated;
do $$ begin
  insert into audit_log(actor_id, action, subject_type) values ('e8000000-0000-0000-0000-0000000000a1', 'settings.secret', 'settings');
  raise exception 'client wrote to audit_log';
exception when insufficient_privilege or raise_exception then null; end $$;
reset role;

rollback;
\echo 'audit_log admin writes: OK'
