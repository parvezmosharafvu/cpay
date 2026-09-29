-- USDT address book + payout prefs. Matches the live functions.

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

create or replace function public.usdt_address_ok(p_network text, p_address text)
returns boolean language plpgsql immutable as $$
declare a text := trim(p_address);
begin
  if p_network = 'tron' then
    return a ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$';
  elsif p_network = 'solana' then
    return a ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  else
    return a ~ '^0x[0-9a-fA-F]{40}$';
  end if;
end;
$$;

create or replace function public.set_my_usdt_wallet(p_network text, p_address text)
returns usdt_wallets language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_row public.usdt_wallets; a text := trim(p_address);
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_network is null or p_network not in ('tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana') then
    raise exception 'Unknown USDT network';
  end if;
  if not public.usdt_address_ok(p_network, a) then
    raise exception 'That address is not valid for %', p_network;
  end if;
  insert into public.usdt_wallets (user_id, network, address)
  values (v_uid, p_network, a)
  on conflict (user_id, network) do update
    set address = excluded.address, updated_at = now()
  returning * into v_row;
  if (select preferred_usdt_network from profiles where id = v_uid) is null then
    update profiles set preferred_usdt_network = p_network where id = v_uid;
  end if;
  return v_row;
end;
$$;

create or replace function public.delete_my_usdt_wallet(p_network text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from public.usdt_wallets where user_id = auth.uid() and network = p_network;
end;
$$;

create or replace function public.set_my_payout_prefs(p_threshold numeric, p_network text, p_auto_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  if p_threshold is not null and p_threshold < 5 then
    raise exception 'Threshold must be empty or at least $5';
  end if;
  if p_network is not null and p_network not in ('tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana') then
    raise exception 'Unknown USDT network';
  end if;
  if p_network is not null and not exists (
    select 1 from usdt_wallets where user_id = v_uid and network = p_network
  ) then
    raise exception 'Save a USDT address for that network first';
  end if;
  update profiles set
    withdraw_threshold = p_threshold,
    preferred_usdt_network = p_network,
    auto_withdraw_enabled = coalesce(p_auto_enabled, false)
  where id = v_uid;
  return jsonb_build_object(
    'withdraw_threshold', p_threshold,
    'preferred_usdt_network', p_network,
    'auto_withdraw_enabled', coalesce(p_auto_enabled, false)
  );
end;
$$;

create or replace function public.my_payout_book()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_p profiles;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select * into v_p from profiles where id = v_uid;
  return jsonb_build_object(
    'withdraw_threshold', v_p.withdraw_threshold,
    'preferred_usdt_network', v_p.preferred_usdt_network,
    'auto_withdraw_enabled', coalesce(v_p.auto_withdraw_enabled, false),
    'wallets', coalesce((
      select jsonb_agg(jsonb_build_object('network', network, 'address', address) order by network)
      from usdt_wallets where user_id = v_uid
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.usdt_address_ok(text, text) to authenticated;
grant execute on function public.set_my_usdt_wallet(text, text) to authenticated;
grant execute on function public.delete_my_usdt_wallet(text) to authenticated;
grant execute on function public.set_my_payout_prefs(numeric, text, boolean) to authenticated;
grant execute on function public.my_payout_book() to authenticated;
