-- CPAY — 20261020010000: owner-controlled platform settings (non-custodial plan)
--
-- docs/NON-CUSTODIAL-PLAN.md (approved, PR #126) needs switches, fee
-- configuration, the receiving-provider list, admin-wallet limits, legal
-- fields and publish toggles that the owner sets from Admin → Settings
-- instead of code. This migration only stores them. Every default keeps
-- today's behaviour, so applying it changes nothing for anyone.
--
--   * public.platform_settings: one row per known key, typed by a CHECK.
--     No client can write it: the only writer is
--     admin_set_platform_setting(), which needs an active admin at aal2,
--     validates the value and writes audit_log ('settings.platform').
--   * Only admins can read the table. The public site reads only the
--     legal fields and the two publish toggles, through
--     get_public_site_settings().
--   * platform_setting(key) is the server-side reader (service role and
--     SQL functions).
--
-- Rollback: drop function admin_set_platform_setting(text, jsonb),
-- admin_platform_settings(), get_public_site_settings(),
-- platform_setting(text), platform_setting_valid(text, jsonb); drop table
-- platform_settings. Export the table first if values were set.

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.platform_settings is
  'Owner-controlled settings (docs/NON-CUSTODIAL-PLAN.md). Written only by admin_set_platform_setting() (aal2, audited).';

-- The catalogue: key, default, kind. Defaults = current behaviour.
create or replace function public.platform_setting_defaults()
returns table(key text, default_value jsonb, kind text, dangerous boolean, label text)
language sql immutable set search_path = public
as $$ values
  ('custodial_receive_enabled',     'true'::jsonb,  'boolean', true,  'Custodial receive: payments into the CPAY wallet and CPAY balances'),
  ('custodial_new_links_enabled',   'true'::jsonb,  'boolean', true,  'New links may use the CPAY balance (custodial)'),
  ('custodial_withdraw_enabled',    'true'::jsonb,  'boolean', true,  'Withdrawals from CPAY balances'),
  ('fee_billing_enabled',           'false'::jsonb, 'boolean', true,  'Bill CPAY fees to merchants (subscription)'),
  ('fee_pilot_no_fee',              'true'::jsonb,  'boolean', false, 'Pilot: no CPAY fee on direct payments'),
  ('fee_subscription_price_usd',    '0'::jsonb,     'money',   false, 'Subscription price per month (USD)'),
  ('fee_free_tier_usd',             '0'::jsonb,     'money',   false, 'Free tier: direct volume per month before the subscription applies (USD)'),
  ('fee_grace_days',                '7'::jsonb,     'days',    false, 'Grace days before unpaid billing pauses links'),
  ('direct_provider_hosts',         '[]'::jsonb,    'hosts',   true,  'Allowed receiving-wallet provider hosts (empty = any public provider)'),
  ('direct_pilot_user_ids',         '[]'::jsonb,    'uuids',   true,  'Direct-payment pilot accounts (allowed while direct payments are off for everyone)'),
  ('admin_send_daily_cap_usd',      'null'::jsonb,  'money_or_null', true, 'Admin wallet: daily send cap (USD, empty = no cap)'),
  ('admin_send_allowed_destinations','[]'::jsonb,   'strings', true,  'Admin wallet: allowed destinations (empty = any)'),
  ('legal_entity_name',             '""'::jsonb,    'text',    false, 'Legal entity name'),
  ('legal_address',                 '""'::jsonb,    'text',    false, 'Registered address'),
  ('legal_effective_date',          '""'::jsonb,    'date_or_empty', false, 'Legal pages effective date'),
  ('legal_jurisdiction',            '""'::jsonb,    'text',    false, 'Governing law jurisdiction'),
  ('legal_courts',                  '""'::jsonb,    'text',    false, 'Courts with jurisdiction'),
  ('legal_privacy_email',           '""'::jsonb,    'email_or_empty', false, 'Privacy contact email'),
  ('legal_support_email',           '""'::jsonb,    'email_or_empty', false, 'Support email'),
  ('legal_published',               'false'::jsonb, 'boolean', true,  'Publish legal pages (indexed and linked; needs every legal field)'),
  ('wallet_link_enabled',           'false'::jsonb, 'boolean', true,  'Show the CPAY Wallet download link on the website'),
  ('wallet_url',                    '""'::jsonb,    'https_or_empty', false, 'CPAY Wallet address (https)')
$$;
revoke all on function public.platform_setting_defaults() from public, anon;
grant execute on function public.platform_setting_defaults() to authenticated, service_role;

create or replace function public.platform_setting_valid(p_kind text, v jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare e jsonb;
begin
  case p_kind
  when 'boolean' then return jsonb_typeof(v) = 'boolean';
  when 'money' then return jsonb_typeof(v) = 'number' and (v#>>'{}')::numeric between 0 and 100000
                          and scale((v#>>'{}')::numeric) <= 2;
  when 'money_or_null' then return jsonb_typeof(v) = 'null'
                          or (jsonb_typeof(v) = 'number' and (v#>>'{}')::numeric between 0 and 100000);
  when 'days' then return jsonb_typeof(v) = 'number' and (v#>>'{}')::numeric between 0 and 90
                          and (v#>>'{}')::numeric = trunc((v#>>'{}')::numeric);
  when 'text' then return jsonb_typeof(v) = 'string' and length(v#>>'{}') <= 300
                          and (v#>>'{}') !~ '[<>]';
  when 'date_or_empty' then return jsonb_typeof(v) = 'string'
                          and ((v#>>'{}') = '' or (v#>>'{}') ~ '^\d{4}-\d{2}-\d{2}$');
  when 'email_or_empty' then return jsonb_typeof(v) = 'string'
                          and ((v#>>'{}') = '' or ((v#>>'{}') ~ '^[^@\s<>]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$' and length(v#>>'{}') <= 254));
  when 'https_or_empty' then return jsonb_typeof(v) = 'string'
                          and ((v#>>'{}') = '' or (v#>>'{}') ~ '^https://[a-z0-9.-]+\.[a-z]{2,}(/[A-Za-z0-9._~/-]*)?$');
  when 'hosts', 'strings', 'uuids' then
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 50 then return false; end if;
    for e in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(e) <> 'string' then return false; end if;
      if p_kind = 'hosts' and (e#>>'{}') !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then return false; end if;
      if p_kind = 'uuids' and (e#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
      if p_kind = 'strings' and (length(e#>>'{}') not between 1 and 500 or (e#>>'{}') ~ '\s') then return false; end if;
    end loop;
    return true;
  else return false;
  end case;
end;
$$;

alter table public.platform_settings drop constraint if exists platform_settings_known_valid;
create or replace function public.platform_settings_check(p_key text, v jsonb)
returns boolean language sql immutable set search_path = public
as $$ select coalesce((select platform_setting_valid(d.kind, v) from platform_setting_defaults() d where d.key = p_key), false) $$;
alter table public.platform_settings add constraint platform_settings_known_valid
  check (platform_settings_check(key, value));

alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from public, anon, authenticated;
grant select on public.platform_settings to authenticated;
grant all on public.platform_settings to service_role;
drop policy if exists "platform settings admin read" on public.platform_settings;
create policy "platform settings admin read" on public.platform_settings
  for select to authenticated using (is_admin());

-- Server-side reader: stored value or the default.
create or replace function public.platform_setting(p_key text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce((select s.value from platform_settings s where s.key = p_key),
                  (select d.default_value from platform_setting_defaults() d where d.key = p_key))
$$;
revoke all on function public.platform_setting(text) from public, anon, authenticated;
grant execute on function public.platform_setting(text) to service_role;

-- Admin view of every setting, with defaults, labels and who changed it.
create or replace function public.admin_platform_settings()
returns table(key text, value jsonb, default_value jsonb, kind text, dangerous boolean, label text,
              updated_at timestamptz, updated_by_email text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
    select d.key, coalesce(s.value, d.default_value), d.default_value, d.kind, d.dangerous, d.label,
           s.updated_at, (select p.email from profiles p where p.id = s.updated_by)
    from platform_setting_defaults() d left join platform_settings s on s.key = d.key;
end;
$$;
revoke all on function public.admin_platform_settings() from public, anon;
grant execute on function public.admin_platform_settings() to authenticated, service_role;

-- The only writer. Active admin at aal2 (always, whatever admin_mfa_required
-- says), known key, valid value, audited with old and new values.
create or replace function public.admin_set_platform_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare d record; old jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in), then change settings';
  end if;
  select * into d from platform_setting_defaults() x where x.key = p_key;
  if not found then raise exception 'Unknown setting'; end if;
  if p_value is null or not platform_setting_valid(d.kind, p_value) then
    raise exception 'Invalid value for %', p_key;
  end if;
  if p_key = 'legal_published' and p_value = 'true'::jsonb then
    if exists (select 1 from platform_setting_defaults() x
               where x.key like 'legal\_%' escape '\' and x.key <> 'legal_published'
                 and coalesce(platform_setting(x.key) #>> '{}', '') = '') then
      raise exception 'Fill in every legal field before publishing the legal pages';
    end if;
  end if;
  if p_key = 'wallet_link_enabled' and p_value = 'true'::jsonb
     and coalesce(platform_setting('wallet_url') #>> '{}', '') = '' then
    raise exception 'Set the CPAY Wallet address before showing the link';
  end if;
  old := platform_setting(p_key);
  insert into platform_settings(key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform record_audit('settings.platform', 'setting', p_key, jsonb_build_object('value', old), jsonb_build_object('value', p_value));
  return p_value;
end;
$$;
revoke all on function public.admin_set_platform_setting(text, jsonb) from public, anon;
grant execute on function public.admin_set_platform_setting(text, jsonb) to authenticated;

-- What the public website may know: legal fields, whether they are
-- published (and complete), and the wallet link.
create or replace function public.get_public_site_settings()
returns jsonb
language sql stable security definer set search_path = public
as $$
  with f as (
    select jsonb_object_agg(d.key, platform_setting(d.key)) j
    from platform_setting_defaults() d where d.key like 'legal\_%' escape '\' and d.key <> 'legal_published'
  )
  select (select j from f)
    || jsonb_build_object(
      'legal_published', platform_setting('legal_published') = 'true'::jsonb
        and not exists (select 1 from jsonb_each_text((select j from f)) e where e.value = ''),
      'wallet_link_enabled', platform_setting('wallet_link_enabled') = 'true'::jsonb
        and coalesce(platform_setting('wallet_url') #>> '{}', '') <> '',
      'wallet_url', case when platform_setting('wallet_link_enabled') = 'true'::jsonb
                         then platform_setting('wallet_url') else '""'::jsonb end)
$$;
revoke all on function public.get_public_site_settings() from public;
grant execute on function public.get_public_site_settings() to anon, authenticated, service_role;
