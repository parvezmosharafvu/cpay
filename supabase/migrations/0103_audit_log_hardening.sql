-- CPAY — 0103: audit log is append-only, and money actions are recorded.
--
-- A failed audit write now rolls the action back. The log cannot be edited
-- or deleted through the API. service_role may still append the two platform
-- wallet rows the payment service writes, and nothing else.

create or replace function public.record_audit(
  p_action text,
  p_subject_type text default null,
  p_subject_id text default null,
  p_old jsonb default null,
  p_new jsonb default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_action is null or length(trim(p_action)) = 0 or length(p_action) > 80 then
    raise exception 'Invalid audit action';
  end if;

  select email into v_email from profiles where id = auth.uid();

  insert into audit_log (actor_id, actor_email, action, subject_type, subject_id, old_value, new_value, note)
  values (auth.uid(), v_email, p_action, p_subject_type, p_subject_id, p_old, p_new, p_note);
end;
$$;

revoke all on function public.record_audit(text, text, text, jsonb, jsonb, text) from public, anon, authenticated, service_role;

create or replace function public.audit_log_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('postgres', 'supabase_admin') then
      return new;
    end if;
    if current_user = 'service_role'
       and new.subject_type = 'platform_wallet_send'
       and new.action in ('platform_wallet.send', 'platform_wallet.send.result') then
      return new;
    end if;
    raise exception 'audit_log accepts writes only from the audit function';
  end if;

  if current_user in ('postgres', 'supabase_admin')
     and current_setting('cpay.audit_maintenance', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return null;
  end if;

  raise exception 'audit_log is append-only';
end;
$$;

drop trigger if exists audit_log_guard on public.audit_log;
create trigger audit_log_guard
before insert or update or delete on public.audit_log
for each row execute function public.audit_log_guard();

drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate
before truncate on public.audit_log
for each statement execute function public.audit_log_guard();

revoke insert, update, delete, truncate, trigger, references on public.audit_log from anon, authenticated;
revoke update, delete, truncate, trigger, references on public.audit_log from service_role;

create or replace function public.admin_set_link_limit(p_creator_id uuid, p_limit integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old integer;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_limit is null or p_limit < 0 or p_limit > max_links_per_owner() then
    raise exception 'Limit must be between 0 and %', max_links_per_owner();
  end if;
  select max_payment_links into v_old from profiles where id = p_creator_id;
  update profiles set max_payment_links = p_limit where id = p_creator_id;
  perform record_audit(
    'profile.link_limit_changed', 'profile', p_creator_id::text,
    jsonb_build_object('max_payment_links', v_old),
    jsonb_build_object('max_payment_links', p_limit)
  );
end;
$$;

create or replace function public.set_my_cost_percent(p_percent numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_locked boolean;
  v_old numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select role, cost_locked, cost_percent into v_role, v_locked, v_old from profiles where id = v_uid;
  if v_role not in ('creator', 'moderator') then raise exception 'Not authorized'; end if;
  if coalesce(v_locked, false) and not is_admin() then
    raise exception 'Your reseller locked this payment-link cost rate';
  end if;
  if p_percent is null or p_percent < 0 then raise exception 'Cost must be 0 or more'; end if;
  update profiles set cost_percent = round(p_percent, 3) where id = v_uid;
  perform record_audit(
    'profile.cost_percent_changed', 'profile', v_uid::text,
    jsonb_build_object('cost_percent', v_old),
    jsonb_build_object('cost_percent', round(p_percent, 3))
  );
  return round(p_percent, 3);
end;
$$;

create or replace function public.set_link_cost_percent(p_link_id uuid, p_percent numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_locked boolean;
  v_old numeric;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select pl.user_id, pr.cost_locked, pl.cost_percent into v_owner, v_locked, v_old
  from payment_links pl join profiles pr on pr.id = pl.user_id
  where pl.id = p_link_id and pl.deleted_at is null;
  if v_owner is null then raise exception 'Link not found'; end if;
  if v_owner <> v_uid and not is_admin() and not (is_reseller() and reseller_owns(v_owner)) then
    raise exception 'Not authorized';
  end if;
  if coalesce(v_locked, false) and not is_admin() and v_uid = v_owner then
    raise exception 'Your reseller locked this payment-link cost rate';
  end if;
  if p_percent is not null and (p_percent < 0 or p_percent > 1000) then
    raise exception 'Cost must be between 0 and 1000';
  end if;
  update payment_links
     set cost_percent = case when p_percent is null then null else round(p_percent, 3) end
   where id = p_link_id;
  perform record_audit(
    'link.cost_changed', 'payment_link', p_link_id::text,
    jsonb_build_object('cost_percent', v_old),
    jsonb_build_object('cost_percent', case when p_percent is null then null else round(p_percent, 3) end)
  );
  return p_percent;
end;
$$;

create or replace function public.reseller_lock_team_cost(p_percent numeric, p_lock boolean default true)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_old numeric;
begin
  if not is_reseller() and not is_admin() then raise exception 'Not authorized'; end if;
  select team_cost_percent into v_old from profiles where id = auth.uid();
  if coalesce(p_lock, true) then
    if p_percent is null or p_percent < 0 or p_percent > 1000 then
      raise exception 'Cost must be 0-1000';
    end if;
    update profiles
       set team_cost_percent = round(p_percent, 3)
     where id = auth.uid();
    update profiles
       set cost_percent = round(p_percent, 3),
           cost_locked = true
     where referred_by = auth.uid()
        or id in (select creator_id from moderator_assignments where moderator_id = auth.uid());
  else
    update profiles
       set cost_locked = false
     where referred_by = auth.uid()
        or id in (select creator_id from moderator_assignments where moderator_id = auth.uid());
  end if;
  get diagnostics v_count = row_count;
  perform record_audit(
    case when coalesce(p_lock, true) then 'reseller.team_cost_locked' else 'reseller.team_cost_unlocked' end,
    'profile', auth.uid()::text,
    jsonb_build_object('team_cost_percent', v_old),
    jsonb_build_object(
      'team_cost_percent', case when coalesce(p_lock, true) then round(p_percent, 3) else v_old end,
      'locked', coalesce(p_lock, true),
      'accounts', v_count
    )
  );
  return v_count;
end;
$$;

create or replace function public.audit_withdrawal_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform record_audit(
      'withdrawal.requested', 'withdrawal', new.id::text,
      null,
      jsonb_build_object(
        'user_id', new.user_id,
        'amount', new.amount_requested,
        'method', new.method,
        'status', new.status,
        'destination_last4', right(coalesce(new.destination, ''), 4)
      )
    );
    return new;
  end if;
  if new.status is distinct from old.status then
    perform record_audit(
      'withdrawal.status_changed', 'withdrawal', new.id::text,
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status, 'user_id', new.user_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists audit_withdrawal_change on public.withdrawals;
create trigger audit_withdrawal_change
after insert or update of status on public.withdrawals
for each row execute function public.audit_withdrawal_change();
