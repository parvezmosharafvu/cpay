-- CPAY — 20261017010000: account type, Individual or Business / Organization
--
-- The CPAY design artifacts (2026-10-17) set two account types for the
-- website: Individual and Business / Organization. This records the choice
-- made at sign-up and shows it to the account holder and to the admin who
-- reviews the application. It grants nothing: role, approval, fees, limits,
-- payouts and permissions are the same for both types. There are no team
-- members or organization settings (not supported).
--
-- 1. profiles.account_type: 'individual' (default) or 'business'.
--    profiles.business_name: only for 'business', 2 to 120 characters.
--    Existing accounts become 'individual' (a constant default: no table
--    rewrite). Users cannot change either column: guard_profile_updates()
--    is an allowlist and is not changed. An admin can.
-- 2. handle_new_user() reads account_type and business_name from the
--    sign-up metadata. Anything other than exactly 'business' is
--    'individual', so Google sign-up and old clients are 'individual'. A
--    name that is too short is dropped rather than failing the sign-up.
--    Production definition (md5 d2f849fc1370c048e9fb96b68ff13ae5, equal to
--    20261015010000, checked 2026-10-16) with only those lines changed.
-- 3. admin_list_account_applications() also returns the applicant's
--    account_type and business_name. Production definition (md5
--    ff8b7d4748e5ad33787f84f9b938db2c, equal to 0067) plus the two columns.
--    The return type changes, so it is dropped and re-created with the
--    same grants.
--
-- Rollback: re-create admin_list_account_applications() from 0067 and
-- handle_new_user() from 20261015010000, then drop the two columns. No
-- other database object reads them.

alter table public.profiles
  add column if not exists account_type text not null default 'individual',
  add column if not exists business_name text;

alter table public.profiles drop constraint if exists profiles_account_type_check;
alter table public.profiles add constraint profiles_account_type_check
  check (account_type in ('individual', 'business'));

alter table public.profiles drop constraint if exists profiles_business_name_check;
alter table public.profiles add constraint profiles_business_name_check
  check (business_name is null
         or (account_type = 'business' and char_length(btrim(business_name)) between 2 and 120));

comment on column public.profiles.account_type is
  'Individual or Business / Organization, chosen at sign-up. Display only: grants nothing.';
comment on column public.profiles.business_name is
  'Business or organization name, only when account_type = business.';

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
  v_default_links int;
  v_auto boolean := cpay_auto_approval_enabled('freelancer');
  v_status text := case when v_auto then 'active' else 'pending' end;
begin
  if v_type <> 'business' or char_length(v_business) < 2 then
    v_business := null;
  end if;

  select coalesce((value->>'count')::int, 5)
    into v_default_links
  from app_settings where key = 'default_max_payment_links';

  insert into public.profiles
    (id, email, display_name, role, account_status,
     withdrawal_fee_percent, max_payment_links, account_type, business_name)
  values
    (new.id, new.email, v_name, 'creator', v_status,
     null, coalesce(v_default_links, 5), v_type, v_business)
  on conflict (id) do nothing;

  insert into public.account_applications
    (user_id, email, display_name, requested_role, status, reviewed_at)
  values
    (new.id, new.email, v_name, 'freelancer',
     case when v_auto then 'approved' else 'pending' end,
     case when v_auto then now() else null end)
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        requested_role = excluded.requested_role,
        updated_at = now();

  return new;
end;
$function$;

drop function if exists public.admin_list_account_applications(text);
create or replace function public.admin_list_account_applications(p_status text default 'pending')
returns table (
  id uuid, user_id uuid, email text, display_name text,
  requested_role text, status text, review_note text,
  created_at timestamptz, reviewed_at timestamptz,
  account_type text, business_name text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'suspended') then
    raise exception 'Invalid application status';
  end if;

  return query
  select a.id, a.user_id, a.email, a.display_name,
         a.requested_role, a.status, a.review_note,
         a.created_at, a.reviewed_at,
         coalesce(p.account_type, 'individual'), p.business_name
  from account_applications a
  left join profiles p on p.id = a.user_id
  where p_status is null or a.status = p_status
  order by a.created_at desc;
end;
$$;
revoke all on function public.admin_list_account_applications(text) from public, anon;
grant execute on function public.admin_list_account_applications(text) to authenticated;
