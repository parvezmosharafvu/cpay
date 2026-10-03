-- ============================================================
-- revenue_desk(): admins and the service role only
-- ============================================================
-- 20261001050736 created revenue_desk() as SECURITY DEFINER and granted
-- EXECUTE to anon and authenticated. SECURITY DEFINER runs as the owner,
-- so RLS on payments, payment_links and withdrawals does not apply.
-- Anyone holding the public anon key (it ships in public/config.js) could
-- call POST /rest/v1/rpc/revenue_desk and read platform-wide daily totals:
-- each link's display name, invoice counts, requested and settled USD,
-- platform fees, and payout totals by status. Any signed-in freelancer or
-- reseller could do the same.
--
-- Nothing in this repository calls revenue_desk() (no page, edge
-- function or worker), so locking it down breaks no CPAY screen.
--
-- This migration:
--   1. revokes EXECUTE from public, anon and authenticated;
--   2. grants EXECUTE back to authenticated (for a future admin screen)
--      and to service_role;
--   3. adds an in-function check: only is_admin() callers or a
--      service-role JWT get data. Everyone else gets 'Not authorized'.
--      The check is needed because Supabase gives every authenticated
--      user, admin or not, the same database role.
--
-- The report query is unchanged from 20261001050736. Only the language
-- (sql -> plpgsql, so it can raise) and the guard are new.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.revenue_desk()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_service_role boolean := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) = 'service_role';
begin
  if not (v_is_service_role or is_admin()) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return (
    select jsonb_build_object(
      'generated_at', to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'currency', 'USD',
      'invoices', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'opened', opened,
            'settled_day', settled_day,
            'link', link,
            'status', status,
            'count', cnt,
            'requested', requested,
            'settled', settled,
            'fees', fees
          )
          order by opened, link, status
        )
        from (
          select
            to_char((p.created_at at time zone 'utc'), 'YYYY-MM-DD') as opened,
            case
              when p.status = 'settled' and p.settled_at is not null
                then to_char((p.settled_at at time zone 'utc'), 'YYYY-MM-DD')
              else null
            end as settled_day,
            coalesce(nullif(btrim(l.display_name), ''), 'Untitled link') as link,
            p.status as status,
            count(*)::int as cnt,
            round(coalesce(sum(p.amount_requested), 0)::numeric, 2) as requested,
            round(coalesce(sum(
              case when p.status = 'settled' then coalesce(p.amount_settled, 0) else 0 end
            ), 0)::numeric, 2) as settled,
            round(coalesce(sum(
              case when p.status = 'settled' then coalesce(p.platform_fee_amount, 0) else 0 end
            ), 0)::numeric, 2) as fees
          from public.payments p
          left join public.payment_links l on l.id = p.payment_link_id
          group by 1, 2, 3, 4
        ) rolled
      ), '[]'::jsonb),
      'payouts', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'status', status,
            'count', cnt,
            'requested', requested,
            'net', net
          )
          order by status
        )
        from (
          select
            w.status as status,
            count(*)::int as cnt,
            round(coalesce(sum(w.amount_requested), 0)::numeric, 2) as requested,
            round(coalesce(sum(w.amount_after_fee), 0)::numeric, 2) as net
          from public.withdrawals w
          group by w.status
        ) rolled
      ), '[]'::jsonb)
    )
  );
end;
$$;

comment on function public.revenue_desk() is
  'Aggregate platform revenue snapshot. Admins (is_admin()) and service_role only; anon has no EXECUTE.';

revoke all on function public.revenue_desk() from public;
revoke all on function public.revenue_desk() from anon, authenticated;
grant execute on function public.revenue_desk() to authenticated, service_role;
