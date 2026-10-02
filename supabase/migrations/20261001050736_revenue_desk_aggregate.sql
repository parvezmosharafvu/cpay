-- Already applied on the linked project (version 20261001050736).
-- Aggregate-only snapshot for the public revenue desk. No payer identity.
drop function if exists public.revenue_desk();

create function public.revenue_desk()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
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
  );
$$;

comment on function public.revenue_desk() is
  'Aggregate-only snapshot for the public revenue desk. No payer identity, invoices, wallets, or emails.';

revoke all on function public.revenue_desk() from public;
revoke all on function public.revenue_desk() from anon, authenticated;
grant execute on function public.revenue_desk() to anon, authenticated;
