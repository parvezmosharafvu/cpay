-- Admin panel: paginated, filterable, server-authorised reads.
-- Every function re-checks is_admin() on the server; the browser is never trusted.
-- Nothing here returns keys, seeds, or wallet secrets.

create or replace function public.admin_list_withdrawals_page(
  p_limit integer default 50, p_offset integer default 0,
  p_status text default null, p_search text default null)
returns table(id uuid, user_id uuid, account_email text, account_name text,
  amount_requested numeric, fee_percent numeric, amount_after_fee numeric,
  method text, destination text, status text, admin_note text,
  requested_at timestamptz, processed_at timestamptz, total_count bigint)
language plpgsql security definer stable set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_status text := nullif(trim(coalesce(p_status, '')), '');
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select w.id, w.user_id, pr.email, pr.display_name, w.amount_requested, w.fee_percent,
         w.amount_after_fee, w.method, w.destination, w.status, w.admin_note,
         w.requested_at, w.processed_at, count(*) over ()
    from withdrawals w
    left join profiles pr on pr.id = w.user_id
   where (v_status is null or w.status = v_status)
     and (v_search is null or pr.email ilike '%' || v_search || '%'
          or w.destination ilike '%' || v_search || '%'
          or w.id::text ilike v_search || '%')
   order by w.requested_at desc nulls last
   limit v_limit offset v_offset;
end; $$;
revoke all on function public.admin_list_withdrawals_page(integer, integer, text, text) from public, anon;
grant execute on function public.admin_list_withdrawals_page(integer, integer, text, text) to authenticated;

create or replace function public.admin_payment_detail(p_payment_id uuid)
returns jsonb
language plpgsql security definer stable set search_path = public as $$
declare v jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  select jsonb_build_object(
    'id', p.id, 'status', p.status, 'method', p.method,
    'amount_requested', p.amount_requested, 'amount_settled', p.amount_settled,
    'amount_sat', p.amount_sat, 'invoice_ref', p.invoice_ref,
    'created_at', p.created_at, 'settled_at', p.settled_at, 'expires_at', p.expires_at,
    'customer_city', p.customer_city, 'customer_country', p.customer_country,
    'creator_email', pr.email, 'creator_name', pr.display_name,
    'link_slug', pl.slug, 'marked_at', p.marked_at, 'mark_note', p.mark_note,
    'receipts', coalesce((
      select jsonb_agg(jsonb_build_object('received_at', e.received_at,
               'outcome', e.settlement_outcome, 'receipt_amount_sat', e.receipt_amount_sat)
             order by e.received_at desc)
        from webhook_events e
       where e.invoice_id = p.invoice_ref and e.event_type = 'breez.payment_received'), '[]'::jsonb)
  ) into v
  from payments p
  left join profiles pr on pr.id = p.user_id
  left join payment_links pl on pl.id = p.payment_link_id
  where p.id = p_payment_id;
  if v is null then raise exception 'Payment not found'; end if;
  return v;
end; $$;
revoke all on function public.admin_payment_detail(uuid) from public, anon;
grant execute on function public.admin_payment_detail(uuid) to authenticated;

create or replace function public.admin_reconciliation_page(
  p_limit integer default 50, p_offset integer default 0, p_outcome text default null)
returns table(received_at timestamptz, breez_payment_id text, payment_hash text,
  receipt_amount_sat bigint, settlement_outcome text, payment_id uuid,
  invoice_amount_sat bigint, creator_email text, total_count bigint)
language plpgsql security definer stable set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_outcome text := nullif(trim(coalesce(p_outcome, '')), '');
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select e.received_at, substring(e.delivery_id from 7), e.invoice_id,
         e.receipt_amount_sat, e.settlement_outcome, p.id, p.amount_sat, pr.email,
         count(*) over ()
    from webhook_events e
    left join payments p on p.invoice_ref = e.invoice_id
    left join profiles pr on pr.id = p.user_id
   where e.event_type = 'breez.payment_received'
     and e.settlement_outcome in ('unknown','underpaid','overpaid','already_settled','not_settleable')
     and (v_outcome is null or e.settlement_outcome = v_outcome)
   order by e.received_at desc
   limit v_limit offset v_offset;
end; $$;
revoke all on function public.admin_reconciliation_page(integer, integer, text) from public, anon;
grant execute on function public.admin_reconciliation_page(integer, integer, text) to authenticated;

create or replace function public.admin_security_events(
  p_limit integer default 50, p_offset integer default 0, p_search text default null)
returns table(id bigint, occurred_at timestamptz, actor_email text, action text,
  subject_type text, subject_id text, note text, total_count bigint)
language plpgsql security definer stable set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select a.id, a.occurred_at, a.actor_email, a.action, a.subject_type, a.subject_id, a.note,
         count(*) over ()
    from audit_log a
   where (a.action like 'profile.account_control%' or a.action like 'profile.emergency%'
          or a.action like 'profile.bulk_account%' or a.action like 'profile.verification%'
          or a.action like 'profile.feature_flag%' or a.action like 'reseller.%'
          or a.action like 'domain.%' or a.action like 'settings.%'
          or a.action like '%role%' or a.action like '%denied%')
     and (v_search is null or a.action ilike '%' || v_search || '%'
          or a.actor_email ilike '%' || v_search || '%')
   order by a.occurred_at desc
   limit v_limit offset v_offset;
end; $$;
revoke all on function public.admin_security_events(integer, integer, text) from public, anon;
grant execute on function public.admin_security_events(integer, integer, text) to authenticated;

create or replace function public.admin_role_overview()
returns jsonb
language plpgsql security definer stable set search_path = public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return jsonb_build_object(
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('role', r, 'accounts', c) order by r), '[]'::jsonb)
                from (select role as r, count(*) as c from profiles group by role) s),
    'admins', (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'display_name', display_name,
                      'account_status', account_status) order by email), '[]'::jsonb)
                 from profiles where role = 'admin'),
    'permissions', jsonb_build_array(
      jsonb_build_object('area', 'Dashboard, health, system, audit, security, reconciliation, wallet', 'admin', true, 'moderator', false, 'creator', false),
      jsonb_build_object('area', 'Withdrawals: approve, reject, mark paid', 'admin', true, 'moderator', false, 'creator', false),
      jsonb_build_object('area', 'Payments: view', 'admin', true, 'moderator', 'assigned accounts only', 'creator', false),
      jsonb_build_object('area', 'Accounts, fees, limits, flags', 'admin', true, 'moderator', false, 'creator', false)
    ));
end; $$;
revoke all on function public.admin_role_overview() from public, anon;
grant execute on function public.admin_role_overview() to authenticated;
