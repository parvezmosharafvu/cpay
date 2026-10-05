-- Telegram messages (0106, admin group only since 20261005020000) against a
-- freshly migrated database: one settled-payment message per payment to the
-- admin group, re-runs that add nothing, no reseller groups or reseller
-- daily close left, and the sender's claim/finish rules. BEGIN/ROLLBACK;
-- any failed check raises and stops psql.
\set ON_ERROR_STOP 1
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

insert into auth.users (id, email, raw_user_meta_data) values
 ('a2000000-0000-0000-0000-000000000001', 'boss@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000001', 'karim@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000002', 'hidden@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000003', 'solo@tg.test', '{}');
update profiles set account_status = 'active' where id in (select id from auth.users where email like '%@tg.test');
update profiles set role = 'admin' where id = 'a2000000-0000-0000-0000-000000000001';
update profiles set display_name = 'Karim' where id = 'c2000000-0000-0000-0000-000000000001';
update profiles set hide_small_payments_mode = 'on' where id = 'c2000000-0000-0000-0000-000000000002';

insert into payment_links (id, user_id, slug, display_name) values
 ('d2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'tg-logo',  'Logo <design>'),
 ('d2000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'tg-promo', null),
 ('d2000000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000003', 'tg-solo',  'Solo'),
 ('d2000000-0000-0000-0000-000000000004', 'c2000000-0000-0000-0000-000000000002', 'tg-hidden', 'Hidden mode'),
 ('d2000000-0000-0000-0000-000000000005', 'c2000000-0000-0000-0000-000000000003', 'tg-solo2',  'Solo two'),
 ('d2000000-0000-0000-0000-000000000006', 'c2000000-0000-0000-0000-000000000001', 'tg-two',    'Two');

-- ---------------------------------------------------------------
-- 1. No reseller groups any more (20261005020000)
-- ---------------------------------------------------------------
do $$
begin
  if to_regclass('public.reseller_alert_channels') is not null
     or to_regprocedure('public.set_reseller_telegram(uuid,text,boolean)') is not null
     or to_regprocedure('public.telegram_resellers_for(uuid)') is not null
     or to_regprocedure('public.enqueue_daily_close(date)') is not null then
    raise exception 'a reseller Telegram object is still there';
  end if;
  raise notice 'PASS reseller groups, their setter and the reseller daily close are gone';
end $$;

-- ---------------------------------------------------------------
-- 2. One message per settled payment, to the admin group
-- ---------------------------------------------------------------
create function pg_temp.pay(p_id int, p_link uuid, p_amount numeric, p_at timestamptz) returns uuid
language plpgsql as $$
declare v_id uuid := ('e2000000-0000-0000-0000-' || lpad(p_id::text, 12, '0'))::uuid;
begin
  insert into payments (id, user_id, payment_link_id, amount_requested, amount_sat, status, expires_at)
  select v_id, pl.user_id, pl.id, p_amount, (p_amount * 1000)::bigint, 'new', now() + interval '1 hour'
  from payment_links pl where pl.id = p_link;
  update payments set status = 'settled', amount_settled = p_amount, settled_at = p_at where id = v_id;
  return v_id;
end $$;

-- Business day Y closes at T, today's 17:00 Dhaka.
create temp table t_clock as
select current_business_day() - 1 as y, business_day_start(current_business_day()) as t;

do $$
declare v_t timestamptz := (select t from t_clock);
begin
  perform pg_temp.pay(1, 'd2000000-0000-0000-0000-000000000001', 100, v_t - interval '1 minute');            -- Y, 16:59
  perform pg_temp.pay(2, 'd2000000-0000-0000-0000-000000000001', 50,  v_t + interval '1 minute');            -- Y+1, 17:01
  perform pg_temp.pay(3, 'd2000000-0000-0000-0000-000000000002', 20,  v_t - interval '3 hours');             -- Y
  perform pg_temp.pay(4, 'd2000000-0000-0000-0000-000000000004', 30,  v_t - interval '20 hours');            -- Y
  perform pg_temp.pay(5, 'd2000000-0000-0000-0000-000000000005', 40,  v_t - interval '5 hours');             -- Y
  perform pg_temp.pay(6, 'd2000000-0000-0000-0000-000000000003', 70,  v_t - interval '2 hours');             -- Y
  perform pg_temp.pay(7, 'd2000000-0000-0000-0000-000000000006', 25,  v_t - interval '1 hour');              -- Y
  perform pg_temp.pay(8, 'd2000000-0000-0000-0000-000000000001', 10.01, v_t - interval '24 hours 1 minute'); -- Y-1, 16:59
  perform pg_temp.pay(9, 'd2000000-0000-0000-0000-000000000004', 5,   v_t - interval '4 hours');             -- Y, hidden (under 10)
  perform pg_temp.pay(10, 'd2000000-0000-0000-0000-000000000001', 33.33, v_t - interval '6 hours');          -- Y
end $$;

do $$
declare v_expect text; v_got text; p jsonb;
begin
  select string_agg(right(ref, 2) || ':' || recipient, ' ' order by ref, recipient)
    into v_got from telegram_outbox where kind = 'payment_settled';
  v_expect := '01:admin 02:admin 03:admin 04:admin 05:admin 06:admin 07:admin 08:admin 10:admin';
  if v_got <> v_expect then raise exception 'payment_settled rows: % (expected %)', v_got, v_expect; end if;
  if exists (select 1 from telegram_outbox where recipient <> 'admin' or chat <> 'admin') then
    raise exception 'a row is not for the admin group';
  end if;

  select payload into p from telegram_outbox where ref like '%000000000001';
  if p->>'link_name' <> 'Logo <design>' or (p->>'amount_usd')::numeric <> 100 or (p->>'amount_sat')::bigint <> 100000
     or (p->>'fee_usd')::numeric <> 3 or (p->>'net_usd')::numeric <> 97 or p->>'owner_name' <> 'Karim'
     or (p->>'show_owner')::boolean is not true or p ? 'reseller_name' then
    raise exception 'payload for payment 1: %', p;
  end if;
  select payload into p from telegram_outbox where ref like '%000000000003';
  if p->>'link_name' <> 'tg-promo' then raise exception 'unnamed link falls back to the slug: %', p; end if;
  raise notice 'PASS 9 rows, all to the admin group; hidden $5 to nobody; payload amounts, fee 3%%, net, names';
end $$;

-- Re-settling (an admin marks it invalid, then settled again) and a
-- duplicate settle add nothing.
do $$
declare v_before int := (select count(*) from telegram_outbox);
begin
  update payments set status = 'invalid' where id = 'e2000000-0000-0000-0000-000000000001';
  update payments set status = 'settled' where id = 'e2000000-0000-0000-0000-000000000001';
  update payments set amount_settled = amount_settled where id = 'e2000000-0000-0000-0000-000000000001';
  insert into payments (user_id, payment_link_id, amount_requested, amount_settled, status, settled_at, expires_at)
  values ('c2000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 12, 12, 'settled', now(), now() + interval '1 hour');
  if (select count(*) from telegram_outbox) <> v_before then raise exception 'a re-settle or an insert queued another message'; end if;
  update payments set status = 'invalid' where amount_requested = 12 and user_id = 'c2000000-0000-0000-0000-000000000001';
  raise notice 'PASS re-settle, a no-op update and a row inserted as settled queue nothing';
end $$;

-- A failure inside the trigger never blocks the settle.
do $$
declare v_id uuid;
begin
  alter table telegram_outbox add constraint t_break check (kind <> 'payment_settled') not valid;
  v_id := pg_temp.pay(11, 'd2000000-0000-0000-0000-000000000003', 15, now());
  if (select status from payments where id = v_id) <> 'settled' then raise exception 'settle blocked'; end if;
  alter table telegram_outbox drop constraint t_break;
  update payments set status = 'invalid' where id = v_id;
  raise notice 'PASS a broken outbox leaves the payment settled';
end $$;

-- ---------------------------------------------------------------
-- 3. Sender rules
-- ---------------------------------------------------------------
do $$
declare
  v_claimed int; v_id bigint; v_id2 bigint; v_r text;
begin
  select count(*) into v_claimed from telegram_claim(100);
  if v_claimed <> 9 then raise exception 'claimed % rows, expected 9', v_claimed; end if;
  if (select count(*) from telegram_claim(100)) <> 0 then raise exception 'claimed twice'; end if;

  select min(id), max(id) into v_id, v_id2 from telegram_outbox;
  if telegram_finish(v_id, 'sent', 42) <> 'sent' then raise exception 'finish sent'; end if;
  if telegram_finish(v_id, 'sent', 43) <> 'already_sent' then raise exception 'second finish moved a sent row'; end if;
  if (select telegram_message_id from telegram_outbox where id = v_id) <> 42 then raise exception 'message id'; end if;

  if telegram_finish(v_id2, 'retry', null, 'Too Many Requests', 7) <> 'pending' then raise exception 'retry'; end if;
  if (select next_attempt_at from telegram_outbox where id = v_id2) < now() + interval '6 seconds' then raise exception 'retry_after ignored'; end if;
  update telegram_outbox set next_attempt_at = now(), attempts = 4 where id = v_id2;
  perform telegram_claim(100);
  if telegram_finish(v_id2, 'retry', null, 'server error') <> 'failed' then raise exception 'fifth attempt should fail'; end if;

  update telegram_outbox set claimed_at = now() - interval '11 minutes' where status = 'sending' and id = v_id + 1;
  perform telegram_claim(100);
  select status into v_r from telegram_outbox where id = v_id + 1;
  if v_r <> 'failed' then raise exception 'stale sending row is %', v_r; end if;
  raise notice 'PASS claim once; finish only from sending; retry_after honoured; 5 attempts then failed; a sender that died leaves failed, never resent';
end $$;

do $$
begin
  if has_function_privilege('authenticated', 'telegram_claim(int)', 'execute')
     or has_function_privilege('authenticated', 'telegram_finish(bigint,text,bigint,text,int)', 'execute')
     or has_table_privilege('authenticated', 'telegram_outbox', 'select')
     or has_table_privilege('anon', 'telegram_outbox', 'select') then
    raise exception 'browser roles can reach the outbox';
  end if;
  if exists (select 1 from pg_proc where proname in ('telegram_find_payments', 'reseller_cycle_digest', 'list_reseller_alert_targets', 'admin_set_reseller_alerts', 'should_suppress_payment_alert')) then
    raise exception 'an old function is still there';
  end if;
  raise notice 'PASS browser roles cannot reach the outbox or the sender functions; old functions gone';
end $$;

rollback;
