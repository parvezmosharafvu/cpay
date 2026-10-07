-- ============================================================
-- P2 item 6 (20261007110000): anon sees only its own invoice by id
-- ============================================================
-- anon cannot read the payments table (no rows, no columns), cannot call
-- public_settled_feed, and still gets its own invoice from
-- get_invoice_public(uuid) and lookup_payment_status(full hash).
-- BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
do $$
declare v_user uuid := gen_random_uuid(); v_pay uuid := gen_random_uuid(); v_link uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values (v_user, 'exposure-' || v_user || '@example.test');
  update profiles set account_status = 'active', display_name = 'Exposure Test' where id = v_user;
  insert into payment_links(id, user_id, slug, is_active) values (v_link, v_user, 'exposure-' || left(v_user::text, 8), true);
  insert into payments(id, payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, lightning_invoice)
  values (v_pay, v_link, v_user, 12.34, 'new', now() + interval '30 minutes', repeat('a', 64), 'lnbcexposuretest');
  perform set_config('cpay.test_pay', v_pay::text, true);
end $$;

set local role anon;
do $$
declare n int; r record;
begin
  if has_table_privilege('anon', 'public.payments', 'select') then raise exception 'anon still has table SELECT on payments'; end if;
  if has_any_column_privilege('anon', 'public.payments', 'select') then raise exception 'anon still has column SELECT on payments'; end if;
  if has_table_privilege('anon', 'public.payments', 'insert') or has_table_privilege('anon', 'public.payments', 'update')
     or has_table_privilege('anon', 'public.payments', 'delete') then raise exception 'anon still has a write privilege on payments'; end if;
  begin
    select count(*) into n from public.payments;
    raise exception 'anon could query payments (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.public_settled_feed(5);
    raise exception 'anon could call public_settled_feed';
  exception when insufficient_privilege then null;
  end;
  select * into r from public.get_invoice_public(current_setting('cpay.test_pay')::uuid);
  if r.status is distinct from 'new' or r.amount_requested <> 12.34 or r.merchant_name is distinct from 'Exposure Test' then
    raise exception 'get_invoice_public broke for anon: %', row_to_json(r);
  end if;
  select * into r from public.lookup_payment_status(repeat('a', 64));
  if r.status is distinct from 'new' then raise exception 'lookup_payment_status broke for anon'; end if;
  select count(*) into n from public.lookup_payment_status(repeat('a', 63) || 'b');
  if n <> 0 then raise exception 'lookup_payment_status matched a different reference'; end if;
end $$;
reset role;

do $$
begin
  if exists (select 1 from pg_policies where tablename = 'payments' and 'anon' = any(roles)) then
    raise exception 'an anon policy is still on payments';
  end if;
  if has_function_privilege('authenticated', 'public.public_settled_feed(integer)', 'execute') then
    raise exception 'authenticated can still call public_settled_feed';
  end if;
end $$;
select 'public exposure test passed' as result;
rollback;
