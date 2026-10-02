-- Already applied on the linked project. Admin can list and set a user's USDT wallet.
create or replace function public.admin_list_user_wallets()
returns table(user_id uuid, network text, address text, updated_at timestamptz)
language plpgsql stable security definer set search_path to public
as $$
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  return query
  select w.user_id, w.network, w.address, w.updated_at
  from public.usdt_wallets w
  order by w.updated_at desc;
end;
$$;

create or replace function public.admin_set_user_usdt_wallet(p_user_id uuid, p_network text, p_address text)
returns void
language plpgsql security definer set search_path to public
as $$
declare a text := trim(p_address);
begin
  if not is_admin() then raise exception 'Not authorized'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'Unknown account';
  end if;
  if p_network is null or p_network not in ('tron','bsc','ethereum','polygon','arbitrum','base','optimism','avalanche','solana') then
    raise exception 'Unknown USDT network';
  end if;
  if not public.usdt_address_ok(p_network, a) then
    raise exception 'That address is not valid for %', p_network;
  end if;
  insert into public.usdt_wallets (user_id, network, address)
  values (p_user_id, p_network, a)
  on conflict (user_id, network) do update
    set address = excluded.address, updated_at = now();
end;
$$;

revoke all on function public.admin_list_user_wallets() from public;
revoke all on function public.admin_set_user_usdt_wallet(uuid, text, text) from public;
grant execute on function public.admin_list_user_wallets() to authenticated;
grant execute on function public.admin_set_user_usdt_wallet(uuid, text, text) to authenticated;
