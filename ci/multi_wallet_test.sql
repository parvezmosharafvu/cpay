-- 20261021040000_multi_wallet.sql: registry, Vault storage, owner-only RPCs,
-- removal rules and wallet attribution. BEGIN/ROLLBACK.
-- The mnemonic below is the public BIP39 test vector, not a real wallet.
\set ON_ERROR_STOP on
begin;
do $$
declare
  m constant text := 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  owner uuid := gen_random_uuid(); r jsonb; w2 uuid; sid uuid; ok boolean; i int; err text;
begin
  -- legacy wallet #1 is the primary
  if breez_wallet.primary_wallet_id() <> '00000000-0000-0000-0000-000000000001' then raise exception 'legacy is not primary'; end if;
  if breez_wallet.wallet_lock_key(breez_wallet.legacy_wallet_id()) <> breez_wallet.lock_key() then raise exception 'legacy lock key changed'; end if;

  -- no plain seed column anywhere in the registry
  if exists (select 1 from information_schema.columns where table_schema = 'breez_wallet' and table_name = 'wallets'
             and column_name ~ '(mnemonic|seed$|phrase)') then raise exception 'plain seed column'; end if;

  r := public.wallet_registry_add(owner, 'Second', 'mainnet', m, '73c5da0a');
  w2 := (r->>'id')::uuid;
  if r::text like '%abandon%' then raise exception 'add echoed the seed'; end if;
  select seed_secret_id into sid from breez_wallet.wallets where id = w2;
  if sid is null then raise exception 'no vault id'; end if;
  if (select decrypted_secret from vault.decrypted_secrets where id = sid) <> m then raise exception 'vault does not hold the seed'; end if;
  if breez_wallet.wallet_seed(w2) <> m then raise exception 'wallet_seed wrong'; end if;
  if exists (select 1 from breez_wallet.wallet_audit where detail::text like '%abandon%') then raise exception 'seed in audit'; end if;
  if not exists (select 1 from pg_namespace where nspname = breez_wallet.wallet_schema(w2)) then raise exception 'no sdk schema'; end if;

  -- duplicate fingerprint refused, with a fixed message
  begin perform public.wallet_registry_add(owner, 'Again', 'mainnet', m, '73c5da0a'); raise exception 'dup accepted';
  exception when others then err := sqlerrm; end;
  if err <> 'duplicate_wallet' then raise exception 'dup: %', err; end if;
  -- bad shape refused without echoing input
  begin perform public.wallet_registry_add(owner, 'Bad', 'mainnet', 'not a seed', '11111111'); raise exception 'bad accepted';
  exception when others then err := sqlerrm; end;
  if err <> 'bad_mnemonic' then raise exception 'bad: %', err; end if;

  -- rate limit: 5 per hour
  for i in 1..5 loop ok := public.wallet_registry_add_attempt(owner); if not ok then raise exception 'limited too early'; end if; end loop;
  if public.wallet_registry_add_attempt(owner) then raise exception 'rate limit missing'; end if;

  -- list shows no secret id and no seed
  r := public.wallet_registry_list();
  if jsonb_array_length(r->'wallets') <> 2 then raise exception 'list count'; end if;
  if r::text like '%abandon%' or r::text like '%' || sid::text || '%' then raise exception 'list leaks'; end if;

  -- attribution: the acting wallet comes from cpay.wallet_id, else primary
  perform set_config('cpay.wallet_id', w2::text, true);
  if breez_wallet.acting_wallet_id() <> w2 then raise exception 'acting wallet'; end if;
  perform set_config('cpay.wallet_id', '', true);
  if breez_wallet.acting_wallet_id() <> breez_wallet.legacy_wallet_id() then raise exception 'acting fallback'; end if;

  -- primary switch
  perform public.wallet_registry_set_primary(owner, w2);
  if breez_wallet.primary_wallet_id() <> w2 then raise exception 'set primary'; end if;
  begin perform public.wallet_registry_set_status(owner, w2, 'disabled'); raise exception 'disabled primary';
  exception when others then err := sqlerrm; end;
  if err <> 'primary_must_stay_active' then raise exception 'disable primary: %', err; end if;
  begin perform public.wallet_registry_remove(owner, w2, 'Second'); raise exception 'removed primary';
  exception when others then err := sqlerrm; end;
  if err <> 'primary_not_removable' then raise exception 'remove primary: %', err; end if;
  perform public.wallet_registry_set_primary(owner, breez_wallet.legacy_wallet_id());

  -- removal rules
  begin perform public.wallet_registry_remove(owner, w2, 'second'); exception when others then err := sqlerrm; end;
  if err <> 'confirmation_mismatch' then raise exception 'confirm: %', err; end if;
  begin perform public.wallet_registry_remove(owner, w2, 'Second'); exception when others then err := sqlerrm; end;
  if err <> 'balance_unknown' then raise exception 'unknown balance: %', err; end if;
  perform breez_wallet.wallet_record_status(w2, null, 500, null);
  begin perform public.wallet_registry_remove(owner, w2, 'Second'); exception when others then err := sqlerrm; end;
  if err <> 'balance_not_zero' then raise exception 'balance: %', err; end if;
  perform breez_wallet.wallet_record_status(w2, null, 0, null);
  begin perform public.wallet_registry_remove(owner, breez_wallet.legacy_wallet_id(), 'Wallet 1'); exception when others then err := sqlerrm; end;
  if err <> 'legacy_wallet_not_removable' then raise exception 'legacy: %', err; end if;
  perform public.wallet_registry_remove(owner, w2, 'Second');
  if exists (select 1 from vault.decrypted_secrets where id = sid) then raise exception 'vault secret kept'; end if;
  if (select status from breez_wallet.wallets where id = w2) <> 'removed' then raise exception 'not removed'; end if;
  begin perform breez_wallet.wallet_seed(w2); raise exception 'seed after removal';
  exception when others then err := sqlerrm; end;
  if err <> 'wallet seed unavailable' then raise exception 'seed after removal: %', err; end if;

  -- duplicate node key auto-disables the newer wallet
  r := public.wallet_registry_add(owner, 'Third', 'mainnet', m, '73c5da0a');
  perform breez_wallet.wallet_record_status(breez_wallet.legacy_wallet_id(), repeat('a', 66), 1, null);
  if breez_wallet.wallet_record_status((r->>'id')::uuid, repeat('a', 66), 1, null) then raise exception 'dup pubkey accepted'; end if;
  if (select status from breez_wallet.wallets where id = (r->>'id')::uuid) <> 'disabled' then raise exception 'dup not disabled'; end if;
end $$;

-- trigger: an attached invoice records the acting wallet
do $$
declare v_user uuid := gen_random_uuid(); v_link uuid := gen_random_uuid(); v_pay uuid := gen_random_uuid(); v_w uuid;
begin
  select id into v_w from breez_wallet.wallets where label = 'Third';
  insert into auth.users(id, email) values (v_user, 'mw-' || v_user || '@example.test');
  update profiles set account_status = 'active', display_name = 'MW Test' where id = v_user;
  insert into payment_links(id, user_id, slug, is_active) values (v_link, v_user, 'mw-' || left(v_user::text, 8), true);
  insert into payments(id, payment_link_id, user_id, amount_requested, status, expires_at)
  values (v_pay, v_link, v_user, 5, 'new', now() + interval '30 minutes');
  if (select wallet_id from payments where id = v_pay) is not null then raise exception 'tagged before invoice'; end if;
  perform set_config('cpay.wallet_id', v_w::text, true);
  update payments set lightning_invoice = 'lnbcmwtest', invoice_ref = repeat('b', 64) where id = v_pay;
  if (select wallet_id from payments where id = v_pay) is distinct from v_w then raise exception 'invoice not tagged'; end if;
  perform set_config('cpay.wallet_id', '', true);
end $$;

-- privileges: anon/authenticated reach nothing; service_role only the RPCs
do $$
declare f text; role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if has_schema_privilege(role_name, 'breez_wallet', 'usage') then raise exception '% has usage on breez_wallet', role_name; end if;
    foreach f in array array['public.wallet_registry_list()', 'public.wallet_registry_add_attempt(uuid)',
      'public.wallet_registry_add(uuid,text,text,text,text)', 'public.wallet_registry_rename(uuid,uuid,text)',
      'public.wallet_registry_set_primary(uuid,uuid)', 'public.wallet_registry_set_status(uuid,uuid,text)',
      'public.wallet_registry_remove(uuid,uuid,text)', 'public.wallet_registry_audit(integer)',
      'breez_wallet.wallet_seed(uuid)'] loop
      if has_function_privilege(role_name, f, 'execute') then raise exception '% can execute %', role_name, f; end if;
    end loop;
    if has_table_privilege(role_name, 'breez_wallet.wallets', 'select') then raise exception '% reads wallets', role_name; end if;
  end loop;
  if has_function_privilege('service_role', 'breez_wallet.wallet_seed(uuid)', 'execute') then raise exception 'service_role can read seeds via SQL'; end if;
  if not has_function_privilege('service_role', 'public.wallet_registry_add(uuid,text,text,text,text)', 'execute') then raise exception 'service_role cannot add'; end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'breez_wallet' and c.relname in ('wallets', 'wallet_status', 'wallet_audit') and c.relrowsecurity) <> 3
  then raise exception 'RLS off'; end if;
end $$;

set local role authenticated;
do $$ begin
  begin perform public.wallet_registry_list(); raise exception 'authenticated listed wallets';
  exception when insufficient_privilege then null; end;
  begin perform 1 from breez_wallet.wallets; raise exception 'authenticated read wallets';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.wallet_registry_add(gen_random_uuid(), 'x', 'mainnet', 'a', '00000000'); raise exception 'anon added';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
\echo 'multi_wallet_test: ok'
rollback;
