-- Coarse locations (20261020080000)
--
-- * Payments: the payer's country / region / city, read server-side from the
--   Cloudflare geo headers when the invoice is created (create-invoice and
--   direct-invoice; country and city were already recorded, region is new).
--   Never GPS, never an IP address: nothing here stores one.
-- * Payment links: an optional location / area label the link owner sets.
-- * Accounts: a location the user sets (country, division, district, area)
--   and a last-seen country taken from the request's own cf-ipcountry header
--   (set by Cloudflare, so a browser cannot choose it), refreshed at most
--   every 10 minutes.
-- * Owners see their own payment details (security invoker: RLS decides).
--   Admins see locations through admin_locations(), which needs aal2.
-- Re-appliable.

alter table public.payments add column if not exists customer_region text;
alter table public.direct_payments add column if not exists customer_region text;

alter table public.payment_links add column if not exists location_label text;
alter table public.payment_links drop constraint if exists payment_links_location_label_len;
alter table public.payment_links add constraint payment_links_location_label_len
  check (location_label is null or char_length(location_label) between 1 and 80);

-- Text from a header or a form: no control characters, single spaces, capped.
create or replace function public.geo_clean(p text, p_max integer default 80)
returns text language sql immutable set search_path = public
as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', '', 'g'), '\s+', ' ', 'g')), greatest(p_max, 1)), '')
$$;

-- ISO country code, or null for unknown / Tor / anything else.
create or replace function public.geo_country(p text)
returns text language sql immutable set search_path = public
as $$
  select case when upper(btrim(coalesce(p, ''))) ~ '^[A-Z]{2}$' and upper(btrim(p)) not in ('XX', 'T1')
              then upper(btrim(p)) end
$$;

create table if not exists public.profile_locations (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  division text check (division is null or char_length(division) <= 80),
  district text check (district is null or char_length(district) <= 80),
  area text check (area is null or char_length(area) <= 80),
  last_seen_country text check (last_seen_country is null or last_seen_country ~ '^[A-Z]{2}$'),
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.profile_locations enable row level security;
drop policy if exists profile_locations_owner_read on public.profile_locations;
create policy profile_locations_owner_read on public.profile_locations
  for select to authenticated using (user_id = auth.uid() or is_admin());
revoke all on public.profile_locations from anon, authenticated;
grant select on public.profile_locations to authenticated;

create or replace function public.my_location()
returns jsonb language sql stable security definer set search_path = public
as $$
  select coalesce((select jsonb_build_object('country', country, 'division', division, 'district', district,
                     'area', area, 'last_seen_country', last_seen_country, 'last_seen_at', last_seen_at)
                     from profile_locations where user_id = auth.uid()), '{}'::jsonb)
   where auth.uid() is not null
$$;

create or replace function public.set_my_location(p_country text, p_division text default null,
  p_district text default null, p_area text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_country text := geo_country(p_country);
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if nullif(btrim(coalesce(p_country, '')), '') is not null and v_country is null then
    raise exception 'Choose a country from the list';
  end if;
  insert into profile_locations (user_id, country, division, district, area, updated_at)
  values (v_uid, v_country, geo_clean(p_division), geo_clean(p_district), geo_clean(p_area), now())
  on conflict (user_id) do update set country = excluded.country, division = excluded.division,
    district = excluded.district, area = excluded.area, updated_at = now();
  return my_location();
end;
$$;

-- Called by the desk on load. Only the country, only from Cloudflare's header.
create or replace function public.touch_my_last_seen()
returns void language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_country text;
begin
  if v_uid is null then return; end if;
  begin
    v_country := geo_country(current_setting('request.headers', true)::json ->> 'cf-ipcountry');
  exception when others then v_country := null;
  end;
  if v_country is null then return; end if;
  insert into profile_locations (user_id, last_seen_country, last_seen_at)
  values (v_uid, v_country, now())
  on conflict (user_id) do update set last_seen_country = excluded.last_seen_country, last_seen_at = now()
   where profile_locations.last_seen_at is null
      or profile_locations.last_seen_at < now() - interval '10 minutes'
      or profile_locations.last_seen_country is distinct from excluded.last_seen_country;
end;
$$;

-- The two account display settings the payments list applies (small
-- payments hidden, buyer amount shown), for the caller only.
create or replace function public.my_payment_view_prefs()
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('hide_below', small_payment_threshold(), 'show_buyer', should_show_buyer_amount(auth.uid()))
   where auth.uid() is not null
$$;

-- One payment, for its owner. SECURITY INVOKER: the payments, links,
-- forwards and batches RLS policies decide what the caller can see, and the
-- explicit user_id check keeps admins to their own here too.
create or replace function public.get_my_payment_details(p_payment_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = public
as $$
declare r jsonb; v_uid uuid := auth.uid(); v_prefs jsonb;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  v_prefs := my_payment_view_prefs();
  select jsonb_build_object(
      'id', p.id, 'invoice_ref', p.invoice_ref, 'status', p.status, 'method', p.method,
      'amount_requested', p.amount_requested, 'amount_settled', p.amount_settled,
      'buyer_amount', case when (v_prefs ->> 'show_buyer')::boolean then p.buyer_amount end,
      'link_cost_percent', p.cost_percent,
      'platform_fee_percent', p.platform_fee_percent, 'platform_fee_amount', p.platform_fee_amount,
      'network_fee_usd', case
          when f.kind = 'usdt' and b.network_fee_usd is not null and b.amount_usd > 0
            then round(b.network_fee_usd * coalesce(f.amount_usd, 0) / b.amount_usd, 2)
          when f.routing_fee_sat is not null and p.btc_usd_rate is not null
            then round(f.routing_fee_sat::numeric * p.btc_usd_rate / 100000000, 2) end,
      'created_at', p.created_at, 'settled_at', p.settled_at, 'expires_at', p.expires_at,
      'link_slug', l.slug, 'link_name', l.display_name, 'link_location', l.location_label,
      'payer_country', p.customer_country, 'payer_region', p.customer_region, 'payer_city', p.customer_city,
      'forward', case when f.id is null then null else jsonb_build_object(
          'kind', f.kind, 'status', f.status, 'reason', f.reason, 'network', f.network,
          'forward_sat', f.forward_sat, 'sent_sat', f.sent_sat, 'routing_fee_sat', f.routing_fee_sat,
          'forwarded_at', f.forwarded_at, 'usdt_batch_received', b.receive) end)
    into r
    from payments p
    left join payment_links l on l.id = p.payment_link_id
    left join payment_forwards f on f.payment_id = p.id
    left join forward_batches b on b.id = f.batch_id
   where p.id = p_payment_id and p.user_id = v_uid
     and not (p.status = 'settled' and p.amount_settled < coalesce((v_prefs ->> 'hide_below')::numeric, 0));
  if r is null then return null; end if;
  -- What lands with the owner: settled amount less the platform fee, less
  -- the network fee of an instant forward.
  if (r ->> 'amount_settled') is not null then
    r := r || jsonb_build_object('you_receive', greatest(0, round(
      (r ->> 'amount_settled')::numeric - coalesce((r ->> 'platform_fee_amount')::numeric, 0)
      - coalesce((r ->> 'network_fee_usd')::numeric, 0), 2)));
  end if;
  return r;
end;
$$;

-- Admin: where users and payments are, with a filter by area. aal2 only.
create or replace function public.admin_locations(p_country text default null, p_area text default null,
  p_days integer default 30, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare v_country text := geo_country(p_country); v_area text := geo_clean(p_area);
        v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366));
        v_lim int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Enter your authenticator code first (sign in again with two-step sign-in)';
  end if;
  return jsonb_build_object(
    'since', v_since,
    'payments_by_area', coalesce((select jsonb_agg(to_jsonb(x) order by x.payments desc) from (
        select coalesce(customer_country, '??') as country, coalesce(customer_region, customer_city, '') as area,
               count(*) as payments, count(*) filter (where status = 'settled') as settled,
               coalesce(sum(amount_settled) filter (where status = 'settled'), 0) as settled_usd
          from payments
         where created_at >= v_since
           and (v_country is null or customer_country = v_country)
           and (v_area is null or customer_region ilike '%' || v_area || '%' or customer_city ilike '%' || v_area || '%')
         group by 1, 2 order by 3 desc limit 200) x), '[]'::jsonb),
    'users_by_area', coalesce((select jsonb_agg(to_jsonb(x) order by x.users desc) from (
        select coalesce(country, '??') as country, coalesce(division, '') as division, coalesce(district, '') as district,
               count(*) as users
          from profile_locations
         where (v_country is null or country = v_country)
           and (v_area is null or division ilike '%' || v_area || '%' or district ilike '%' || v_area || '%' or area ilike '%' || v_area || '%')
         group by 1, 2, 3 order by 4 desc limit 200) x), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
        select p.id, p.created_at, p.status, p.amount_requested, p.amount_settled, pr.email as user_email,
               l.slug as link_slug, l.location_label as link_location,
               p.customer_country as country, p.customer_region as region, p.customer_city as city
          from payments p left join profiles pr on pr.id = p.user_id left join payment_links l on l.id = p.payment_link_id
         where p.created_at >= v_since
           and (v_country is null or p.customer_country = v_country)
           and (v_area is null or p.customer_region ilike '%' || v_area || '%' or p.customer_city ilike '%' || v_area || '%'
                or l.location_label ilike '%' || v_area || '%')
         order by p.created_at desc limit v_lim) x), '[]'::jsonb),
    'users', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
        select pl.user_id, pr.email, pr.display_name, pl.country, pl.division, pl.district, pl.area,
               pl.last_seen_country, pl.last_seen_at, pl.updated_at
          from profile_locations pl join profiles pr on pr.id = pl.user_id
         where (v_country is null or pl.country = v_country or pl.last_seen_country = v_country)
           and (v_area is null or pl.division ilike '%' || v_area || '%' or pl.district ilike '%' || v_area || '%' or pl.area ilike '%' || v_area || '%')
         order by pl.updated_at desc limit v_lim) x), '[]'::jsonb));
end;
$$;

revoke all on function public.geo_clean(text, integer) from public, anon;
revoke all on function public.geo_country(text) from public, anon;
grant execute on function public.geo_clean(text, integer) to authenticated, service_role;
grant execute on function public.geo_country(text) to authenticated, service_role;
do $$ declare f text; begin
  foreach f in array array['my_payment_view_prefs()', 'my_location()', 'set_my_location(text, text, text, text)', 'touch_my_last_seen()',
                           'get_my_payment_details(uuid)', 'admin_locations(text, text, integer, integer)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
