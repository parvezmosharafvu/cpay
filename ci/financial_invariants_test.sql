-- Chat 4: financial invariants on a migrated schema.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ci/financial_invariants_test.sql

\set ON_ERROR_STOP on

do $$
declare
  u uuid := gen_random_uuid();
  -- Per-run ids so the script can be re-run on the same database.
  ref text := md5(u::text) || md5(reverse(u::text));
  bid text := 'breez-fin-' || u::text;
  bal numeric;
  earned_after numeric;
  outcome text;
  closed_ok boolean := false;
  reserve_ok boolean := false;
begin
  insert into auth.users(id, email) values (u, 'fin-inv-' || u::text || '@test.invalid');
  update profiles set role = 'creator', account_status = 'active', withdrawal_fee_percent = 0 where id = u;

  select available into bal from get_balance_for(u);
  if bal <> 0 then raise exception 'expected zero available, got %', bal; end if;

  insert into payments(user_id, invoice_ref, lightning_invoice, amount_requested, amount_sat, btc_usd_rate, status, expires_at)
  values (u, ref, 'lnbcrt1fininv', 10.00, 10000, 100000, 'new', now() + interval '1 hour');

  select settle_breez_payment(bid, ref, 10000) into outcome;
  if outcome <> 'settled' then raise exception 'first settle expected settled, got %', outcome; end if;

  select earned into earned_after from get_balance_for(u);
  if earned_after <= 0 then raise exception 'earned must be positive after settle, got %', earned_after; end if;

  select settle_breez_payment(bid, ref, 10000) into outcome;
  if outcome not in ('duplicate', 'already_settled') then
    raise exception 'replay settle must be duplicate/already_settled, got %', outcome;
  end if;

  select earned into bal from get_balance_for(u);
  if bal <> earned_after then
    raise exception 'replay changed earned from % to %', earned_after, bal;
  end if;

  begin
    perform reserve_stablecoin_withdrawal(
      u, gen_random_uuid()::text, 999999.00, 0, 999999.00,
      'USDT', 'TRON', 'TXYZopqrstuvwxyzabcdefghijkmnopqrs',
      1.00, 999998.00, 1, now() + interval '10 minutes'
    );
  exception
    when others then
      -- Only the balance guard counts. Any other error (signature drift,
      -- approval gate, emergency stop) would make this check pass vacuously.
      if sqlerrm ilike '%Insufficient balance%' then
        reserve_ok := true;
      else
        raise exception 'reserve failed for the wrong reason: %', sqlerrm;
      end if;
  end;
  if not reserve_ok then
    raise exception 'reserve of huge amount should have failed';
  end if;

  select available into bal from get_balance_for(u);
  if bal < 0 then raise exception 'available went negative: %', bal; end if;

  begin
    perform set_config('request.jwt.claim.sub', u::text, true);
    perform request_withdrawal(1.00, 'usdt', 'TXYZopqrstuvwxyzabcdefghijkmnopqrs');
  exception
    when others then
      if sqlerrm ilike '%USDT%' or sqlerrm ilike '%saved wallet%' then
        closed_ok := true;
      else
        raise exception 'unexpected request_withdrawal error: %', sqlerrm;
      end if;
  end;
  if not closed_ok then
    raise exception 'request_withdrawal should be closed';
  end if;

  if not exists (select 1 from pg_proc where proname = 'finalize_stablecoin_withdrawal') then
    raise exception 'finalize_stablecoin_withdrawal missing';
  end if;

  delete from webhook_events where delivery_id like 'breez-fin-%';
  delete from payments where user_id = u;
  delete from withdrawals where user_id = u;
  perform set_config('cpay.audit_maintenance', 'on', true);
  delete from audit_log where actor_id = u;
  delete from auth.users where id = u;

  raise notice 'financial_invariants_test: PASS';
end $$;
