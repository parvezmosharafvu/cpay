-- CPAY M1: guarded onboarding and registration contacts. Append-only migration.
-- Preserves current wallet/ledger functions, fees, account decisions, and roles.
-- Phone is required by the new page but nullable for historical accounts and
-- pre-existing integrations. Metadata values are server-validated if provided.

alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists telegram_username text;

-- Re-apply safe: CI re-runs all post-removal migrations on a populated DB.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass
                and conname='profiles_paylink_phone_check') then
    alter table public.profiles add constraint profiles_paylink_phone_check
      check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.profiles'::regclass
                and conname='profiles_paylink_telegram_check') then
    alter table public.profiles add constraint profiles_paylink_telegram_check
      check (telegram_username is null or telegram_username ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$');
  end if;
end;
$$;

comment on column public.profiles.phone is 'International phone number; unverified, nullable for existing accounts.';
comment on column public.profiles.telegram_username is 'Optional Telegram username without @; not verified/linked.';

-- The target forbids automatic activation. Refuse even if an old client
-- attempts to enable the previous setting directly.
insert into public.app_settings(key,value) values ('auto_approve_freelancer','false'::jsonb)
on conflict(key) do update set value='false'::jsonb,updated_at=now();

create or replace function public.cpay_auto_approval_enabled(p_role text)
returns boolean language sql security definer stable set search_path=public
as $$ select false $$;
revoke all on function public.cpay_auto_approval_enabled(text) from public, anon;
grant execute on function public.cpay_auto_approval_enabled(text) to authenticated;

create or replace function public.admin_set_auto_approval(p_role text, p_enabled boolean)
returns void language plpgsql security definer set search_path=public
as $$
declare old jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_role is distinct from 'freelancer' then raise exception 'Invalid application role'; end if;
  if not public.strong_session() then
    raise exception 'Sign in again with your passkey first, then change settings';
  end if;
  if p_enabled is true then raise exception 'Manual account approval is required'; end if;
  select value into old from public.app_settings where key='auto_approve_freelancer';
  insert into public.app_settings(key,value) values ('auto_approve_freelancer','false'::jsonb)
  on conflict(key) do update set value='false'::jsonb,updated_at=now();
  perform record_audit('settings.auto_approval','setting','auto_approve_freelancer',
    jsonb_build_object('value',old), jsonb_build_object('value',false));
end;
$$;
revoke all on function public.admin_set_auto_approval(text,boolean) from public, anon;
grant execute on function public.admin_set_auto_approval(text,boolean) to authenticated;

-- Existing profile column update whitelist excludes the private contacts.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- Sign-up form sends display_name; Google sign-in sends full_name / name.
  v_name text := left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                               nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                               nullif(trim(new.raw_user_meta_data->>'name'), ''),
                               split_part(new.email, '@', 1)), 80);
  -- Sign-up form sends account_type ('individual' | 'business') and, for a
  -- business, business_name. Anything else is an individual account.
  v_type text := case when new.raw_user_meta_data->>'account_type' = 'business' then 'business' else 'individual' end;
  v_business text := btrim(left(regexp_replace(coalesce(new.raw_user_meta_data->>'business_name', ''), '[[:cntrl:]]', '', 'g'), 120));
  v_phone text := nullif(btrim(coalesce(new.raw_user_meta_data->>'phone', '')), '');
  v_telegram text := nullif(btrim(coalesce(new.raw_user_meta_data->>'telegram_username', '')), '');
  v_default_links int;
begin
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Invalid international phone number';
  end if;
  if v_telegram is not null and v_telegram !~ '^[A-Za-z][A-Za-z0-9_]{4,31}$' then
    raise exception 'Invalid Telegram username';
  end if;
  if v_type <> 'business' or char_length(v_business) < 2 then
    v_business := null;
  end if;

  select coalesce((value->>'count')::int, 5)
    into v_default_links
  from app_settings where key = 'default_max_payment_links';

  insert into public.profiles
    (id, email, display_name, role, account_status,
     withdrawal_fee_percent, max_payment_links, account_type, business_name, phone, telegram_username)
  values
    (new.id, new.email, v_name, 'creator', 'pending',
     null, coalesce(v_default_links, 5), v_type, v_business, v_phone, v_telegram)
  on conflict (id) do nothing;

  insert into public.account_applications
    (user_id, email, display_name, requested_role, status, reviewed_at)
  values
    (new.id, new.email, v_name, 'freelancer',
     'pending', null)
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        requested_role = excluded.requested_role,
        updated_at = now();

  return new;
end;
$function$;

drop function if exists public.admin_list_account_applications(text);
create function public.admin_list_account_applications(p_status text default 'pending')
returns table (
  id uuid, user_id uuid, email text, display_name text,
  requested_role text, status text, review_note text,
  created_at timestamptz, reviewed_at timestamptz,
  account_type text, business_name text, phone text, telegram_username text
)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_status is not null and p_status not in ('pending','approved','rejected','suspended') then
    raise exception 'Invalid application status';
  end if;
  return query
  select a.id, a.user_id, a.email, a.display_name,
         a.requested_role, a.status, a.review_note,
         a.created_at, a.reviewed_at,
         coalesce(p.account_type,'individual'), p.business_name,
         p.phone, p.telegram_username
  from public.account_applications a
  left join public.profiles p on p.id=a.user_id
  where p_status is null or a.status=p_status
  order by a.created_at desc;
end;
$$;
revoke all on function public.admin_list_account_applications(text) from public, anon;
grant execute on function public.admin_list_account_applications(text) to authenticated;
