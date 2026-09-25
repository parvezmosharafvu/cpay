-- ============================================================
-- 0098: profile card and link usage for the dashboards
-- ============================================================
-- The dashboards show "links used X / limit" and the freelancer's
-- reseller. A freelancer can read only their own profile row, so the
-- reseller's name and email need an RPC, and "used" must be counted the
-- way enforce_link_limit() counts (active, not deleted, one per variant
-- group) rather than re-derived in the browser.
-- ============================================================

create or replace function link_usage_for(p_user_id uuid)
returns table (links_used int, link_limit int)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(distinct coalesce(pl.variant_group, pl.id))::int
       from payment_links pl
      where pl.user_id = p_user_id and pl.is_active = true and pl.deleted_at is null),
    (select case when pr.role = 'admin' then null
                 else least(coalesce(pr.max_payment_links, max_links_per_owner()), max_links_per_owner()) end
       from profiles pr where pr.id = p_user_id);
$$;

revoke all on function link_usage_for(uuid) from public, anon, authenticated;
grant execute on function link_usage_for(uuid) to service_role;

-- The caller's profile card. reseller_via is 'signup' for an affiliate
-- signup (referred_by) and 'assigned' for a moderator assignment.
create or replace function my_dashboard_profile()
returns table (
  user_id uuid,
  email text,
  display_name text,
  role text,
  account_status text,
  created_at timestamptz,
  reseller_id uuid,
  reseller_name text,
  reseller_email text,
  reseller_via text,
  links_used int,
  link_limit int,
  cost_percent numeric,
  cost_locked boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  return query
  with r as (
    select pr.referred_by as id, 'signup'::text as via
    from profiles pr where pr.id = v_uid and pr.referred_by is not null
    union all
    select ma.moderator_id, 'assigned'::text
    from moderator_assignments ma where ma.creator_id = v_uid
  ),
  pick as (select r.id, r.via from r order by (r.via = 'signup') desc limit 1)
  select
    pr.id, pr.email, pr.display_name, pr.role, pr.account_status, pr.created_at,
    rs.id, rs.display_name, rs.email, pk.via,
    u.links_used, u.link_limit,
    pr.cost_percent, coalesce(pr.cost_locked, false)
  from profiles pr
  cross join link_usage_for(v_uid) u
  left join pick pk on true
  left join profiles rs on rs.id = pk.id
  where pr.id = v_uid;
end;
$$;

-- Admin: links used and the effective limit for every freelancer and
-- reseller, next to the per-person limit an admin sets.
create or replace function admin_link_usage()
returns table (user_id uuid, links_used int, link_limit int, max_payment_links int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select pr.id, u.links_used, u.link_limit, pr.max_payment_links
  from profiles pr
  cross join lateral link_usage_for(pr.id) u
  where pr.role in ('creator', 'moderator');
end;
$$;

revoke all on function my_dashboard_profile() from public, anon;
revoke all on function admin_link_usage() from public, anon;
grant execute on function my_dashboard_profile() to authenticated;
grant execute on function admin_link_usage() to authenticated;
