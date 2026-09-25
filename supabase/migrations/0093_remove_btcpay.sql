-- ============================================================
-- CPAY — 0093: remove BTCPay Server
-- ============================================================
-- BTCPay is being replaced by Breez SDK Spark. This drops everything that
-- existed only to route invoices to BTCPay stores:
--
--   * btcpay_shops, and the shop pointers on payment_links and profiles
--     (shop_id, shop_locked, forced_shop_id)
--   * the admin and creator RPCs that managed shops and shop locks
--   * payments.btcpay_store_id / btcpay_api_key_env, which only told the
--     old webhook which store and key to read an invoice back from
--   * link_cost_for_slug(), whose only extra over get_link_preview() was
--     the shop surcharge, and which nothing calls
--
-- Pricing is unaffected: since 0063 the payer markup comes from
-- payment_links.cost_percent / profiles.cost_percent, and the shop
-- surcharge was display-only.
--
-- payments.btcpay_invoice_id is RENAMED, not dropped, to invoice_ref. It
-- is ledger history (customers look payments up by it), and its UNIQUE
-- constraint is the idempotency key the Breez integration will reuse:
-- Breez rows store the Lightning payment hash there.
--
-- Every function that read a dropped column is redefined below. plpgsql
-- and plain SQL function bodies are not dependency-tracked, so dropping a
-- column they read would succeed here and fail at call time instead.
-- ============================================================


-- ---------- 1. Shop management RPCs ----------
drop function if exists admin_customer_shop_lock(uuid);
drop function if exists admin_delete_shop(uuid);
drop function if exists admin_list_shops();
drop function if exists admin_lock_creator_shop(uuid, boolean, uuid);
drop function if exists admin_set_link_shop(uuid, uuid);
drop function if exists admin_upsert_shop(uuid, text, text, numeric, text, boolean, boolean, integer);
drop function if exists set_link_shop(uuid, uuid);
drop function if exists link_cost_for_slug(text);


-- ---------- 2. payment_links guard, without the shop rules ----------
drop trigger if exists trg_guard_link_shop_updates on payment_links;
drop function if exists guard_link_shop_updates();

create or replace function guard_link_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;

  if new.user_id is distinct from auth.uid() then
    raise exception 'Cannot create or move a link for another user';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'Cannot change link owner';
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'Deleted links cannot be restored from here';
  end if;
  if new.cost_percent is distinct from old.cost_percent
     and new.cost_percent is not null
     and (new.cost_percent < 0 or new.cost_percent > 1000) then
    raise exception 'Cost must be between 0 and 1000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_link_updates on payment_links;
create trigger trg_guard_link_updates
  before insert or update on payment_links
  for each row execute function guard_link_updates();


-- ---------- 3. profiles guard, without the shop-lock columns ----------
create or replace function guard_profile_updates()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;
  if new.id                         is distinct from old.id
  or new.email                      is distinct from old.email
  or new.role                       is distinct from old.role
  or new.withdrawal_fee_percent     is distinct from old.withdrawal_fee_percent
  or new.max_payment_links          is distinct from old.max_payment_links
  or new.auto_withdraw_enabled      is distinct from old.auto_withdraw_enabled
  or new.buy_rate                   is distinct from old.buy_rate
  or new.sell_rate                  is distinct from old.sell_rate
  or new.show_buyer_amount_override is distinct from old.show_buyer_amount_override
  then
    raise exception 'You may only change your display name and wallet details';
  end if;
  return new;
end;
$$;


-- ---------- 4. Columns and table ----------
alter table payment_links drop column if exists shop_id;
alter table profiles drop column if exists shop_locked;
alter table profiles drop column if exists forced_shop_id;
alter table payments drop column if exists btcpay_store_id;
alter table payments drop column if exists btcpay_api_key_env;
drop table if exists btcpay_shops;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'payments'
               and column_name = 'btcpay_invoice_id') then
    alter table payments rename column btcpay_invoice_id to invoice_ref;
    alter table payments rename constraint payments_btcpay_invoice_id_key to payments_invoice_ref_key;
  end if;
end $$;
-- Duplicate of the index behind the UNIQUE constraint above.
drop index if exists idx_payments_btcpay;
comment on column payments.invoice_ref is
  'Payment processor reference, unique. BTCPay invoice id on rows created before 0093; the Lightning payment hash (hex) on Breez rows. The UNIQUE constraint is what stops a retried event from recording a payment twice.';


-- ---------- 5. Release gates: provider-neutral category ----------
delete from ops_release_gates where gate_key = 'separate_btcpay_store';
alter table ops_release_gates drop constraint if exists ops_release_gates_category_check;
update ops_release_gates set category = 'payments' where category = 'btcpay';
alter table ops_release_gates add constraint ops_release_gates_category_check
  check (category in ('foundation', 'payments', 'ledger', 'withdrawals', 'release'));


-- ---------- 6. Read RPCs whose result columns change ----------
-- DROP + CREATE: Postgres cannot change a function's result columns in
-- place. Each is re-granted exactly as before (PUBLIC revoked).

drop function if exists admin_list_payment_links();
create or replace function admin_list_payment_links()
returns table(id uuid, slug text, display_name text, is_active boolean, created_at timestamptz,
              owner_email text, owner_name text, total_earned numeric, payment_count bigint,
              cost_percent numeric, cost_is_override boolean, theme text)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select pl.id, pl.slug, pl.display_name, pl.is_active, pl.created_at,
    pr.email, pr.display_name,
    coalesce((select sum(p.amount_settled) from payments p where p.payment_link_id = pl.id and p.status = 'settled'), 0),
    coalesce((select count(*) from payments p where p.payment_link_id = pl.id and p.status = 'settled'), 0),
    coalesce(pl.cost_percent, pr.cost_percent, 0),
    pl.cost_percent is not null, pl.theme
  from payment_links pl
  join profiles pr on pr.id = pl.user_id
  where pl.deleted_at is null
  order by pl.created_at desc;
end; $$;
revoke all on function admin_list_payment_links() from public;
grant execute on function admin_list_payment_links() to authenticated;

drop function if exists admin_list_payments(integer, integer, text);
create or replace function admin_list_payments(p_limit integer default 100, p_offset integer default 0, p_search text default null)
returns table(id uuid, amount_requested numeric, amount_settled numeric, status text, method text,
              created_at timestamptz, settled_at timestamptz, expires_at timestamptz,
              customer_city text, customer_country text, creator_id uuid, creator_email text,
              creator_name text, link_slug text, invoice_ref text, lightning_invoice text,
              marked_at timestamptz, marked_by_name text, mark_note text, total_count bigint)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not (is_admin() or is_moderator()) then raise exception 'Not authorized'; end if;

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
end; $$;
revoke all on function admin_list_payments(integer, integer, text) from public;
grant execute on function admin_list_payments(integer, integer, text) to authenticated;

drop function if exists admin_list_people();
create or replace function admin_list_people()
returns table(id uuid, email text, display_name text, role text, withdrawal_fee_percent numeric,
              max_payment_links integer, auto_withdraw_enabled boolean, cost_percent numeric,
              total_settled numeric, available_balance numeric, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select
    pr.id, pr.email, pr.display_name, pr.role,
    pr.withdrawal_fee_percent, pr.max_payment_links,
    pr.auto_withdraw_enabled,
    coalesce(pr.cost_percent, 0),
    coalesce((select sum(p.amount_settled) from payments p
              where p.user_id = pr.id and p.status = 'settled'), 0),
    coalesce((select b.available from get_balance_for(pr.id) b), 0),
    pr.created_at
  from profiles pr
  where pr.role in ('creator', 'moderator')
  order by pr.created_at desc;
end;
$$;
revoke all on function admin_list_people() from public;
grant execute on function admin_list_people() to authenticated;

drop function if exists admin_live_payments();
create or replace function admin_live_payments()
returns table(id uuid, invoice_ref text, lightning_invoice text, amount_requested numeric, status text,
              created_at timestamptz, expires_at timestamptz, customer_city text, customer_country text,
              creator_email text, creator_name text, link_slug text)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select p.id, p.invoice_ref, p.lightning_invoice, p.amount_requested, p.status,
         p.created_at, p.expires_at, p.customer_city, p.customer_country,
         pr.email, pr.display_name, pl.slug
  from payments p
  join profiles pr on pr.id = p.user_id
  left join payment_links pl on pl.id = p.payment_link_id
  where p.status in ('new', 'pending')
  order by p.created_at desc;
end; $$;
revoke all on function admin_live_payments() from public;
grant execute on function admin_live_payments() to authenticated;

-- p_shop_id is gone: a link no longer has a shop to pick.
drop function if exists create_link_variants(text, text[], uuid);
create or replace function create_link_variants(p_display_name text, p_styles text[])
returns table(slug text, style text, created boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_group uuid := gen_random_uuid();
  v_name text;
  v_style text;
  v_slug text;
  v_seen text[] := '{}';
  v_any boolean := false;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  v_name := title_case_name(p_display_name);
  if v_name = '' then raise exception 'Please enter a name for the link'; end if;
  if length(v_name) > 60 then raise exception 'Name is too long'; end if;
  if slug_from_name(v_name, 'kebab') = '' then
    raise exception 'Name must contain letters or numbers';
  end if;
  if p_styles is null or array_length(p_styles, 1) is null then
    raise exception 'Pick at least one link style';
  end if;

  foreach v_style in array p_styles loop
    if v_style not in ('kebab','pascal','lower','title-kebab') then
      raise exception 'Unknown link style: %', v_style;
    end if;

    v_slug := slug_from_name(v_name, v_style);
    if v_slug = '' or v_slug = any(v_seen) then continue; end if;
    v_seen := v_seen || v_slug;

    if exists (select 1 from payment_links pl where pl.slug = v_slug) then
      return query select v_slug, v_style, false;
      continue;
    end if;

    insert into payment_links (user_id, slug, display_name, slug_style, variant_group, is_active)
    values (v_uid, v_slug, v_name, v_style, v_group, true);

    v_any := true;
    return query select v_slug, v_style, true;
  end loop;

  if not v_any then raise exception 'Those links already exist'; end if;
end;
$$;
revoke all on function create_link_variants(text, text[]) from public;
grant execute on function create_link_variants(text, text[]) to authenticated;

drop function if exists get_link_preview(text);
create or replace function get_link_preview(p_slug text)
returns table(display_name text, is_active boolean, og_image text, cost_percent numeric,
              theme text, wallet_mode text, invoice_theme text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    pl.display_name,
    pl.is_active,
    pl.og_image,
    coalesce(pl.cost_percent, pr.cost_percent, 0),
    pl.theme,
    coalesce(pl.wallet_mode, pr.default_wallet_mode, 'all_wallets'),
    coalesce(pl.invoice_theme, 'default')
  from payment_links pl
  join profiles pr on pr.id = pl.user_id
  where pl.slug = p_slug
    and pl.deleted_at is null
    and pr.account_status = 'active'
  limit 1;
$$;
revoke all on function get_link_preview(text) from public;
grant execute on function get_link_preview(text) to anon, authenticated;

drop function if exists get_my_payments(integer, integer, text, text);
create or replace function get_my_payments(p_limit integer default 60, p_offset integer default 0,
                                           p_search text default null, p_status text default null)
returns table(id uuid, amount_requested numeric, amount_settled numeric, status text, method text,
              created_at timestamptz, settled_at timestamptz, expires_at timestamptz,
              customer_city text, customer_country text, link_slug text, link_name text,
              invoice_ref text, lightning_invoice text, marked_at timestamptz,
              marked_by_name text, marked_by_self boolean, mark_note text, total_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 60), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(nullif(trim(coalesce(p_status, '')), ''));
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_hide_at numeric := small_payment_threshold();
  v_show_buyer boolean;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  v_show_buyer := should_show_buyer_amount(v_uid);

  if v_status is not null
     and v_status not in ('settled', 'new', 'pending', 'expired', 'invalid') then
    raise exception 'Invalid status filter';
  end if;

  return query
  with filtered as (
    select p.*
    from payments p
    left join payment_links pl on pl.id = p.payment_link_id
    where p.user_id = v_uid
      and (v_status is null or p.status = v_status)
      and not (p.status = 'settled' and p.amount_settled < v_hide_at)
      and (
        v_search is null
        or p.invoice_ref ilike '%' || v_search || '%'
        or p.lightning_invoice ilike '%' || v_search || '%'
        or pl.slug ilike '%' || v_search || '%'
      )
  )
  select
    f.id,
    case when v_show_buyer then coalesce(f.buyer_amount, f.amount_requested) else f.amount_requested end,
    case when f.amount_settled is null then null
         when v_show_buyer then coalesce(f.buyer_amount, f.amount_settled)
         else f.amount_settled end,
    f.status, f.method,
    f.created_at, f.settled_at, f.expires_at,
    f.customer_city, f.customer_country,
    pl.slug, pl.display_name,
    f.invoice_ref, f.lightning_invoice,
    f.marked_at, mb.display_name, f.marked_by = v_uid, f.mark_note,
    count(*) over () as total_count
  from filtered f
  left join payment_links pl on pl.id = f.payment_link_id
  left join profiles mb on mb.id = f.marked_by
  order by f.created_at desc
  limit v_limit offset v_offset;
end;
$$;
revoke all on function get_my_payments(integer, integer, text, text) from public;
grant execute on function get_my_payments(integer, integer, text, text) to authenticated;

drop function if exists staff_list_payments(integer, integer, text, text, text);
create or replace function staff_list_payments(p_limit integer default 120, p_offset integer default 0,
                                               p_search text default null, p_status text default null,
                                               p_time text default null)
returns table(id uuid, amount_requested numeric, amount_settled numeric, status text, method text,
              created_at timestamptz, settled_at timestamptz, expires_at timestamptz,
              customer_city text, customer_country text, creator_id uuid, creator_email text,
              creator_name text, link_slug text, invoice_ref text, lightning_invoice text,
              marked_at timestamptz, marked_by_name text, mark_note text)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 120), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(nullif(trim(coalesce(p_status, '')), ''));
  v_time text := lower(nullif(trim(coalesce(p_time, '')), ''));
  v_now timestamptz := now();
  v_start timestamptz := null;
  v_hide_at numeric := small_payment_threshold();
begin
  if not (is_admin() or is_moderator()) then
    raise exception 'Not authorized';
  end if;

  if v_status is not null and v_status not in ('settled', 'new', 'pending', 'expired', 'invalid') then
    raise exception 'Invalid status filter';
  end if;

  if v_time = 'today' then
    v_start := date_trunc('day', v_now);
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
$$;
revoke all on function staff_list_payments(integer, integer, text, text, text) from public;
grant execute on function staff_list_payments(integer, integer, text, text, text) to authenticated;

drop function if exists system_link_for_invoice(text);
create or replace function system_link_for_invoice(p_slug text)
returns table(link_id uuid, user_id uuid, slug text, display_name text, is_active boolean, cost_percent numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  select pl.id, pl.user_id, pl.slug, pl.display_name, pl.is_active,
         coalesce(pl.cost_percent, pr.cost_percent, 0)
  from payment_links pl
  join profiles pr on pr.id = pl.user_id
  where pl.slug = p_slug and pl.deleted_at is null and pr.account_status = 'active'
  limit 1;
$$;
revoke all on function system_link_for_invoice(text) from public;
grant execute on function system_link_for_invoice(text) to service_role;


-- ---------- 7. Same signature, body no longer reads shops ----------
create or replace function lookup_payment_status(p_reference text)
returns table(amount numeric, status text, created_at timestamptz, settled_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_ref text := trim(coalesce(p_reference, ''));
begin
  if length(v_ref) < 12 then
    raise exception 'Enter the full invoice ID or Lightning address';
  end if;

  return query
  select
    case when should_show_buyer_amount(p.user_id)
         then coalesce(p.buyer_amount, p.amount_settled, p.amount_requested)
         else coalesce(p.amount_settled, p.amount_requested)
    end,
    p.status, p.created_at, p.settled_at
  from payments p
  where p.invoice_ref = v_ref or p.lightning_invoice = v_ref
  limit 1;
end;
$$;

create or replace function admin_mark_payment(p_payment_id uuid, p_status text, p_amount_settled numeric default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $_$
declare
  v_payment payments;
  v_is_service_role boolean;
  v_max_allowed numeric;
begin
  v_is_service_role := coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) = 'service_role';

  if not (is_admin() or v_is_service_role) then
    raise exception 'Not authorized';
  end if;

  if p_status not in ('settled', 'expired', 'invalid') then
    raise exception 'Invalid status';
  end if;

  select * into v_payment from payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;

  if v_payment.status = 'settled' then
    raise exception 'This payment is already settled';
  end if;

  if p_status = 'settled' then
    if p_amount_settled is not null and p_amount_settled <= 0 then
      raise exception 'Settled amount must be positive';
    end if;

    -- 2% headroom for a payer who rounds up; nothing beyond that without
    -- a real reason, since this figure becomes withdrawable balance.
    v_max_allowed := round(v_payment.amount_requested * 1.02, 2);
    if p_amount_settled is not null and p_amount_settled > v_max_allowed then
      raise exception
        'Settled amount $% exceeds the requested $% by more than 2%%. '
        'A genuine overpayment should be verified against the payment provider directly.',
        p_amount_settled, v_payment.amount_requested;
    end if;

    update payments
      set status = 'settled',
          settled_at = now(),
          amount_settled = coalesce(p_amount_settled, amount_requested)
      where id = p_payment_id;

    perform record_audit(
      'payment.manually_settled', 'payment', p_payment_id::text,
      jsonb_build_object('status', v_payment.status),
      jsonb_build_object('status', 'settled',
                         'amount_settled', coalesce(p_amount_settled, v_payment.amount_requested),
                         'amount_requested', v_payment.amount_requested)
    );
  else
    update payments set status = p_status where id = p_payment_id;
  end if;
end;
$_$;


-- ---------- 8. Snapshots without the shop counters ----------
create or replace function admin_ops_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_snapshot jsonb;
begin
  if not is_admin() then
    raise exception 'Not authorized';
  end if;

  select jsonb_build_object(
    'checked_at', now(),
    'domains', jsonb_build_object(
      'active', (select count(*) from site_domains where is_active = true),
      'payment_ready', (
        select count(*) from site_domains
        where is_active = true and purpose in ('payment', 'both')
      )
    ),
    'flags', jsonb_build_object(
      'manual_withdrawals_enabled',
        coalesce((select value::text = 'true' from app_settings where key = 'manual_withdrawals_enabled'), true),
      'emergency_payments_stop',
        coalesce((select value::text = 'true' from app_settings where key = 'emergency_payments_stop'), false),
      'emergency_withdrawals_stop',
        coalesce((select value::text = 'true' from app_settings where key = 'emergency_withdrawals_stop'), false),
      'auto_withdraw_enabled',
        coalesce((select value::text = 'true' from app_settings where key = 'auto_withdraw_enabled'), false)
    ),
    'withdrawals', jsonb_build_object(
      'pending_count', (
        select count(*) from withdrawals where status in ('pending', 'approved')
      ),
      'pending_amount', (
        select coalesce(sum(amount_requested), 0) from withdrawals
        where status in ('pending', 'approved')
      ),
      'processing_count', (
        select count(*) from withdrawals where status = 'processing'
      )
    ),
    'pipeline', jsonb_build_object(
      'last_webhook_at', (select max(received_at) from webhook_events),
      'last_daily_stat_at', (select max(computed_at) from daily_stats)
    ),
    'profiles', jsonb_build_object(
      'active', (select count(*) from profiles where account_status = 'active'),
      'pending', (select count(*) from profiles where account_status = 'pending'),
      'suspended', (select count(*) from profiles where account_status = 'suspended')
    ),
    'receiving', jsonb_build_object(
      'active_onchain_addresses', (
        select count(*) from onchain_addresses where is_active = true
      )
    )
  )
  into v_snapshot;

  return v_snapshot;
end;
$function$
;

create or replace function admin_system_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;

  select jsonb_build_object(
    'checked_at', now(),
    'database', jsonb_build_object(
      'size_bytes', pg_database_size(current_database()),
      'size_pretty', pg_size_pretty(pg_database_size(current_database()))
    ),
    'traffic', jsonb_build_object(
      'payments_24h', (select count(*) from payments where created_at >= now() - interval '24 hours'),
      'settled_24h', (select count(*) from payments where status='settled' and settled_at >= now() - interval '24 hours'),
      'withdrawals_24h', (select count(*) from withdrawals where requested_at >= now() - interval '24 hours'),
      'new_profiles_24h', (select count(*) from profiles where created_at >= now() - interval '24 hours')
    ),
    'queues', jsonb_build_object(
      'pending_withdrawals', (select count(*) from withdrawals where status in ('pending','approved')),
      'processing_withdrawals', (select count(*) from withdrawals where status='processing'),
      'new_payments', (select count(*) from payments where status='new'),
      'pending_payments', (select count(*) from payments where status='pending'),
      'pending_applications', (select count(*) from account_applications where status='pending')
    ),
    'platform', jsonb_build_object(
      'profiles', (select count(*) from profiles),
      'active_profiles', (select count(*) from profiles where account_status='active'),
      'payment_links', (select count(*) from payment_links where deleted_at is null),
      'active_links', (select count(*) from payment_links where deleted_at is null and is_active=true),
      'domains', (select count(*) from site_domains where is_active=true)
    ),
    'latency', jsonb_build_object(
      'last_webhook_at', (select max(received_at) from webhook_events),
      'last_settled_at', (select max(settled_at) from payments where status='settled'),
      'oldest_pending_withdrawal_at', (select min(requested_at) from withdrawals where status in ('pending','approved')),
      'oldest_pending_payment_at', (select min(created_at) from payments where status='pending')
    ),
    'table_sizes', jsonb_build_object(
      'payments', pg_total_relation_size('public.payments'),
      'withdrawals', pg_total_relation_size('public.withdrawals'),
      'payment_links', pg_total_relation_size('public.payment_links'),
      'audit_log', pg_total_relation_size('public.audit_log'),
      'profiles', pg_total_relation_size('public.profiles')
    )
  ) into v;

  return v;
end;
$function$
;
