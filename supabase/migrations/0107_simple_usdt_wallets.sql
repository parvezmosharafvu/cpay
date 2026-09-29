-- USDT address book + payout prefs. Safe to re-apply.

create table if not exists public.usdt_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  network text not null,
  address text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, network)
);

alter table public.usdt_wallets enable row level security;

drop policy if exists usdt_wallets_own on public.usdt_wallets;
create policy usdt_wallets_own on public.usdt_wallets
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.profiles
  add column if not exists withdraw_threshold numeric,
  add column if not exists preferred_usdt_network text;

create or replace function public.set_my_usdt_wallet(p_network text, p_address text)
returns public.usdt_wallets
language plpgsql security definer set search_path = public as $$
declare v_row public.usdt_wallets; v_net text; v_addr text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  v_net := lower(nullif(trim(p_network), ''));
  v_addr := nullif(trim(p_address), '');
  if v_net is null then raise exception 'Network required'; end if;
  if v_addr is null then raise exception 'Address required'; end if;
  insert into public.usdt_wallets (user_id, network, address)
  values (auth.uid(), v_net, v_addr)
  on conflict (user_id, network) do update
    set address = excluded.address, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.delete_my_usdt_wallet(p_network text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from public.usdt_wallets
   where user_id = auth.uid() and network = lower(trim(p_network));
end;
$$;

create or replace function public.set_my_payout_prefs(p_threshold numeric, p_network text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_threshold is not null and p_threshold < 5 then
    raise exception 'Threshold must be at least $5';
  end if;
  update public.profiles
     set withdraw_threshold = p_threshold,
         preferred_usdt_network = nullif(lower(trim(p_network)), ''),
         updated_at = now()
   where id = auth.uid();
end;
$$;

create or replace function public.my_payout_book()
returns table(network text, address text, preferred boolean, threshold numeric)
language sql security definer set search_path = public as $$
  select w.network, w.address,
         (w.network = p.preferred_usdt_network) as preferred,
         p.withdraw_threshold
    from public.profiles p
    left join public.usdt_wallets w on w.user_id = p.id
   where p.id = auth.uid();
$$;

grant execute on function public.set_my_usdt_wallet(text, text) to authenticated;
grant execute on function public.delete_my_usdt_wallet(text) to authenticated;
grant execute on function public.set_my_payout_prefs(numeric, text) to authenticated;
grant execute on function public.my_payout_book() to authenticated;
