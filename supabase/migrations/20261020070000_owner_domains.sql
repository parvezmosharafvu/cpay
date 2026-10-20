-- Admin → Settings → Domains: add, turn on/off and remove site_domains rows.
--
-- site_domains decides which browser origins the signed-in Edge Functions
-- accept (CORS) and which hosts serve payment links. Until now an admin
-- could write the table directly (RLS "domains admin write", no two-step
-- check, no audit) and no page did. Now:
--   * writes go through admin_save_domain() / admin_remove_domain() only:
--     active admin at aal2, hostname validated, audit_log 'settings.domain';
--   * the direct-write policy is dropped (reads stay public, unchanged).
-- Re-appliable.

drop policy if exists "domains admin write" on public.site_domains;

create or replace function public.admin_save_domain(p_hostname text, p_purpose text default 'both', p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare h text := lower(btrim(coalesce(p_hostname, ''))); before site_domains; after site_domains;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  h := regexp_replace(regexp_replace(h, '^https?://', ''), '/.*$', '');
  if h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' or length(h) > 253 then
    raise exception 'Enter a domain like pay.example.com (no https://, no path)';
  end if;
  if coalesce(p_purpose, '') not in ('payment', 'site', 'both') then raise exception 'Purpose must be payment, site or both'; end if;
  select * into before from site_domains where hostname = h;
  if before.id is not null and before.is_primary_site and not p_active then
    raise exception 'This is the main site domain; it cannot be turned off here';
  end if;
  insert into site_domains (hostname, purpose, is_active) values (h, p_purpose, p_active)
  on conflict (hostname) do update set purpose = excluded.purpose, is_active = excluded.is_active
  returning * into after;
  perform record_audit('settings.domain', 'site_domain', h,
    case when before.id is null then null else jsonb_build_object('purpose', before.purpose, 'active', before.is_active) end,
    jsonb_build_object('purpose', after.purpose, 'active', after.is_active));
  return jsonb_build_object('hostname', after.hostname, 'purpose', after.purpose, 'is_active', after.is_active);
end;
$$;
revoke all on function public.admin_save_domain(text, text, boolean) from public, anon;
grant execute on function public.admin_save_domain(text, text, boolean) to authenticated;

create or replace function public.admin_remove_domain(p_hostname text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare d site_domains;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  select * into d from site_domains where hostname = lower(btrim(coalesce(p_hostname, '')));
  if d.id is null then raise exception 'Domain not found'; end if;
  if d.is_primary_site then raise exception 'This is the main site domain; it cannot be removed here'; end if;
  delete from site_domains where id = d.id;
  perform record_audit('settings.domain', 'site_domain', d.hostname,
    jsonb_build_object('purpose', d.purpose, 'active', d.is_active), jsonb_build_object('removed', true));
  return true;
end;
$$;
revoke all on function public.admin_remove_domain(text) from public, anon;
grant execute on function public.admin_remove_domain(text) to authenticated;
