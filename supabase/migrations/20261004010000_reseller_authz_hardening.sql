-- ============================================================
-- Reseller / staff authorization hardening
-- (ACCOUNT_MODEL_ARCHITECTURE.md, findings M1, M2, M3, M4-db, M5, M6, M8)
-- ============================================================
-- Authorization only. No table, column, RLS policy, payment, ledger,
-- balance, commission or withdrawal logic changes. Every function body
-- replaced below is byte-identical in the repo and in production before
-- this migration (md5 of pg_get_functiondef checked read-only); only the
-- lines marked "CHANGED" differ.
--
-- Safe to apply more than once (CI re-applies every migration from 0096 on).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Role checks require an active account (M3, and M4 at the DB layer).
--    A suspended, rejected or pending admin or reseller no longer passes.
--    Lockout: admin_update_account_control refuses to remove the last
--    active admin and refuses self-changes; admin_bulk_set_account_status
--    and admin_set_profile_suspension refuse to suspend an admin.
-- ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
select exists(select 1 from profiles where id = auth.uid() and role = 'admin' and account_status = 'active');  -- CHANGED: active only
$function$;

create or replace function public.is_moderator()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists(select 1 from profiles where id = auth.uid() and role = 'moderator' and account_status = 'active');  -- CHANGED: active only
$function$;

create or replace function public.is_reseller()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from profiles where id = auth.uid() and role = 'moderator' and account_status = 'active');  -- CHANGED: active only
$function$;

-- ------------------------------------------------------------
-- 2. handles_creator() is platform-admin only (M2).
--    It was the reseller ("moderator") path into mark_payment,
--    unmark_payment, staff_* and admin_list_payments. Resellers keep their
--    own team RPCs (my_team_members, my_team_totals, my_affiliate_commission_rows,
--    reseller_*), which do not use it. Name and signature kept for
--    compatibility. mark_payment/unmark_payment are unchanged and now
--    allow: the payment's owner, or an active platform admin.
-- ------------------------------------------------------------
create or replace function public.handles_creator(p_creator_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select is_admin();  -- CHANGED: was is_admin() or an assigned moderator
$function$;

-- ------------------------------------------------------------
-- 3. Staff functions and admin_list_payments are platform-admin only (M2).
--    Only the guard line changes. No page calls the staff_* functions;
--    admin pages call admin_list_payments as an admin.
-- ------------------------------------------------------------
create or replace function public.staff_customer_directory()
 returns table(rn bigint, id uuid, email text, display_name text, total_earned numeric, total_withdrawn numeric, payment_count bigint, link_count bigint, max_links integer, auto_withdraw_enabled boolean, w_binance text, w_usdt text, w_bkash text, w_nagad text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;  -- CHANGED: was is_admin() or is_moderator()

  return query
  select
    row_number() over (order by coalesce(e.earned, 0) desc),
    pr.id, pr.email, pr.display_name,
    coalesce(e.earned, 0), coalesce(w.paid, 0),
    coalesce(e.cnt, 0), coalesce(l.cnt, 0), pr.max_payment_links,
    pr.auto_withdraw_enabled,
    pr.wallet_binance_id, pr.wallet_usdt_bep20, pr.wallet_bkash, pr.wallet_nagad
  from profiles pr
  left join lateral (
    select sum(p.amount_settled) as earned, count(*) as cnt
    from payments p where p.user_id = pr.id and p.status = 'settled') e on true
  left join lateral (
    select sum(wd.amount_after_fee) as paid
    from withdrawals wd where wd.user_id = pr.id and wd.status = 'paid') w on true
  left join lateral (
    select count(*) as cnt from payment_links pl where pl.user_id = pr.id) l on true
  where pr.role = 'creator' and handles_creator(pr.id)
  order by coalesce(e.earned, 0) desc;
end; $function$;

create or replace function public.staff_customer_totals()
 returns table(creator_id uuid, email text, display_name text, settled numeric, pending numeric, expired numeric, withdrawn numeric, payment_count bigint)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_hide_at numeric := small_payment_threshold();
begin
  if not is_admin() then  -- CHANGED: was is_admin() or is_moderator()
    raise exception 'Not authorized';
  end if;

  return query
  select
    pr.id, pr.email, pr.display_name,
    coalesce(sum(p.amount_settled) filter (
      where p.status = 'settled' and not (p.amount_settled < v_hide_at)
    ), 0),
    coalesce(sum(p.amount_requested) filter (where p.status in ('new','pending')), 0),
    coalesce(sum(p.amount_requested) filter (where p.status in ('expired','invalid')), 0),
    coalesce((select sum(w.amount_after_fee) from withdrawals w
              where w.user_id = pr.id and w.status = 'paid'), 0),
    count(p.id) filter (
      where p.status = 'settled' and not (p.amount_settled < v_hide_at)
    )
  from profiles pr
  left join payments p on p.user_id = pr.id
  where pr.role = 'creator' and handles_creator(pr.id)
  group by pr.id, pr.email, pr.display_name
  order by 4 desc;
end;
$function$;

create or replace function public.staff_daily_settled(p_days integer default 14)
 returns table(creator_id uuid, creator_name text, creator_email text, cycle_date date, cycle_start timestamp with time zone, cycle_end timestamp with time zone, settled numeric, payment_count bigint)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_hide_at numeric := small_payment_threshold();
begin
  if not is_admin() then raise exception 'Not authorized'; end if;  -- CHANGED: was is_admin() or is_moderator()

  return query
  with mine as (
    select pr.id, pr.display_name, pr.email
    from profiles pr
    where pr.role = 'creator' and handles_creator(pr.id)
  )
  select
    m.id, m.display_name, m.email,
    b.business_day, b.day_start, b.day_end,
    coalesce(sum(p.amount_settled), 0),
    count(p.id)
  from mine m
  cross join business_days(least(greatest(coalesce(p_days, 14), 1), 60)) b
  left join payments p
    on p.user_id = m.id
   and p.status = 'settled'
   and not (p.amount_settled < v_hide_at)
   and p.settled_at >= b.day_start
   and p.settled_at <  b.day_end
  group by m.id, m.display_name, m.email, b.business_day, b.day_start, b.day_end
  order by b.business_day desc, m.display_name;
end;
$function$;

create or replace function public.staff_global_stats(p_start timestamp with time zone default null::timestamp with time zone, p_end timestamp with time zone default null::timestamp with time zone)
 returns table(total_settled numeric, total_withdrawn numeric, pending_withdrawals_count bigint, pending_withdrawals_amount numeric, payment_count bigint, creator_count bigint)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_hide_at numeric := small_payment_threshold();
begin
  if not is_admin() then  -- CHANGED: was is_admin() or is_moderator()
    raise exception 'Not authorized';
  end if;

  return query
  with mine as (
    select pr.id
    from profiles pr
    where pr.role = 'creator' and handles_creator(pr.id)
  ),
  pay as (
    select coalesce(sum(p.amount_settled), 0) as settled, count(*) as cnt
    from payments p
    join mine m on m.id = p.user_id
    where p.status = 'settled'
      and not (p.amount_settled < v_hide_at)
      and (p_start is null or p.settled_at >= p_start)
      and (p_end   is null or p.settled_at <= p_end)
  ),
  wd as (
    select coalesce(sum(w.amount_after_fee) filter (where w.status = 'paid'), 0) as paid,
           count(*) filter (where w.status in ('pending','approved'))            as pend_cnt,
           coalesce(sum(w.amount_requested) filter (where w.status in ('pending','approved')), 0) as pend_amt
    from withdrawals w
    join mine m on m.id = w.user_id
  )
  select pay.settled, wd.paid, wd.pend_cnt, wd.pend_amt, pay.cnt,
         (select count(*) from mine)
  from pay, wd;
end;
$function$;

create or replace function public.staff_list_payments(p_limit integer default 120, p_offset integer default 0, p_search text default null::text, p_status text default null::text, p_time text default null::text)
 returns table(id uuid, amount_requested numeric, amount_settled numeric, status text, method text, created_at timestamp with time zone, settled_at timestamp with time zone, expires_at timestamp with time zone, customer_city text, customer_country text, creator_id uuid, creator_email text, creator_name text, link_slug text, invoice_ref text, lightning_invoice text, marked_at timestamp with time zone, marked_by_name text, mark_note text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_limit int := least(greatest(coalesce(p_limit, 120), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(nullif(trim(coalesce(p_status, '')), ''));
  v_time text := lower(nullif(trim(coalesce(p_time, '')), ''));
  v_now timestamptz := now();
  v_start timestamptz := null;
  v_hide_at numeric := small_payment_threshold();
begin
  if not is_admin() then  -- CHANGED: was is_admin() or is_moderator()
    raise exception 'Not authorized';
  end if;

  if v_status is not null and v_status not in ('settled', 'new', 'pending', 'expired', 'invalid') then
    raise exception 'Invalid status filter';
  end if;

  if v_time = 'today' then
    v_start := business_day_start(current_business_day());
  elsif v_time = '7d' then
    v_start := v_now - interval '7 days';
  elsif v_time = '30d' then
    v_start := v_now - interval '30 days';
  elsif v_time is null or v_time = '' then
    v_start := null;
  else
    raise exception 'Invalid time filter';
  end if;

  return query
  select
    p.id,
    case when should_show_buyer_amount(p.user_id) then coalesce(p.buyer_amount, p.amount_requested) else p.amount_requested end,
    case when p.amount_settled is null then null
         when should_show_buyer_amount(p.user_id) then coalesce(p.buyer_amount, p.amount_settled)
         else p.amount_settled end,
    p.status,
    p.method,
    p.created_at,
    p.settled_at,
    p.expires_at,
    p.customer_city,
    p.customer_country,
    p.user_id,
    pr.email,
    pr.display_name,
    pl.slug,
    p.invoice_ref,
    p.lightning_invoice,
    p.marked_at,
    mb.display_name,
    p.mark_note
  from payments p
  join profiles pr on pr.id = p.user_id
  left join payment_links pl on pl.id = p.payment_link_id
  left join profiles mb on mb.id = p.marked_by
  where (is_admin() or handles_creator(p.user_id))
    and not (p.status = 'settled' and p.amount_settled < v_hide_at)
    and (
      p_search is null or p_search = ''
      or p.invoice_ref ilike '%' || p_search || '%'
      or p.lightning_invoice ilike '%' || p_search || '%'
      or pr.email ilike '%' || p_search || '%'
      or coalesce(pr.display_name, '') ilike '%' || p_search || '%'
      or coalesce(pl.slug, '') ilike '%' || p_search || '%'
    )
    and (v_status is null or p.status = v_status)
    and (v_start is null or p.created_at >= v_start)
  order by p.created_at desc
  limit v_limit
  offset v_offset;
end;
$function$;

create or replace function public.admin_list_payments(p_limit integer default 100, p_offset integer default 0, p_search text default null::text)
 returns table(id uuid, amount_requested numeric, amount_settled numeric, status text, method text, created_at timestamp with time zone, settled_at timestamp with time zone, expires_at timestamp with time zone, customer_city text, customer_country text, creator_id uuid, creator_email text, creator_name text, link_slug text, invoice_ref text, lightning_invoice text, marked_at timestamp with time zone, marked_by_name text, mark_note text, total_count bigint)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not is_admin() then raise exception 'Not authorized'; end if;  -- CHANGED: was is_admin() or is_moderator()

  return query
  with filtered as (
    select p.*
    from payments p
    join profiles pr on pr.id = p.user_id
    left join payment_links pl on pl.id = p.payment_link_id
    where (is_admin() or handles_creator(p.user_id))
      and (
        v_search is null
        or p.invoice_ref ilike '%' || v_search || '%'
        or p.lightning_invoice ilike '%' || v_search || '%'
        or pr.email ilike '%' || v_search || '%'
        or pl.slug ilike '%' || v_search || '%'
      )
  )
  select
    f.id,
    case when should_show_buyer_amount(f.user_id) then coalesce(f.buyer_amount, f.amount_requested) else f.amount_requested end,
    case when f.amount_settled is null then null
         when should_show_buyer_amount(f.user_id) then coalesce(f.buyer_amount, f.amount_settled)
         else f.amount_settled end,
    f.status, f.method,
    f.created_at, f.settled_at, f.expires_at,
    f.customer_city, f.customer_country,
    f.user_id, pr.email, pr.display_name,
    pl.slug,
    f.invoice_ref, f.lightning_invoice,
    f.marked_at, mb.display_name, f.mark_note,
    count(*) over () as total_count
  from filtered f
  join profiles pr on pr.id = f.user_id
  left join payment_links pl on pl.id = f.payment_link_id
  left join profiles mb on mb.id = f.marked_by
  order by f.created_at desc
  limit v_limit offset v_offset;
end; $function$;

-- ------------------------------------------------------------
-- 4. attach_freelancer_to_reseller (M1).
--    Its only caller is handle_new_user(), the SECURITY DEFINER trigger on
--    auth.users that runs at signup with no JWT (auth.uid() is null). That
--    path is unchanged. Everyone else is refused twice: EXECUTE is revoked
--    from PUBLIC, anon and authenticated (section 5), and the body now
--    returns false without writing for a signed-in caller who is not an
--    active admin. It also refuses to add a freelancer who already belongs
--    to a different reseller. It returns false rather than raising so a
--    refusal can never abort a signup.
-- ------------------------------------------------------------
create or replace function public.attach_freelancer_to_reseller(p_freelancer uuid, p_reseller uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- CHANGED: only signup (no session), the service role, or an active admin.
  if auth.uid() is not null and not is_admin() then return false; end if;
  if p_freelancer is null or p_reseller is null then return false; end if;
  if p_freelancer = p_reseller then return false; end if;
  if not exists (select 1 from profiles where id = p_reseller and role = 'moderator') then
    return false;
  end if;
  -- CHANGED: never attach a freelancer who already belongs to another reseller.
  if exists (
    select 1 from profiles
     where id = p_freelancer
       and referred_by is not null
       and referred_by <> p_reseller
  ) then
    return false;
  end if;
  update profiles set referred_by = p_reseller where id = p_freelancer and referred_by is null;
  insert into moderator_assignments (moderator_id, creator_id)
  values (p_reseller, p_freelancer)
  on conflict do nothing;
  return true;
end;
$function$;

-- ------------------------------------------------------------
-- 5. Grants.
--    Supabase grants EXECUTE on every new public function to anon,
--    authenticated and service_role, and Postgres grants it to PUBLIC, so
--    each REVOKE names all of them. SECURITY DEFINER callers run as the
--    owner and are not affected.
-- ------------------------------------------------------------

-- 5a. Internal only: signup trigger, other SECURITY DEFINER functions and
--     service-role Edge Functions (M1, M5, M8). No RLS policy, view or
--     SECURITY INVOKER function calls any of these.
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.attach_freelancer_to_reseller(uuid, uuid)',  -- M1: handle_new_user()
    'public.system_link_for_invoice(text)',              -- M5: create-invoice (service role)
    'public.cpay_make_affiliate_code(uuid)',             -- M5: handle_new_user(), ensure_reseller_affiliate_code()
    'public.cpay_reseller_commission_percent(uuid)',     -- M5: stamp_payment_platform_fee(), my_earnings_split()
    'public.cpay_reseller_for(uuid)',                    -- M5: no SQL or code caller
    'public.account_is_active(uuid)',                    -- M8: guard_* triggers, onchain_address_create(), reseller_request_withdrawal_for()
    'public.cpay_platform_fee_percent(uuid)',            -- M8: stamp_payment_platform_fee(), admin_list_business_profiles()
    'public.cpay_feature_enabled(uuid, text)',           -- M8: cpay_guard_* triggers, reserve_stablecoin_withdrawal()
    'public.hide_threshold_for(uuid)'                    -- M8: dashboard/balance/telegram SECURITY DEFINER functions
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end $$;

-- 5b. Signed-in only (M6). Each already refuses a caller without a session
--     inside; this removes the anon grant. authenticated is granted
--     explicitly because revoking PUBLIC would otherwise remove it on a
--     database without Supabase's default privileges.
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.admin_customer_directory()',
    'public.admin_list_payment_links()',
    'public.admin_list_payments(integer, integer, text)',
    'public.admin_list_people()',
    'public.admin_list_user_wallets()',
    'public.admin_live_payments()',
    'public.admin_set_user_usdt_wallet(uuid, text, text)',
    'public.staff_list_payments(integer, integer, text, text, text)',
    'public.create_link_variants(text, text[])',
    'public.get_my_payments(integer, integer, text, text)',
    'public.my_reseller_id()'
  ] loop
    execute format('revoke execute on function %s from public, anon', v_sig);
    execute format('grant execute on function %s to authenticated, service_role', v_sig);
  end loop;
end $$;
