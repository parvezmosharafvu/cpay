-- 20261020050000: instant forward to USDT. Receive choice needs a saved
-- address and a fresh sign-in; USDT rows accumulate, then one batch per user
-- and network sends them; one open batch at a time; finish is idempotent;
-- retry then owed; Lightning worker never takes USDT rows. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
insert into auth.users(id, email) values ('e9000000-0000-0000-0000-0000000000b1', 'usdt-fwd@test.invalid');
update profiles set account_status = 'active', platform_fee_percent = 2 where id = 'e9000000-0000-0000-0000-0000000000b1';
insert into payment_links(id, user_id, slug) values ('e9000000-0000-0000-0000-0000000001b1', 'e9000000-0000-0000-0000-0000000000b1', 'usdt-fwd-link');
insert into usdt_wallets(user_id, network, address) values ('e9000000-0000-0000-0000-0000000000b1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"');
create function pg_temp.pay(p_id text, p_usd numeric, p_sat bigint) returns void language plpgsql as $$
begin
  insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values (p_id::uuid, 'e9000000-0000-0000-0000-0000000000b1', 'e9000000-0000-0000-0000-0000000001b1', p_usd, 'lightning', 'new', now() + interval '15 min', 'uf-' || p_id);
  update payments set status = 'settled', amount_settled = p_usd, amount_sat = p_sat, settled_at = now() where id = p_id::uuid;
end $$;

-- 1. Choosing USDT: needs a saved address for the network and a fresh sign-in.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e9000000-0000-0000-0000-0000000000b1', true);
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'amr',
  jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint - 3600)))::text, true);
do $$ begin
  perform set_my_receive_method('usdt', 'bsc'); raise exception 'chose a network without an address';
exception when raise_exception then if sqlerrm not like 'Save a USDT address%' then raise; end if; end $$;
do $$ begin
  perform set_my_receive_method('usdt', 'tron'); raise exception 'stale session changed the receive choice';
exception when raise_exception then if sqlerrm not like 'reauth_required:%' then raise; end if; end $$;
select set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'amr',
  jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint - 10)))::text, true);
do $$ declare s jsonb := set_my_receive_method('usdt', 'tron'); begin
  if s->>'method' <> 'usdt' or s->>'usdt_address' <> 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' then raise exception 'bad settings %', s; end if;
end $$;
do $$ begin
  insert into receive_settings(user_id, method) values ('e9000000-0000-0000-0000-0000000000b1', 'lightning') on conflict (user_id) do update set method = 'lightning';
  raise exception 'direct write to receive_settings allowed';
exception when insufficient_privilege then null; end $$;
reset role;
select set_config('request.jwt.claims', '', true);
do $$ begin
  if not exists (select 1 from audit_log where action = 'payout.receive_method' and subject_id = 'e9000000-0000-0000-0000-0000000000b1') then raise exception 'not audited'; end if;
  if not exists (select 1 from support_messages where user_id = 'e9000000-0000-0000-0000-0000000000b1' and message like 'Security notice: your payments are now sent as USDT%') then raise exception 'not notified'; end if;
end $$;

-- 2. Settled payments become USDT rows (fee deducted); Lightning worker skips them.
select pg_temp.pay('e9000000-0000-0000-0000-0000000002b1', 1, 1000);
select pg_temp.pay('e9000000-0000-0000-0000-0000000002b2', 2, 2000);
do $$ begin
  if (select count(*) from payment_forwards where user_id = 'e9000000-0000-0000-0000-0000000000b1' and kind = 'usdt' and network = 'tron' and status = 'queued') <> 2 then
    raise exception 'usdt rows not queued'; end if;
  if (select sum(forward_sat) from payment_forwards where user_id = 'e9000000-0000-0000-0000-0000000000b1') <> 2940 then raise exception 'fee not deducted'; end if;
  if exists (select 1 from system_forward_claim(10)) then raise exception 'lightning worker took a usdt row'; end if;
end $$;

-- 3. Below the minimum: accumulate (still queued, reason accumulating).
do $$ declare g record; begin
  select * into g from system_usdt_due() where user_id = 'e9000000-0000-0000-0000-0000000000b1';
  if g.n <> 2 or g.total_usd <> 2.94 or g.total_sat <> 2940 then raise exception 'due group %', to_jsonb(g); end if;
  perform system_usdt_mark_accumulating(g.user_id, g.network);
  if (select count(*) from payment_forwards where reason = 'accumulating' and status = 'queued') <> 2 then raise exception 'not accumulating'; end if;
end $$;

-- 4. Batch: one open batch per user+network; rows sending; finish idempotent.
do $$ declare b forward_batches; b2 forward_batches; begin
  select * into b from system_usdt_batch_create('e9000000-0000-0000-0000-0000000000b1', 'tron', 'orchestra:tron:usdt');
  if b.amount_sat <> 2940 or b.address <> 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL' then raise exception 'batch %', to_jsonb(b); end if;
  perform pg_temp.pay('e9000000-0000-0000-0000-0000000002b3', 1, 1000);
  select * into b2 from system_usdt_batch_create('e9000000-0000-0000-0000-0000000000b1', 'tron', 'orchestra:tron:usdt');
  if b2.id is not null then raise exception 'second open batch'; end if;
  if exists (select 1 from system_usdt_due()) then raise exception 'due while a batch is open'; end if;
  if (select count(*) from payment_forwards where batch_id = b.id and status = 'sending') <> 2 then raise exception 'rows not in batch'; end if;
  if system_usdt_batch_finish(b.id, 'forwarded', 'pay-usdt-1', '2.90', 0.04) <> 'forwarded' then raise exception 'not forwarded'; end if;
  if system_usdt_batch_finish(b.id, 'retry', null, null, null, 'late') <> 'forwarded' then raise exception 'finish not idempotent'; end if;
  if (select count(*) from payment_forwards where batch_id = b.id and status = 'forwarded' and sent_sat = forward_sat) <> 2 then raise exception 'rows not forwarded'; end if;
end $$;

-- 5. Next batch fails: retry with backoff; after max attempts, owed.
insert into platform_settings(key, value) values ('instant_forward_max_attempts', '2');
do $$ declare b forward_batches; begin
  select * into b from system_usdt_batch_create('e9000000-0000-0000-0000-0000000000b1', 'tron', 'orchestra:tron:usdt');
  perform system_usdt_batch_finish(b.id, 'retry', null, null, null, 'quote expired');
  if (select status from payment_forwards where payment_id = 'e9000000-0000-0000-0000-0000000002b3') <> 'retry' then raise exception 'not retry'; end if;
  if exists (select 1 from system_usdt_batch_create('e9000000-0000-0000-0000-0000000000b1', 'tron', 'orchestra:tron:usdt')) then raise exception 'batched before backoff'; end if;
  update payment_forwards set next_attempt_at = now() - interval '1 second' where payment_id = 'e9000000-0000-0000-0000-0000000002b3';
  select * into b from system_usdt_batch_create('e9000000-0000-0000-0000-0000000000b1', 'tron', 'orchestra:tron:usdt');
  perform system_usdt_batch_finish(b.id, 'retry', null, null, null, 'quote expired');
  if (select status from payment_forwards where payment_id = 'e9000000-0000-0000-0000-0000000002b3') <> 'owed' then raise exception 'not owed'; end if;
end $$;

-- 6. Invariant holds; balance excludes forwarded/owed USDT rows.
do $$ begin
  if not (instant_forward_invariants()->>'ok')::boolean then raise exception 'invariant %', instant_forward_invariants(); end if;
  if (select earned from get_balance_for('e9000000-0000-0000-0000-0000000000b1')) <> 0 then raise exception 'usdt forwards counted in balance'; end if;
end $$;

-- 7. Mode off: nothing due, no batch.
update platform_settings set value = '"balance"' where key = 'payment_mode';
do $$ begin
  if exists (select 1 from system_usdt_due()) or exists (select 1 from system_usdt_batch_create('e9000000-0000-0000-0000-0000000000b1', 'tron', 'x')) then
    raise exception 'usdt batch while off'; end if;
end $$;
do $$ begin
  if has_function_privilege('authenticated', 'public.system_usdt_batch_create(uuid, text, text)', 'execute') then raise exception 'batch create exposed'; end if;
end $$;
rollback;
\echo usdt forward OK
