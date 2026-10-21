-- 20261021070000: forwards record the saved row they used, batches keep the
-- wallet payment id apart from payment_ref, and create/finish are audited
-- without addresses. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
insert into auth.users(id, email) values ('e9100000-0000-0000-0000-0000000000c1', 'fwd-trace@test.invalid');
update profiles set account_status = 'active', platform_fee_percent = 2 where id = 'e9100000-0000-0000-0000-0000000000c1';
insert into payment_links(id, user_id, slug) values ('e9100000-0000-0000-0000-0000000001c1', 'e9100000-0000-0000-0000-0000000000c1', 'fwd-trace-link');
insert into usdt_wallets(user_id, network, address) values ('e9100000-0000-0000-0000-0000000000c1', 'tron', 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL');
insert into receive_settings(user_id, method, usdt_network) values ('e9100000-0000-0000-0000-0000000000c1', 'usdt', 'tron')
  on conflict (user_id) do update set method = 'usdt', usdt_network = 'tron';
insert into platform_settings(key, value) values ('payment_mode', '"instant_forward"') on conflict (key) do update set value = excluded.value;
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('e9100000-0000-0000-0000-0000000002c1', 'e9100000-0000-0000-0000-0000000000c1', 'e9100000-0000-0000-0000-0000000001c1', 3, 'lightning', 'new', now() + interval '15 min', 'ft-1');
update payments set status = 'settled', amount_settled = 3, amount_sat = 3000, settled_at = now() where id = 'e9100000-0000-0000-0000-0000000002c1';

do $$ declare f payment_forwards; w uuid; b forward_batches; a audit_log; begin
  select id into w from usdt_wallets where user_id = 'e9100000-0000-0000-0000-0000000000c1';
  select * into f from payment_forwards where payment_id = 'e9100000-0000-0000-0000-0000000002c1';
  if f.id is null or f.kind <> 'usdt' then raise exception 'no usdt forward %', to_jsonb(f); end if;
  if f.usdt_wallet_id is distinct from w then raise exception 'saved wallet not recorded'; end if;
  select * into a from audit_log where action = 'forward.created' and subject_id = f.id::text;
  if a.id is null then raise exception 'create not audited'; end if;
  if (a.new_value->>'usdt_wallet_id')::uuid <> w then raise exception 'audit lacks wallet id'; end if;
  if a::text like '%TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL%' then raise exception 'audit has the address'; end if;

  select * into b from system_usdt_batch_create('e9100000-0000-0000-0000-0000000000c1', 'tron', 'orchestra:tron:usdt');
  if b.usdt_wallet_id is distinct from w then raise exception 'batch wallet not recorded'; end if;
  perform system_usdt_batch_payment(b.id, 'spark-pay-1');
  perform system_usdt_batch_payment(b.id, 'spark-pay-2');  -- set once
  perform system_usdt_batch_finish(b.id, 'forwarded', 'ref-1', '2.90', 0.04);
  select * into b from forward_batches where id = b.id;
  if b.spark_payment_id <> 'spark-pay-1' or b.payment_ref <> 'ref-1' then raise exception 'ids %', to_jsonb(b); end if;
  select * into a from audit_log where action = 'forward.batch_forwarded' and subject_id = b.id::text;
  if a.id is null or a.new_value->>'spark_payment_id' <> 'spark-pay-1' then raise exception 'finish not audited'; end if;
  if a::text like '%TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL%' then raise exception 'audit has the address'; end if;
end $$;

-- A failed batch is audited too.
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('e9100000-0000-0000-0000-0000000002c2', 'e9100000-0000-0000-0000-0000000000c1', 'e9100000-0000-0000-0000-0000000001c1', 3, 'lightning', 'new', now() + interval '15 min', 'ft-2');
update payments set status = 'settled', amount_settled = 3, amount_sat = 3000, settled_at = now() where id = 'e9100000-0000-0000-0000-0000000002c2';
do $$ declare b forward_batches; begin
  select * into b from system_usdt_batch_create('e9100000-0000-0000-0000-0000000000c1', 'tron', 'orchestra:tron:usdt');
  perform system_usdt_batch_finish(b.id, 'retry', null, null, null, 'quote expired');
  if not exists (select 1 from audit_log where action = 'forward.batch_failed' and subject_id = b.id::text and note = 'quote expired') then
    raise exception 'failure not audited'; end if;
  if has_function_privilege('authenticated', 'public.system_usdt_batch_payment(uuid, text)', 'execute') then raise exception 'exposed'; end if;
end $$;
rollback;
\echo forward traceability OK
