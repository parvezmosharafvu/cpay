-- 20261027010000 + 20261027020000 + 20261027030000: Blink sweep and overflow. Off by default with safe limits; the
-- destination comes only from the primary active CPAY wallet's own Lightning
-- address; at most one sweep in flight; only service_role runs the system
-- functions; admins read the log, nobody else. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
insert into auth.users(id, email) values
  ('e7000000-0000-0000-0000-0000000000a1', 'bs-admin@test.invalid'),
  ('e7000000-0000-0000-0000-0000000000f1', 'bs-free@test.invalid');
update profiles set account_status = 'active' where id::text like 'e7000000-%';
update profiles set role = 'admin' where id = 'e7000000-0000-0000-0000-0000000000a1';

-- 1. Defaults: off, keep 0, min 5, max 200; no destination without a wallet.
do $$ declare c jsonb := system_blink_sweep_config(); begin
  if c->>'enabled' <> 'false' then raise exception 'sweep on by default: %', c; end if;
  if (c->>'keep_usd')::numeric <> 0 or (c->>'min_usd')::numeric <> 5 or (c->>'max_usd')::numeric <> 200 then
    raise exception 'unexpected limits: %', c;
  end if;
  if c->>'destination' is not null then raise exception 'destination without a wallet: %', c; end if;
  if (select dangerous from platform_setting_defaults() where key = 'blink_sweep_enabled') is not true then
    raise exception 'blink_sweep_enabled must be a dangerous (confirmed) setting';
  end if;
  if c->>'overflow' <> 'false' then raise exception 'overflow on by default: %', c; end if;
  if (select dangerous from platform_setting_defaults() where key = 'blink_sweep_overflow_enabled') is not true then
    raise exception 'blink_sweep_overflow_enabled must be a dangerous (confirmed) setting';
  end if;
  insert into platform_settings (key, value) values ('blink_sweep_overflow_enabled', 'true');
  if system_blink_sweep_config()->>'overflow' <> 'true' then raise exception 'overflow setting not read'; end if;
  delete from platform_settings where key = 'blink_sweep_overflow_enabled';
end $$;

-- 2. Destination: the primary active wallet's Lightning address only.
-- brz_settings is made by the Breez SDK at runtime, not by a migration.
create table if not exists breez_wallet.brz_settings (key text, value text, user_id bytea);
delete from breez_wallet.brz_settings;
-- Wallet #1 (legacy, primary) exists after the migrations; add a second one.
update breez_wallet.wallets set node_pubkey = repeat('aa', 33) where id = '00000000-0000-0000-0000-000000000001';
insert into breez_wallet.wallets (id, label, network, status, is_primary, is_legacy, seed_secret_id, node_pubkey)
values ('00000000-0000-0000-0000-0000000000b2', 'other', 'mainnet', 'active', false, false, gen_random_uuid(), repeat('bb', 33));
insert into breez_wallet.brz_settings (key, value, user_id) values
  ('lightning_address', '{"address":{"lightning_address":"primary@breez.tips"}}', decode(repeat('aa', 33), 'hex')),
  ('lightning_address', '{"address":{"lightning_address":"other@breez.tips"}}', decode(repeat('bb', 33), 'hex')),
  ('breez_jwt', 'secret', decode(repeat('aa', 33), 'hex'));
do $$ begin
  if system_blink_sweep_config()->>'destination' <> 'primary@breez.tips' then raise exception 'wrong destination'; end if;
end $$;
update breez_wallet.wallets set is_primary = false where id = '00000000-0000-0000-0000-000000000001';
update breez_wallet.wallets set is_primary = true where id = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  if system_blink_sweep_config()->>'destination' <> 'other@breez.tips' then raise exception 'destination did not follow primary'; end if;
end $$;
delete from breez_wallet.brz_settings where user_id = decode(repeat('bb', 33), 'hex');
do $$ begin
  if system_blink_sweep_config()->>'destination' is not null then raise exception 'primary without an address still a destination'; end if;
end $$;
update breez_wallet.brz_settings set value = 'not json' where key = 'lightning_address';
update breez_wallet.wallets set is_primary = false where id = '00000000-0000-0000-0000-0000000000b2';
update breez_wallet.wallets set is_primary = true where id = '00000000-0000-0000-0000-000000000001';
do $$ begin
  if system_blink_sweep_config()->>'destination' is not null then raise exception 'unreadable address used'; end if;
end $$;

-- 3. One sweep in flight; finish closes it; a payment hash is used once.
do $$ declare a uuid; b uuid; begin
  a := system_blink_sweep_begin(1000, 10000, 'x@breez.tips', 'w', 'lnbc1a', 'h1', now() + interval '10 minutes');
  if a is null then raise exception 'first begin refused'; end if;
  b := system_blink_sweep_begin(1000, 10000, 'x@breez.tips', 'w', 'lnbc1b', 'h2', now() + interval '10 minutes');
  if b is not null then raise exception 'second sweep started while one is open'; end if;
  -- 20261027020000: one in flight per Blink account, not in total.
  b := system_blink_sweep_begin(700, 7000, 'x@breez.tips', 'w2', 'lnbc1c', 'h3', now() + interval '10 minutes', '2');
  if b is null then raise exception 'account 2 blocked by account 1'; end if;
  if jsonb_array_length(system_blink_sweep_open_all()) <> 2 then raise exception 'open_all: %', system_blink_sweep_open_all(); end if;
  if system_blink_sweep_begin(700, 7000, 'x@breez.tips', 'w2', 'lnbc1d', 'h4', now(), '2') is not null then
    raise exception 'second sweep on account 2';
  end if;
  perform system_blink_sweep_finish(b, 'failed', 'no route');
  begin
    perform system_blink_sweep_begin(1, 1, 'x', 'w', 'b', 'h5', now(), 'abc');
    raise exception 'bad account label accepted';
  exception when check_violation then null;
  end;
  perform system_blink_sweep_note_account('1', 12345, false, null, 'no_write');
  perform system_blink_sweep_note_account('1', 2345, true, 99900, 'sent');
  if (select count(*) from blink_sweep_accounts) <> 1 or (select balance_cents from blink_sweep_accounts where account = '1') <> 2345 then
    raise exception 'note_account did not upsert';
  end if;
  if (system_blink_sweep_open()->>'id')::uuid <> a then raise exception 'open sweep not returned'; end if;
  perform system_blink_sweep_finish(a, 'pending', null);
  if system_blink_sweep_open()->>'status' <> 'pending' then raise exception 'pending not kept open'; end if;
  perform system_blink_sweep_finish(a, 'sent', null);
  if system_blink_sweep_open() is not null then raise exception 'sent sweep still open'; end if;
  perform system_blink_sweep_finish(a, 'failed', 'late');
  if (select status from blink_sweeps where id = a) <> 'sent' then raise exception 'a finished sweep changed'; end if;
  if system_blink_sweep_begin(1000, 10000, 'x@breez.tips', 'w', 'lnbc1a', 'h1', now()) is not null then
    raise exception 'same payment hash recorded twice';
  end if;
  begin
    perform system_blink_sweep_finish(a, 'sending', null);
    raise exception 'finish accepted sending';
  exception when raise_exception then if sqlerrm not like 'bad status%' then raise; end if;
  end;
end $$;

-- 3b. Overflow: recorded, one per source account per 5 minutes, finished once.
do $$ declare a uuid; b uuid; begin
  a := system_blink_overflow_begin('1', '2', 5000);
  if a is null then raise exception 'first overflow refused'; end if;
  if system_blink_overflow_begin('1', '3', 100) is not null then raise exception 'second overflow from #1 within 5 minutes'; end if;
  b := system_blink_overflow_begin('2', '1', 100);
  if b is null then raise exception 'overflow from #2 blocked by #1'; end if;
  perform system_blink_overflow_finish(a, 'sent', null);
  perform system_blink_overflow_finish(a, 'failed', 'late');
  if (select status from blink_overflows where id = a) <> 'sent' then raise exception 'a finished overflow changed'; end if;
  begin
    perform system_blink_overflow_finish(b, 'sending', null);
    raise exception 'overflow finish accepted sending';
  exception when raise_exception then if sqlerrm not like 'bad status%' then raise; end if;
  end;
  begin
    perform system_blink_overflow_begin('3', '3', 100);
    raise exception 'overflow to itself accepted';
  exception when check_violation then null;
  end;
  update blink_overflows set created_at = now() - interval '6 minutes' where id = a;
  if system_blink_overflow_begin('1', '2', 100) is null then raise exception 'overflow from #1 still blocked after 5 minutes'; end if;
end $$;

-- 4. Grants: anon and authenticated cannot run the system functions or read the table.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7000000-0000-0000-0000-0000000000f1', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
do $$ begin
  perform system_blink_sweep_config();
  raise exception 'authenticated ran system_blink_sweep_config';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform system_blink_sweep_begin(1, 1, 'x', 'w', 'b', 'h9', now());
  raise exception 'authenticated ran system_blink_sweep_begin';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform system_blink_sweep_note_account('1', 1, true, null, 'x');
  raise exception 'authenticated ran system_blink_sweep_note_account';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform system_blink_overflow_begin('1', '2', 1);
  raise exception 'authenticated ran system_blink_overflow_begin';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from blink_overflows;
  raise exception 'authenticated read blink_overflows';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from blink_sweep_accounts;
  raise exception 'authenticated read blink_sweep_accounts';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from blink_sweeps;
  raise exception 'authenticated read blink_sweeps';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform admin_blink_sweeps(10);
  raise exception 'freelancer read the sweep log';
exception when raise_exception then if sqlerrm <> 'Not authorized' then raise; end if; end $$;
reset role;
set local role anon;
do $$ begin
  perform admin_blink_sweeps(10);
  raise exception 'anon ran admin_blink_sweeps';
exception when insufficient_privilege then null; end $$;
reset role;

-- 5. Admin reads the log and the current destination, never invoices.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7000000-0000-0000-0000-0000000000a1', true);
do $$ declare r jsonb := admin_blink_sweeps(10); begin
  if jsonb_array_length(r->'rows') <> 2 then raise exception 'log rows: %', r; end if;
  if jsonb_array_length(r->'accounts') <> 1 or (r->'accounts'->0->>'sent_24h_cents')::int <> 1000 then raise exception 'accounts: %', r->'accounts'; end if;
  if r->'rows'->0 ? 'bolt11' or r->'rows'->0 ? 'blink_wallet_id' then raise exception 'log leaks invoice or wallet id'; end if;
  if r ? 'destination' is not true then raise exception 'no destination field'; end if;
  if jsonb_array_length(r->'overflows') <> 3 or r->'overflows'->0->>'from_account' is null then raise exception 'overflows: %', r->'overflows'; end if;
end $$;
reset role;

rollback;
\echo 'blink sweep: OK'
