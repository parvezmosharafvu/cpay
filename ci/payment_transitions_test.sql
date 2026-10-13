-- Pins the payment status transitions documented in docs/PAYMENT-STATES.md
-- for every production writer. Behaviour test only: no trigger, no
-- enforcement, no ledger change. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
-- auth.uid() from the request claim, as PostgREST sets it (same as revenue_desk test).
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
declare
  v_user uuid := gen_random_uuid(); v_link uuid := gen_random_uuid();
  h_new text := repeat('a1', 32); h_exp text := repeat('b2', 32); h_inv text := repeat('c3', 32); h_low text := repeat('d4', 32);
  p_new uuid; p_exp uuid; p_inv uuid; p_low uuid; p_old uuid; p_fut uuid;
  r text; n int;
begin
  insert into auth.users(id, email) values (v_user, 'states-' || v_user || '@example.test');
  update profiles set account_status = 'active' where id = v_user;
  insert into payment_links(id, user_id, slug, is_active) values (v_link, v_user, 'st-' || left(v_user::text, 8), true);
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, amount_sat)
    values (v_link, v_user, 10, 'new', now() + interval '1 hour', h_new, 1000) returning id into p_new;
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, amount_sat)
    values (v_link, v_user, 10, 'expired', now() - interval '1 hour', h_exp, 1000) returning id into p_exp;
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, amount_sat)
    values (v_link, v_user, 10, 'invalid', now() + interval '1 hour', h_inv, 1000) returning id into p_inv;
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, amount_sat)
    values (v_link, v_user, 10, 'new', now() + interval '1 hour', h_low, 1000) returning id into p_low;

  -- settle: new -> settled, exactly once
  r := settle_breez_payment('st-1', h_new, 1000);
  if r <> 'settled' or (select status from payments where id = p_new) <> 'settled' then raise exception 'new->settled: %', r; end if;
  r := settle_breez_payment('st-1', h_new, 1000);
  if r <> 'duplicate' then raise exception 'duplicate event: %', r; end if;
  r := settle_breez_payment('st-1b', h_new, 1000);
  if r <> 'already_settled' then raise exception 'second receipt for a settled payment: %', r; end if;
  -- settle: expired -> settled (late payment; money is in the wallet)
  r := settle_breez_payment('st-2', h_exp, 1000);
  if r <> 'settled' or (select status from payments where id = p_exp) <> 'settled' then raise exception 'expired->settled: %', r; end if;
  -- settle never touches invalid
  r := settle_breez_payment('st-3', h_inv, 1000);
  if r <> 'not_settleable' or (select status from payments where id = p_inv) <> 'invalid' then raise exception 'invalid must stay invalid: %', r; end if;
  -- underpaid stays new
  r := settle_breez_payment('st-4', h_low, 999);
  if r <> 'underpaid' or (select status from payments where id = p_low) <> 'new' then raise exception 'underpaid must stay new: %', r; end if;

  -- expire (the wallet sync query, ledger.mjs expireUnpaid): only new, invoiced, past expiry
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, amount_sat)
    values (v_link, v_user, 10, 'new', now() - interval '1 minute', 500) returning id into p_old;
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, amount_sat)
    values (v_link, v_user, 10, 'new', now() + interval '1 minute', 500) returning id into p_fut;
  update payments set status = 'expired' where status = 'new' and amount_sat is not null and expires_at < now() and payment_link_id = v_link;
  get diagnostics n = row_count;
  if n <> 1 or (select status from payments where id = p_old) <> 'expired' or (select status from payments where id = p_fut) <> 'new'
     or (select status from payments where id = p_new) <> 'settled' then raise exception 'expiry touched the wrong rows (%)', n; end if;

  -- admin path refuses to change a settled payment
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    perform admin_mark_payment(p_new, 'invalid', null);
    raise exception 'admin_mark_payment changed a settled payment';
  exception when raise_exception then
    if sqlerrm not like '%already settled%' then raise; end if;
  end;
  -- admin path: non-settled -> expired/invalid/settled allowed, nothing else
  perform admin_mark_payment(p_fut, 'invalid', null);
  if (select status from payments where id = p_fut) <> 'invalid' then raise exception 'admin new->invalid'; end if;
  begin
    perform admin_mark_payment(p_fut, 'new', null);
    raise exception 'admin_mark_payment accepted status new';
  exception when raise_exception then
    if sqlerrm not like '%Invalid status%' then raise; end if;
  end;

  -- ---- trigger 20261013090000 ----
  perform set_config('request.jwt.claims', '', true);
  perform set_config('cpay.payment_admin_context', '', true);
  -- idempotent no-op on a settled row is fine
  update payments set status = 'settled' where id = p_new;
  -- non-admin reversal blocked
  begin
    update payments set status = 'invalid' where id = p_new;
    raise exception 'non-admin settled->invalid was allowed';
  exception when insufficient_privilege then null;
  end;
  -- never back to new / pending / expired from settled, even as admin
  perform set_config('cpay.payment_admin_context', 'on', true);
  begin
    update payments set status = 'expired' where id = p_new;
    raise exception 'settled->expired was allowed';
  exception when check_violation then null;
  end;
  begin
    update payments set status = 'new' where id = p_fut;
    raise exception 'invalid->new was allowed';
  exception when check_violation then null;
  end;
end $$;

-- admin JWT (is_admin()) reversal allowed; re-settle allowed; settlement
-- paths unaffected with the trigger in place
do $$
declare v_admin uuid := gen_random_uuid(); v_user uuid := gen_random_uuid(); v_link uuid := gen_random_uuid();
        p uuid; q uuid; r text; h text := repeat('e5', 32); h2 text := repeat('f6', 32);
begin
  insert into auth.users(id, email) values (v_admin, 'st-admin-' || v_admin || '@example.test'), (v_user, 'st-u-' || v_user || '@example.test');
  update profiles set role = 'admin', account_status = 'active' where id = v_admin;
  update profiles set account_status = 'active' where id = v_user;
  insert into payment_links(id, user_id, slug, is_active) values (v_link, v_user, 'st2-' || left(v_user::text, 8), true);
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, amount_sat)
    values (v_link, v_user, 10, 'new', now() + interval '1 hour', h, 1000) returning id into p;
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, invoice_ref, amount_sat)
    values (v_link, v_user, 10, 'expired', now() - interval '2 hours', h2, 1000) returning id into q;
  perform set_config('cpay.payment_admin_context', '', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  -- settle loop + late payment + duplicate with the trigger active
  r := settle_breez_payment('st2-1', h, 1000); if r <> 'settled' then raise exception 'settle with trigger: %', r; end if;
  r := settle_breez_payment('st2-1', h, 1000); if r <> 'duplicate' then raise exception 'dup with trigger: %', r; end if;
  r := settle_breez_payment('st2-1b', h, 1000); if r <> 'already_settled' then raise exception 'resettle with trigger: %', r; end if;
  r := settle_breez_payment('st2-2', h2, 1000); if r <> 'settled' then raise exception 'late pay with trigger: %', r; end if;
  -- signed-in non-admin JWT still blocked
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',v_user)::text, true);
  begin
    update payments set status = 'invalid' where id = p;
    raise exception 'creator reversed a payment';
  exception when insufficient_privilege then null;
  end;
  -- admin JWT: reversal and re-settle allowed
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', json_build_object('role','authenticated','sub',v_admin)::text, true);
  update payments set status = 'invalid' where id = p;
  if (select status from payments where id = p) <> 'invalid' then raise exception 'admin reversal failed'; end if;
  update payments set status = 'settled' where id = p;
  if (select status from payments where id = p) <> 'settled' then raise exception 'admin re-settle failed'; end if;
  -- admin_mark_payment path still works for non-settled rows
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at)
    values (v_link, v_user, 10, 'new', now() + interval '1 hour') returning id into q;
  perform admin_mark_payment(q, 'settled', null);
  if (select status from payments where id = q) <> 'settled' then raise exception 'admin_mark_payment settle failed'; end if;
end $$;
rollback;
select 'payment transitions match docs/PAYMENT-STATES.md' as result;
