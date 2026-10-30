-- CPAY rebuild v2: isolated LND-only payment model; no old provider dependencies.
-- This migration is additive so production financial records are not destroyed
-- during the staged cutover. New checkout remains OFF until verified.
create table if not exists public.v2_settings(
  id boolean primary key default true check(id=true),
  checkout_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
insert into public.v2_settings(id,checkout_enabled) values(true,false)
on conflict(id) do nothing;
revoke all on public.v2_settings from public,anon,authenticated;
grant select,update on public.v2_settings to service_role;
alter table public.v2_settings enable row level security;

create table if not exists public.v2_links(
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  slug text not null unique check(slug ~ '^[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$'),
  display_name text not null check(length(btrim(display_name)) between 2 and 80),
  note text not null default '' check(length(note)<=240),
  min_usd numeric(12,2) not null default 10.00 check(min_usd>=10 and min_usd<=1000),
  max_usd numeric(12,2) not null default 1000.00 check(max_usd>=min_usd and max_usd<=1000),
  quick_amounts numeric(12,2)[] not null default array[10,25,50,100,250,500]::numeric[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(cardinality(quick_amounts) between 1 and 8),
  check(array_position(quick_amounts,null) is null),
  check(public.paylink_quick_amounts_valid(quick_amounts,min_usd,max_usd))
);
create index if not exists v2_links_owner_idx on public.v2_links(owner_id,created_at desc);
alter table public.v2_links enable row level security;
revoke all on public.v2_links from public,anon,authenticated;
grant select,insert,update on public.v2_links to service_role;
grant select on public.v2_links to authenticated;
drop policy if exists v2_link_owner_read on public.v2_links;
create policy v2_link_owner_read on public.v2_links for select to authenticated
using (owner_id=(select auth.uid()) and exists(
  select 1 from public.profiles p where p.id=owner_id and p.account_status='active'));

create table if not exists public.v2_invoices(
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.v2_links(id),
  owner_id uuid not null references auth.users(id),
  request_id uuid not null,
  status text not null default 'creating'
    check(status in ('creating','pending','settled','expired','failed')),
  amount_usd numeric(12,2) not null check(amount_usd between 10 and 1000),
  amount_sats bigint not null check(amount_sats>0),
  btc_usd_rate numeric(16,2) not null check(btc_usd_rate>0),
  commission_pct numeric(5,2) not null default 0 check(commission_pct between 0 and 100),
  commission_usd numeric(12,2) not null default 0 check(commission_usd>=0),
  net_usd numeric(12,2) not null check(net_usd>=0),
  payment_hash text unique check(payment_hash is null or payment_hash ~ '^[a-f0-9]{64}$'),
  bolt11 text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz,
  confirmed_sats bigint,
  checked_at timestamptz,
  constraint v2_invoice_request_unique unique(link_id,request_id),
  constraint v2_invoice_amount_exact check(amount_usd=commission_usd+net_usd),
  constraint v2_invoice_has_request check (
    status in ('creating','failed') or (payment_hash is not null and bolt11 is not null)
  ),
  constraint v2_invoice_settled_proof check (
    status<>'settled' or (settled_at is not null and confirmed_sats>=amount_sats)
  )
);
create index if not exists v2_invoices_open_idx on public.v2_invoices(status,created_at) where status='pending';
create index if not exists v2_invoices_owner_idx on public.v2_invoices(owner_id,created_at desc);
alter table public.v2_invoices enable row level security;
revoke all on public.v2_invoices from public,anon,authenticated;
grant select,insert,update on public.v2_invoices to service_role;
grant select on public.v2_invoices to authenticated;
drop policy if exists v2_invoice_owner_read on public.v2_invoices;
create policy v2_invoice_owner_read on public.v2_invoices for select to authenticated
using(owner_id=(select auth.uid()) and exists(
  select 1 from public.profiles p where p.id=owner_id and p.account_status='active'));

create table if not exists public.v2_payment_events(
  id bigint generated always as identity primary key,
  invoice_id uuid not null references public.v2_invoices(id),
  old_status text,
  new_status text not null,
  payment_hash text,
  observed_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists v2_payment_events_invoice on public.v2_payment_events(invoice_id,observed_at);
alter table public.v2_payment_events enable row level security;
revoke all on public.v2_payment_events from public,anon,authenticated;
grant select,insert on public.v2_payment_events to service_role;

-- Default zero platform fee until a separately reviewed commission policy
-- is configured; not allowed to infer a percentage from legacy payments.
create or replace function public.v2_create_link(
 p_slug text,p_display_name text,p_note text default '',
 p_min numeric default 10,p_max numeric default 1000,
 p_quick numeric[] default array[10,25,50,100,250,500]::numeric[]
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
 if auth.uid() is null or not exists(
   select 1 from public.profiles p where p.id=auth.uid() and p.account_status='active'
 ) then raise exception 'Active account required'; end if;
 if p_slug is null or p_slug ~ '^(admin|login|register|dashboard|api|pay|terms|privacy)$'
   then raise exception 'Reserved slug'; end if;
 insert into public.v2_links(owner_id,slug,display_name,note,min_usd,max_usd,quick_amounts)
 values(auth.uid(),p_slug,p_display_name,coalesce(p_note,''),p_min,p_max,p_quick) returning id into v_id;
 return v_id;
end $$;
revoke all on function public.v2_create_link(text,text,text,numeric,numeric,numeric[]) from public,anon;
grant execute on function public.v2_create_link(text,text,text,numeric,numeric,numeric[]) to authenticated;

create or replace function public.v2_public_link(p_slug text)
returns table(slug text,display_name text,note text,min_usd numeric,max_usd numeric,quick_amounts numeric[])
language sql security definer stable set search_path=public as $$
 select l.slug,l.display_name,l.note,l.min_usd,l.max_usd,l.quick_amounts
 from public.v2_links l join public.profiles p on p.id=l.owner_id
 where l.slug=p_slug and l.active and p.account_status='active' limit 1
$$;
revoke all on function public.v2_public_link(text) from public;
grant execute on function public.v2_public_link(text) to anon,authenticated;

-- Call ONLY after the node returned a confirmed settlement. The status gate
-- prevents double credit, including races with the watcher/on-demand lookup.
create or replace function public.v2_reconcile_invoice(
 p_hash text,p_node_state text,p_paid_sats bigint default null
) returns text language plpgsql security definer set search_path=public as $$
declare v public.v2_invoices%rowtype; v_new text;
begin
 if current_user<>'service_role' and session_user<>'service_role' then
   raise exception 'Service role required'; end if;
 if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_node_state not in ('settled','cancelled','open')
 then raise exception 'Invalid reconciliation'; end if;
 select * into v from public.v2_invoices where payment_hash=p_hash for update;
 if not found then raise exception 'Unknown invoice'; end if;
 if v.status in ('settled','expired','failed') then return v.status; end if;
 if v.status<>'pending' then return v.status; end if;
 if p_node_state='settled' then
   if p_paid_sats is null or p_paid_sats<v.amount_sats then
     raise exception 'Unproven invoice amount'; end if;
   v_new:='settled';
   update public.v2_invoices set status=v_new,settled_at=now(),confirmed_sats=p_paid_sats,checked_at=now() where id=v.id;
 elsif p_node_state='cancelled' or
       (p_node_state='open' and now()>v.expires_at+interval '2 minutes') then
   v_new:='expired';
   update public.v2_invoices set status=v_new,checked_at=now() where id=v.id;
 else
   update public.v2_invoices set checked_at=now() where id=v.id;
   return 'pending';
 end if;
 insert into public.v2_payment_events(invoice_id,old_status,new_status,payment_hash)
 values(v.id,v.status,v_new,p_hash);
 return v_new;
end $$;
revoke all on function public.v2_reconcile_invoice(text,text,bigint) from public,anon,authenticated;
grant execute on function public.v2_reconcile_invoice(text,text,bigint) to service_role;
