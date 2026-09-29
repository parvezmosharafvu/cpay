-- Telegram messages (0106) against a freshly migrated database: where each
-- reseller's group is set, one settled-payment message per payment and
-- recipient, the 17:00 Dhaka daily close with its numbers, re-runs that
-- add nothing, and the sender's claim/finish rules. BEGIN/ROLLBACK; any
-- failed check raises and stops psql.
\set ON_ERROR_STOP 1
begin;

create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

insert into auth.users (id, email, raw_user_meta_data) values
 ('a2000000-0000-0000-0000-000000000001', 'boss@tg.test', '{}'),
 ('b2000000-0000-0000-0000-000000000001', 'res.one@tg.test', '{}'),
 ('b2000000-0000-0000-0000-000000000002', 'res.two@tg.test', '{}'),
 ('b2000000-0000-0000-0000-000000000003', 'res.nogroup@tg.test', '{}'),
 ('b2000000-0000-0000-0000-000000000004', 'res.quiet@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000001', 'aff@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000002', 'assigned@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000003', 'solo@tg.test', '{}'),
 ('c2000000-0000-0000-0000-000000000004', 'aff.two@tg.test', '{}');
update profiles set account_status = 'active' where id in (select id from auth.users where email like '%@tg.test');
update profiles set role = 'admin' where id = 'a2000000-0000-0000-0000-000000000001';
update profiles set role = 'moderator' where id::text like 'b2000000%';
update profiles set display_name = 'Rahim <Team> & Co' where id = 'b2000000-0000-0000-0000-000000000001';
update profiles set display_name = 'Karim' where id = 'c2000000-0000-0000-0000-000000000001';
update profiles set referred_by = 'b2000000-0000-0000-0000-000000000001' where id = 'c2000000-0000-0000-0000-000000000001';
update profiles set referred_by = 'b2000000-0000-0000-0000-000000000002' where id = 'c2000000-0000-0000-0000-000000000004';
update profiles set hide_small_payments_mode = 'on' where id = 'c2000000-0000-0000-0000-000000000002';
insert into moderator_assignments (moderator_id, creator_id)
values ('b2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000002');

insert into payment_links (id, user_id, slug, display_name) values
 ('d2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'tg-logo',  'Logo <design>'),
 ('d2000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001', 'tg-promo', null),
 ('d2000000-0000-0000-0000-000000000003', 'c2000000-0000-0000-0000-000000000003', 'tg-solo',  'Solo'),
 ('d2000000-0000-0000-0000-000000000004', 'c2000000-0000-0000-0000-000000000002', 'tg-asg',   'Assigned work'),
 ('d2000000-0000-0000-0000-000000000005', 'b2000000-0000-0000-0000-000000000001', 'tg-own',   'Reseller own'),
 ('d2000000-0000-0000-0000-000000000006', 'c2000000-0000-0000-0000-000000000004', 'tg-two',   'Two');

-- ---------------------------------------------------------------
-- 1. Who can set a group
-- ---------------------------------------------------------------
set test.uid = 'b2000000-0000-0000-0000-000000000001';
do $$
begin
  perform set_reseller_telegram('b2000000-0000-0000-0000-000000000001', ' -1001111111111 ', true);
  begin perform set_reseller_telegram('b2000000-0000-0000-0000-000000000002', '-1002', true); raise exception 'reseller set another reseller';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform set_reseller_telegram('b2000000-0000-0000-0000-000000000001', 'https://t.me/joinchat/x', true); raise exception 'bad chat id saved';
  exception when others then if sqlerrm not like 'Enter the group chat ID%' then raise; end if; end;
  if (select telegram_chat_id from reseller_alert_channels where reseller_id = 'b2000000-0000-0000-0000-000000000001') <> '-1001111111111' then
    raise exception 'own group not saved trimmed';
  end if;
  raise notice 'PASS reseller sets own group (trimmed), not another reseller''s; a link is refused with a plain message';
end $$;

set test.uid = 'c2000000-0000-0000-0000-000000000001';
do $$
begin
  begin perform set_reseller_telegram('b2000000-0000-0000-0000-000000000001', '-1003', true); raise exception 'freelancer set a group';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform set_reseller_telegram('c2000000-0000-0000-0000-000000000001', '-1003', true); raise exception 'freelancer set own group';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  raise notice 'PASS freelancer cannot set any group';
end $$;

set test.uid = 'a2000000-0000-0000-0000-000000000001';
do $$
begin
  perform set_reseller_telegram('b2000000-0000-0000-0000-000000000002', '@res_two_group', true);
  perform set_reseller_telegram('b2000000-0000-0000-0000-000000000004', '-1004444444444', true);
  perform set_reseller_telegram('b2000000-0000-0000-0000-000000000003', '-1003333333333', true);
  perform set_reseller_telegram('b2000000-0000-0000-0000-000000000003', '', true);
  begin perform set_reseller_telegram('c2000000-0000-0000-0000-000000000001', '-1005', true); raise exception 'admin set a group on a freelancer';
  exception when others then if sqlerrm <> 'Reseller not found' then raise; end if; end;
  if (select telegram_chat_id from reseller_alert_channels where reseller_id = 'b2000000-0000-0000-0000-000000000003') is not null then
    raise exception 'empty chat id did not clear';
  end if;
  if (select count(*) from audit_log where action = 'reseller.telegram_updated') < 5 then raise exception 'not audited'; end if;
  raise notice 'PASS admin sets and clears any reseller''s group, audited; not on a freelancer';
end $$;
set test.uid = '';

-- ---------------------------------------------------------------
-- 2. One message per settled payment and recipient
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
  perform pg_temp.pay(5, 'd2000000-0000-0000-0000-000000000005', 40,  v_t - interval '5 hours');             -- Y, reseller's own
  perform pg_temp.pay(6, 'd2000000-0000-0000-0000-000000000003', 70,  v_t - interval '2 hours');             -- Y, no reseller
  perform pg_temp.pay(7, 'd2000000-0000-0000-0000-000000000006', 25,  v_t - interval '1 hour');              -- Y, reseller two
  perform pg_temp.pay(8, 'd2000000-0000-0000-0000-000000000001', 10.01, v_t - interval '24 hours 1 minute'); -- Y-1, 16:59
  perform pg_temp.pay(9, 'd2000000-0000-0000-0000-000000000004', 5,   v_t - interval '4 hours');             -- Y, hidden (under 10)
  perform pg_temp.pay(10, 'd2000000-0000-0000-0000-000000000001', 33.33, v_t - interval '6 hours');          -- Y
end $$;

do $$
declare v_expect text; v_got text; p jsonb;
begin
  select string_agg(right(ref, 2) || ':' || case recipient when 'admin' then 'admin' else right(recipient, 1) end, ' ' order by ref, recipient)
    into v_got from telegram_outbox where kind = 'payment_settled';
  v_expect := '01:admin 01:1 02:admin 02:1 03:admin 03:1 04:admin 04:1 05:admin 05:1 06:admin 07:admin 07:2 08:admin 08:1 10:admin 10:1';
  if v_got <> v_expect then raise exception 'payment_settled rows: % (expected %)', v_got, v_expect; end if;
  if exists (select 1 from telegram_outbox where recipient = 'b2000000-0000-0000-0000-000000000001' and chat <> '-1001111111111')
     or exists (select 1 from telegram_outbox where recipient = 'b2000000-0000-0000-0000-000000000002' and chat <> '@res_two_group')
     or exists (select 1 from telegram_outbox where recipient = 'admin' and chat <> 'admin') then
    raise exception 'wrong chat on a row';
  end if;

  select payload into p from telegram_outbox where ref like '%000000000001' and recipient like 'b2%';
  if p->>'link_name' <> 'Logo <design>' or (p->>'amount_usd')::numeric <> 100 or (p->>'amount_sat')::bigint <> 100000
     or (p->>'fee_usd')::numeric <> 3 or (p->>'net_usd')::numeric <> 97 or p->>'owner_name' <> 'Karim'
     or (p->>'show_owner')::boolean is not true or p->>'reseller_name' <> 'Rahim <Team> & Co' then
    raise exception 'payload for payment 1: %', p;
  end if;
  select payload into p from telegram_outbox where ref like '%000000000005' and recipient like 'b2%';
  if (p->>'show_owner')::boolean is not false then raise exception 'own link shows the owner: %', p; end if;
  select payload into p from telegram_outbox where ref like '%000000000003' and recipient like 'b2%';
  if p->>'link_name' <> 'tg-promo' then raise exception 'unnamed link falls back to the slug: %', p; end if;
  raise notice 'PASS 17 rows: team payments to reseller one and admin, solo to admin only, reseller two''s own, hidden $5 to nobody; payload amounts, fee 3%%, net, names';
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
-- 3. Daily close for business day Y
-- ---------------------------------------------------------------
do $$
declare
  v_y date := (select y from t_clock);
  p jsonb; l jsonb; v_pct numeric := 0; v_gross numeric := 0; v_fee numeric := 0; v_net numeric := 0; v_n int := 0;
begin
  if enqueue_daily_close(v_y) <> 3 then raise exception 'expected 3 daily rows (reseller one, two, quiet)'; end if;
  if enqueue_daily_close(v_y) <> 0 then raise exception 'a re-run queued more'; end if;
  if enqueue_daily_close(null) <> 0 then raise exception 'the default day is not Y'; end if;
  if exists (select 1 from telegram_outbox where kind = 'daily_close' and recipient = 'b2000000-0000-0000-0000-000000000003') then
    raise exception 'reseller with no group got a row';
  end if;

  select payload into p from telegram_outbox where kind = 'daily_close' and recipient = 'b2000000-0000-0000-0000-000000000001';
  if p->>'business_day' <> v_y::text then raise exception 'business day %', p->>'business_day'; end if;
  -- Y: 100 + 33.33 (Logo), 20 (promo), 30 (assigned), 40 (own). Not the 17:01
  -- payment, not Y-1's 16:59, not the hidden $5.
  if (p->'totals'->>'payments')::int <> 5 or (p->'totals'->>'gross_usd')::numeric <> 223.33 then
    raise exception 'reseller one totals: %', p->'totals';
  end if;
  for l in select * from jsonb_array_elements(p->'links') loop
    if (l->>'fee_usd')::numeric + (l->>'net_usd')::numeric <> (l->>'gross_usd')::numeric then raise exception 'fee + net <> gross: %', l; end if;
    v_pct := v_pct + round((l->>'gross_usd')::numeric / (p->'totals'->>'gross_usd')::numeric * 100, 1);
    v_gross := v_gross + (l->>'gross_usd')::numeric; v_fee := v_fee + (l->>'fee_usd')::numeric;
    v_net := v_net + (l->>'net_usd')::numeric; v_n := v_n + (l->>'payments')::int;
  end loop;
  if v_gross <> (p->'totals'->>'gross_usd')::numeric or v_fee <> (p->'totals'->>'fee_usd')::numeric
     or v_net <> (p->'totals'->>'net_usd')::numeric or v_n <> 5 then
    raise exception 'links do not add up to the totals: %', p;
  end if;
  if abs(v_pct - 100) > 0.2 then raise exception 'shares add to %', v_pct; end if;
  if (p->'totals'->>'fee_usd')::numeric + (p->'totals'->>'net_usd')::numeric <> (p->'totals'->>'gross_usd')::numeric then
    raise exception 'total fee + net <> gross';
  end if;
  if (p->'links'->0->>'link_name') <> 'Logo <design>' or (p->'links'->0->>'payments')::int <> 2
     or (p->'links'->0->>'gross_usd')::numeric <> 133.33 then
    raise exception 'first link (largest): %', p->'links'->0;
  end if;

  select payload into p from telegram_outbox where kind = 'daily_close' and recipient = 'b2000000-0000-0000-0000-000000000002';
  if (p->'totals'->>'payments')::int <> 1 or (p->'totals'->>'gross_usd')::numeric <> 25 then raise exception 'reseller two: %', p; end if;
  select payload into p from telegram_outbox where kind = 'daily_close' and recipient = 'b2000000-0000-0000-0000-000000000004';
  if (p->'totals'->>'payments')::int <> 0 or jsonb_array_length(p->'links') <> 0 or (p->'totals'->>'gross_usd')::numeric <> 0 then
    raise exception 'quiet reseller: %', p;
  end if;
  raise notice 'PASS daily close Y: 3 resellers once each; reseller one 5 payments $223.33 across the 17:00 edges; links add to totals; shares % ; fee + net = gross', v_pct;
end $$;

-- ---------------------------------------------------------------
-- 4. Sender rules
-- ---------------------------------------------------------------
do $$
declare
  v_claimed int; v_id bigint; v_id2 bigint; v_r text;
begin
  select count(*) into v_claimed from telegram_claim(100);
  if v_claimed <> 20 then raise exception 'claimed % rows, expected 20', v_claimed; end if;
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
     or has_function_privilege('authenticated', 'enqueue_daily_close(date)', 'execute')
     or has_function_privilege('anon', 'set_reseller_telegram(uuid,text,boolean)', 'execute')
     or has_table_privilege('authenticated', 'telegram_outbox', 'select')
     or has_table_privilege('anon', 'telegram_outbox', 'select') then
    raise exception 'browser roles can reach the outbox';
  end if;
  if exists (select 1 from pg_proc where proname in ('telegram_find_payments', 'reseller_cycle_digest', 'list_reseller_alert_targets', 'admin_set_reseller_alerts', 'should_suppress_payment_alert')) then
    raise exception 'an old function is still there';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'reseller_alert_channels' and column_name in ('telegram_bot_token', 'discord_webhook')) then
    raise exception 'old columns still there';
  end if;
  raise notice 'PASS browser roles cannot reach the outbox or the sender functions; old functions and columns gone';
end $$;

rollback;
