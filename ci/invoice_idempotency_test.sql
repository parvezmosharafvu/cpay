-- ============================================================
-- P2 items 2 and 7 (20261007120000)
-- ============================================================
-- One payments row per (link, client_request_id); NULL request ids keep
-- the old behaviour; claim_public_rate_limit counts per bucket+key, resets
-- after the window, and is service-role only. BEGIN/ROLLBACK.
\set ON_ERROR_STOP on
begin;
do $$
declare v_user uuid := gen_random_uuid(); v_link uuid := gen_random_uuid(); v_req uuid := gen_random_uuid();
        v_ok boolean; i int; n int; k text := repeat('ab', 32);
begin
  insert into auth.users(id, email) values (v_user, 'idem-' || v_user || '@example.test');
  update profiles set account_status = 'active' where id = v_user;
  insert into payment_links(id, user_id, slug, is_active) values (v_link, v_user, 'idem-' || left(v_user::text, 8), true);

  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, client_request_id)
  values (v_link, v_user, 10, 'new', now() + interval '1 hour', v_req);
  begin
    insert into payments(payment_link_id, user_id, amount_requested, status, expires_at, client_request_id)
    values (v_link, v_user, 10, 'new', now() + interval '1 hour', v_req);
    raise exception 'a second payment with the same client_request_id was accepted';
  exception when unique_violation then null;
  end;
  -- NULL request ids: unlimited as before.
  insert into payments(payment_link_id, user_id, amount_requested, status, expires_at)
  select v_link, v_user, 10, 'new', now() + interval '1 hour' from generate_series(1, 3);
  select count(*) into n from payments where payment_link_id = v_link;
  if n <> 4 then raise exception 'expected 4 payments, got %', n; end if;

  for i in 1..3 loop
    v_ok := claim_public_rate_limit('invoice_ip', k, 3, 60);
    if not v_ok then raise exception 'claim % refused under the limit', i; end if;
  end loop;
  if claim_public_rate_limit('invoice_ip', k, 3, 60) then raise exception 'fourth claim allowed over a limit of 3'; end if;
  -- Another bucket or key is independent.
  if not claim_public_rate_limit('invoice_link', k, 3, 60) then raise exception 'buckets are not independent'; end if;
  if not claim_public_rate_limit('invoice_ip', repeat('cd', 32), 3, 60) then raise exception 'keys are not independent'; end if;
  -- Window expiry resets the count.
  update public_rate_limits set window_started_at = now() - interval '61 seconds' where bucket = 'invoice_ip' and key_hash = k;
  if not claim_public_rate_limit('invoice_ip', k, 3, 60) then raise exception 'window did not reset'; end if;
  begin
    perform claim_public_rate_limit('invoice_ip', 'not-a-hash', 3, 60);
    raise exception 'a non-hash key was stored';
  exception when check_violation then null;
  end;
end $$;

do $$
begin
  if has_function_privilege('anon', 'public.claim_public_rate_limit(text,text,integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_public_rate_limit(text,text,integer,integer)', 'execute') then
    raise exception 'claim_public_rate_limit is callable from the browser';
  end if;
  if has_table_privilege('anon', 'public.public_rate_limits', 'select') or has_table_privilege('authenticated', 'public.public_rate_limits', 'select') then
    raise exception 'public_rate_limits is readable from the browser';
  end if;
end $$;
select 'invoice idempotency + public rate limit test passed' as result;
rollback;
