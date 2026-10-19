-- 20261020020000: platform settings enforced in the database. Defaults keep
-- today's behaviour; each switch, when off, stops its path; the pilot list
-- opens direct payments for one account only; admin-send limits. BEGIN/ROLLBACK.
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
  ('e7000000-0000-0000-0000-0000000000f1', 'pse-pilot@test.invalid'),
  ('e7000000-0000-0000-0000-0000000000f2', 'pse-other@test.invalid');
update profiles set account_status = 'active' where id::text like 'e7000000-%';

-- 1. Defaults: links, payments and withdrawals behave as before.
insert into payment_links(id, user_id, slug) values ('e7000000-0000-0000-0000-0000000001f1', 'e7000000-0000-0000-0000-0000000000f1', 'pse-link-one');
insert into payments(user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('e7000000-0000-0000-0000-0000000000f1', 'e7000000-0000-0000-0000-0000000001f1', 10, 'lightning', 'new', now() + interval '15 min', 'pse-ref-1');
do $$ begin
  if direct_settlement_enabled_for('e7000000-0000-0000-0000-0000000000f1') or direct_settlement_available() then
    raise exception 'direct on by default'; end if;
  if (select settlement_mode from payment_links where slug = 'pse-link-one') <> 'custodial' then raise exception 'default link not custodial'; end if;
end $$;

-- 2. Pilot: one account only, while the global switch is off.
insert into platform_settings(key, value) values ('direct_pilot_user_ids', '["e7000000-0000-0000-0000-0000000000f1"]');
do $$ begin
  if direct_settlement_enabled() then raise exception 'global switch changed'; end if;
  if not direct_settlement_enabled_for('e7000000-0000-0000-0000-0000000000f1') then raise exception 'pilot not enabled'; end if;
  if direct_settlement_enabled_for('e7000000-0000-0000-0000-0000000000f2') then raise exception 'non-pilot enabled'; end if;
  if not direct_settlement_available() then raise exception 'direct-invoice would refuse the pilot'; end if;
end $$;
select system_set_settlement_destination('e7000000-0000-0000-0000-0000000000f1', 'pilot@pay.example.com', 'pay.example.com', 1000, 1000000);
do $$ begin
  perform system_set_settlement_destination('e7000000-0000-0000-0000-0000000000f2', 'other@pay.example.com', 'pay.example.com', 1000, 1000000);
  raise exception 'non-pilot saved a destination';
exception when raise_exception then if sqlerrm not like 'Direct payments are not available yet%' then raise; end if; end $$;
alter table settlement_destinations disable trigger trg_guard_settlement_destination_changes;
update settlement_destinations set ready_at = now() - interval '1 minute' where user_id = 'e7000000-0000-0000-0000-0000000000f1';
alter table settlement_destinations enable trigger trg_guard_settlement_destination_changes;
do $$ begin
  if not exists (select 1 from system_direct_destination_for('e7000000-0000-0000-0000-0000000000f1')) then raise exception 'pilot destination not usable'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7000000-0000-0000-0000-0000000000f1', true);
do $$ begin
  if not (get_my_direct_settlement()->>'enabled')::boolean then raise exception 'pilot desk sees it off'; end if;
end $$;
select set_link_settlement_mode('e7000000-0000-0000-0000-0000000001f1', 'direct');
select set_config('request.jwt.claim.sub', 'e7000000-0000-0000-0000-0000000000f2', true);
do $$ begin
  if (get_my_direct_settlement()->>'enabled')::boolean then raise exception 'non-pilot desk sees it on'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- 3. New custodial links off: pilot's new link becomes direct; others refused.
insert into platform_settings(key, value) values ('custodial_new_links_enabled', 'false');
insert into payment_links(id, user_id, slug) values ('e7000000-0000-0000-0000-0000000001f3', 'e7000000-0000-0000-0000-0000000000f1', 'pse-link-three');
do $$ begin
  if (select settlement_mode from payment_links where slug = 'pse-link-three') <> 'direct' then raise exception 'new link not direct'; end if;
end $$;
do $$ begin
  insert into payment_links(user_id, slug) values ('e7000000-0000-0000-0000-0000000000f2', 'pse-link-four');
  raise exception 'custodial link created while off';
exception when raise_exception then if sqlerrm not like 'New links are paid straight to your own wallet%' then raise; end if; end $$;
-- A link cannot be inserted direct by hand when the gate is open.
update platform_settings set value = 'true' where key = 'custodial_new_links_enabled';
do $$ begin
  insert into payment_links(user_id, slug, settlement_mode) values ('e7000000-0000-0000-0000-0000000000f1', 'pse-link-five', 'direct');
  raise exception 'direct link inserted by hand';
exception when raise_exception then if sqlerrm not like 'A new link starts with CPAY balance payments%' then raise; end if; end $$;

-- 4. Custodial receive off: no new payment row; an existing one still settles.
insert into payment_links(id, user_id, slug) values ('e7000000-0000-0000-0000-0000000001f2', 'e7000000-0000-0000-0000-0000000000f2', 'pse-link-two');
insert into payments(id, user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
values ('e7000000-0000-0000-0000-0000000002f2', 'e7000000-0000-0000-0000-0000000000f2', 'e7000000-0000-0000-0000-0000000001f2', 10, 'lightning', 'new', now() + interval '15 min', 'pse-ref-2');
insert into platform_settings(key, value) values ('custodial_receive_enabled', 'false');
do $$ begin
  insert into payments(user_id, payment_link_id, amount_requested, method, status, expires_at, invoice_ref)
  values ('e7000000-0000-0000-0000-0000000000f2', 'e7000000-0000-0000-0000-0000000001f2', 10, 'lightning', 'new', now() + interval '15 min', 'pse-ref-3');
  raise exception 'custodial payment created while off';
exception when raise_exception then if sqlerrm not like 'CPAY balance payments are turned off%' then raise; end if; end $$;
update payments set status = 'settled', amount_settled = 10, settled_at = now() where id = 'e7000000-0000-0000-0000-0000000002f2';

-- 5. Withdrawals off: no new withdrawal row on any path.
insert into platform_settings(key, value) values ('custodial_withdraw_enabled', 'false');
do $$ begin
  insert into withdrawals(user_id, amount_requested, method, destination, status)
  values ('e7000000-0000-0000-0000-0000000000f2', 5, 'usdt', 'TXYZ', 'pending');
  raise exception 'withdrawal created while off';
exception when raise_exception then if sqlerrm not like 'Withdrawals from CPAY balances are turned off%' then raise; end if; end $$;

-- 6. Admin-send limits.
do $$ begin
  if system_admin_send_check('anything', 100) <> 0 then raise exception 'default limits not open'; end if;
end $$;
insert into platform_settings(key, value) values ('admin_send_allowed_destinations', '["Cold@Owner.example"]'), ('admin_send_daily_cap_usd', '10');
do $$ begin
  perform system_admin_send_check('somewhere@else.example', 100);
  raise exception 'destination outside the allow-list accepted';
exception when raise_exception then if sqlerrm not like '%allow-list%' then raise; end if; end $$;
select system_admin_send_check('cold@owner.example', 1000);
insert into audit_log(action, subject_type, subject_id, new_value) values ('platform_wallet.send', 'platform_wallet_send', 'x', '{"usdCents": 900}');
do $$ begin
  perform system_admin_send_check('cold@owner.example', 101);
  raise exception 'cap passed';
exception when raise_exception then if sqlerrm not like '%daily cap of $10.00%' then raise; end if; end $$;
select system_admin_send_check('cold@owner.example', 100);

-- 7. Internal functions are not callable by clients.
set local role authenticated;
do $$ begin
  perform system_admin_send_check('x', 1);
  raise exception 'client called the send check';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform direct_settlement_enabled_for(null);
  raise exception 'client called enabled_for';
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin raise notice 'ok: platform settings enforced'; end $$;
rollback;
