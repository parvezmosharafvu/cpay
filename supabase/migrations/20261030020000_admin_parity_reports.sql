-- M13: reporting and administrative statements. No payment/withdrawal ledger mutation.
-- Administrative statements are records for reconciliation only, not a
-- Lightning invoice, a payment, or an instruction to credit a balance.

create table if not exists public.admin_statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  amount_usd numeric(14,2) not null check (amount_usd > 0 and amount_usd <= 1000000),
  due_on date,
  status text not null default 'outstanding' check (status in ('draft','outstanding','paid','cancelled')),
  external_reference text check (external_reference is null or char_length(external_reference) between 4 and 200),
  created_by uuid not null references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint admin_statements_paid_has_reference check (status <> 'paid' or external_reference is not null)
);
create index if not exists admin_statements_user_due on public.admin_statements(user_id,due_on desc);
create index if not exists admin_statements_status_created on public.admin_statements(status,created_at desc);
alter table public.admin_statements enable row level security;
revoke all on public.admin_statements from public, anon, authenticated;
grant select, insert, update, delete on public.admin_statements to service_role;

create or replace function public.admin_statement_list(p_status text default null)
returns table(id uuid,user_id uuid,owner_name text,title text,description text,amount_usd numeric,due_on date,status text,external_reference text,created_at timestamptz,updated_at timestamptz,paid_at timestamptz)
language plpgsql security definer stable set search_path=public as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if p_status is not null and p_status not in ('draft','outstanding','paid','cancelled') then raise exception 'Bad status'; end if;
  return query
    select s.id,s.user_id,p.display_name,s.title,s.description,s.amount_usd,s.due_on,s.status,s.external_reference,s.created_at,s.updated_at,s.paid_at
    from public.admin_statements s join public.profiles p on p.id=s.user_id
    where p_status is null or s.status=p_status
    order by s.created_at desc limit 250;
end $$;
revoke all on function public.admin_statement_list(text) from public, anon;
grant execute on function public.admin_statement_list(text) to authenticated;

create or replace function public.admin_statement_write(
  p_id uuid, p_user uuid, p_title text, p_description text,
  p_amount numeric, p_due date, p_status text, p_reference text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_old jsonb; v_ref text:=nullif(btrim(coalesce(p_reference,'')),'');
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not strong_session() then raise exception 'Sign in again with your passkey first'; end if;
  if p_status not in ('draft','outstanding','paid','cancelled') then raise exception 'Invalid statement status'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 3 and 120 then raise exception 'Invalid title'; end if;
  if p_description is null or char_length(p_description)>1000 then raise exception 'Invalid description'; end if;
  if p_amount is null or p_amount<=0 or p_amount>1000000 or scale(p_amount)>2 then raise exception 'Invalid amount'; end if;
  if p_status='paid' and (v_ref is null or char_length(v_ref) not between 4 and 200) then raise exception 'A payment reference is required'; end if;
  if v_ref is not null and char_length(v_ref)>200 then raise exception 'Reference too long'; end if;
  if not exists(select 1 from public.profiles where id=p_user and role<>'admin') then raise exception 'Account not found'; end if;
  if p_id is null then
    insert into public.admin_statements(user_id,title,description,amount_usd,due_on,status,external_reference,created_by,updated_by,paid_at)
    values(p_user,btrim(p_title),p_description,p_amount,p_due,p_status,v_ref,auth.uid(),auth.uid(),case when p_status='paid' then now() else null end)
    returning id into v_id;
  else
    select to_jsonb(s) into v_old from public.admin_statements s where s.id=p_id for update;
    if v_old is null then raise exception 'Statement not found'; end if;
    if v_old->>'status' in ('paid','cancelled') then raise exception 'Finalized statement cannot be edited'; end if;
    update public.admin_statements set user_id=p_user,title=btrim(p_title),description=p_description,amount_usd=p_amount,
      due_on=p_due,status=p_status,external_reference=v_ref,updated_by=auth.uid(),updated_at=now(),
      paid_at=case when p_status='paid' then now() else null end
    where id=p_id;
    v_id:=p_id;
  end if;
  perform record_audit('admin.statement_write','statement',v_id::text,
    case when v_old is null then null else jsonb_build_object('status',v_old->>'status','amount',v_old->>'amount_usd') end,
    jsonb_build_object('status',p_status,'amount',p_amount,'user_id',p_user,'reference_provided',v_ref is not null));
  return v_id;
end $$;
revoke all on function public.admin_statement_write(uuid,uuid,text,text,numeric,date,text,text) from public, anon;
grant execute on function public.admin_statement_write(uuid,uuid,text,text,numeric,date,text,text) to authenticated;

-- Monthly member report: exact timestamps in Asia/Dhaka; never aggregate
-- from the limited client-side payment list.
create or replace function public.my_monthly_report(p_month date default null)
returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_user uuid:=auth.uid(); v_month date; v_start timestamptz; v_end timestamptz; v_data jsonb;
begin
  if v_user is null or not account_is_active(v_user) then raise exception 'Active account required'; end if;
  v_month:=date_trunc('month',coalesce(p_month,(now() at time zone 'Asia/Dhaka')::date))::date;
  if v_month > date_trunc('month',(now() at time zone 'Asia/Dhaka'))::date or
     v_month < (date_trunc('month',(now() at time zone 'Asia/Dhaka')) - interval '24 months')::date
  then raise exception 'Month outside report window'; end if;
  v_start:=v_month::timestamp at time zone 'Asia/Dhaka';
  v_end:=(v_month + interval '1 month')::timestamp at time zone 'Asia/Dhaka';
  with a as (
    select p.*,coalesce(l.display_name,l.slug,'Payment link') as link_name
    from public.payments p left join public.payment_links l on l.id=p.payment_link_id
    where p.user_id=v_user and p.created_at>=v_start and p.created_at<v_end
  ), totals as (
    select count(*)::int as attempts,
    count(*) filter(where status='settled')::int as paid,
    count(*) filter(where status='expired')::int as expired,
    count(*) filter(where status='invalid')::int as failed,
    count(*) filter(where status in ('new','pending'))::int as in_progress,
    coalesce(sum(coalesce(amount_settled,0)) filter(where status='settled'),0) as gross,
    coalesce(sum(coalesce(platform_fee_amount,0)) filter(where status='settled'),0) as fees
    from a
  )
  select jsonb_build_object(
    'month',v_month,'attempts',t.attempts,'paid',t.paid,'expired',t.expired,'failed',t.failed,'in_progress',t.in_progress,
    'success_rate',case when (t.paid+t.expired+t.failed)=0 then null else round(100.0*t.paid/(t.paid+t.expired+t.failed),2) end,
    'gross',t.gross,'fees',t.fees,'net',t.gross-t.fees,
    'recent',(select coalesce(jsonb_agg(jsonb_build_object('status',z.status,'link',z.link_name,'amount',z.amount_requested,'when',z.created_at,'country',z.customer_country) order by z.created_at desc),'[]'::jsonb)
      from (select * from a order by created_at desc limit 15) z),
    'top_links',(select coalesce(jsonb_agg(to_jsonb(z) order by z.gross desc),'[]'::jsonb)
      from (select link_name as name,count(*)::int as attempts,
             count(*) filter(where status='settled')::int as paid,
             coalesce(sum(coalesce(amount_settled,0)) filter(where status='settled'),0) as gross
            from a group by link_name order by gross desc limit 8) z)
  ) into v_data from totals t;
  return v_data;
end $$;
revoke all on function public.my_monthly_report(date) from public, anon;
grant execute on function public.my_monthly_report(date) to authenticated;

create or replace function public.admin_parity_overview()
returns jsonb language plpgsql security definer stable set search_path=public as $$
declare v_month timestamptz; v_today timestamptz; v_result jsonb;
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  v_today:=((now() at time zone 'Asia/Dhaka')::date)::timestamp at time zone 'Asia/Dhaka';
  v_month:=date_trunc('month',now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka';
  select jsonb_build_object(
    'today_fees',coalesce((select sum(platform_fee_amount) from payments where status='settled' and settled_at>=v_today),0),
    'month_fees',coalesce((select sum(platform_fee_amount) from payments where status='settled' and settled_at>=v_month),0),
    'active_links',(select count(*) from payment_links l join profiles p on p.id=l.user_id where l.is_active and l.deleted_at is null and p.account_status='active'),
    'attempts_30d',(select count(*) from payments where created_at>=now()-interval '30 days'),
    'settled_30d',(select count(*) from payments where created_at>=now()-interval '30 days' and status='settled'),
    'terminal_30d',(select count(*) from payments where created_at>=now()-interval '30 days' and status in ('settled','expired','invalid')),
    'success_rate_30d',(select round(100.0*count(*) filter(where status='settled')/nullif(count(*) filter(where status in ('settled','expired','invalid')),0),2)
                           from payments where created_at>=now()-interval '30 days')
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.admin_parity_overview() from public, anon;
grant execute on function public.admin_parity_overview() to authenticated;
