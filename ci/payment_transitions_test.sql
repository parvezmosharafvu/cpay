-- Pins the payment status transitions documented in docs/PAYMENT-STATES.md
-- for every production writer. Behaviour test only: no trigger, no
-- enforcement, no ledger change. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
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
end $$;
rollback;
select 'payment transitions match docs/PAYMENT-STATES.md' as result;
