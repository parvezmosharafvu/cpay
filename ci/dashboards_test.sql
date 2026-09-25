-- Dashboard data layer (0096) against a freshly migrated database.
-- Runs inside BEGIN/ROLLBACK and leaves nothing behind. Any failed
-- check raises and stops psql (ON_ERROR_STOP). Numbers are printed as
-- NOTICEs so the log shows what was checked.
\set ON_ERROR_STOP 1
begin;

-- auth.uid() in ci/bootstrap.sql always returns null; read it from a GUC
-- so each block can act as a different user. Rolled back at the end.
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

insert into auth.users (id, email, raw_user_meta_data) values
 ('a1000000-0000-0000-0000-000000000001', 'boss@cpay.test', '{}'),
 ('b1000000-0000-0000-0000-000000000001', 'res.one@cpay.test', '{}'),
 ('b1000000-0000-0000-0000-000000000002', 'res.two@cpay.test', '{}'),
 ('c1000000-0000-0000-0000-000000000001', 'aff.freelancer@gmail.test', '{}'),
 ('c1000000-0000-0000-0000-000000000002', 'assigned.freelancer@gmail.test', '{}'),
 ('c1000000-0000-0000-0000-000000000003', 'solo.freelancer@gmail.test', '{}');
update profiles set account_status = 'active'
 where id in (select id from auth.users where email like '%.test');
update profiles set role = 'admin' where id = 'a1000000-0000-0000-0000-000000000001';
update profiles set role = 'moderator' where id in ('b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002');
update profiles set referred_by = 'b1000000-0000-0000-0000-000000000001' where id = 'c1000000-0000-0000-0000-000000000001';
insert into moderator_assignments (moderator_id, creator_id)
values ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002');
update profiles set cost_percent = 2 where id = 'c1000000-0000-0000-0000-000000000001';

-- Links: aff has L1 (5%) and L2 (no own rate, profile 2%). assigned has
-- L4 (1%). solo has L3 (10%).
insert into payment_links (id, user_id, slug, display_name, cost_percent) values
 ('d1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'aff-main',  'Aff main', 5),
 ('d1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'aff-promo', 'Aff promo', null),
 ('d1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'solo-main', 'Solo', 10),
 ('d1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000002', 'asg-main',  'Assigned', 1);
update payment_links set created_at = now() - interval '5 days';

-- Pays and settles like production: insert 'new', update to 'settled'
-- (the settle trigger stamps fees). p_at is the settle time.
create function pg_temp.pay(p_id int, p_link uuid, p_amount numeric, p_at timestamptz) returns void
language plpgsql as $$
begin
  insert into payments (id, user_id, payment_link_id, amount_requested, status, expires_at)
  select ('e1000000-0000-0000-0000-' || lpad(p_id::text, 12, '0'))::uuid, pl.user_id, pl.id, p_amount, 'new', now() + interval '1 hour'
  from payment_links pl where pl.id = p_link;
  update payments set status = 'settled', amount_settled = p_amount, settled_at = p_at
  where id = ('e1000000-0000-0000-0000-' || lpad(p_id::text, 12, '0'))::uuid;
end $$;

-- Yesterday's business day Y closes at T = today's 17:00 boundary.
create temp table t_clock as
select current_business_day() - 1 as y, business_day_start(current_business_day()) as t;

do $$
declare v_t timestamptz := (select t from t_clock);
begin
  perform pg_temp.pay(1, 'd1000000-0000-0000-0000-000000000001', 100, v_t - interval '1 minute'); -- 16:59 Dhaka
  update payment_links set cost_percent = 8 where id = 'd1000000-0000-0000-0000-000000000001';
  perform pg_temp.pay(2, 'd1000000-0000-0000-0000-000000000001', 50,  v_t + interval '1 minute'); -- 17:01 Dhaka
  perform pg_temp.pay(3, 'd1000000-0000-0000-0000-000000000002', 20,  v_t - interval '3 hours');
  perform pg_temp.pay(4, 'd1000000-0000-0000-0000-000000000004', 30,  v_t + interval '2 minutes');
  perform pg_temp.pay(5, 'd1000000-0000-0000-0000-000000000003', 70,  v_t + interval '3 minutes');
end $$;

-- ---------------------------------------------------------------
-- 1. The 17:00 Dhaka boundary
-- ---------------------------------------------------------------
do $$
declare
  v_y date := (select y from t_clock);
  v_t timestamptz := (select t from t_clock);
begin
  if to_char(v_t at time zone 'Asia/Dhaka', 'HH24:MI') <> '17:00' then
    raise exception 'boundary is not 17:00 Dhaka: %', v_t at time zone 'Asia/Dhaka';
  end if;
  if business_day(v_t - interval '1 minute') <> v_y then raise exception '16:59 not in day %', v_y; end if;
  if business_day(v_t + interval '1 minute') <> v_y + 1 then raise exception '17:01 not in day %', v_y + 1; end if;
  if business_day('2026-09-25 16:59+06') <> '2026-09-24' or business_day('2026-09-25 17:01+06') <> '2026-09-25'
     or business_day('2026-09-25 10:59:59Z') <> '2026-09-24' or business_day('2026-09-25 11:00:00Z') <> '2026-09-25' then
    raise exception 'fixed-date boundary check failed';
  end if;
  if business_day_end('2026-09-24') - business_day_start('2026-09-24') <> interval '24 hours' then
    raise exception 'day is not 24h';
  end if;
  raise notice 'PASS boundary: 16:59 Dhaka -> %, 17:01 Dhaka -> %, day % runs % to % (Dhaka)',
    business_day(v_t - interval '1 minute'), business_day(v_t + interval '1 minute'),
    v_y, business_day_start(v_y) at time zone 'Asia/Dhaka', business_day_end(v_y) at time zone 'Asia/Dhaka';
end $$;

-- ---------------------------------------------------------------
-- 2. Freelancer sees only self, with the payments split by day
-- ---------------------------------------------------------------
set test.uid = 'c1000000-0000-0000-0000-000000000001';
do $$
declare
  v_y date := (select y from t_clock);
  r_y record; r_t record; v_links int;
begin
  select * into r_y from my_daily_summary(3) where business_day = v_y;
  select * into r_t from my_daily_summary(3) where business_day = v_y + 1;
  -- Y: 100 (L1 at 5%) + 20 (L2 at profile 2%). Fee 3%, commission 8% of net.
  if r_y.payment_count <> 2 or r_y.settled <> 120 or r_y.platform_fee <> 3.60
     or r_y.reseller_commission <> 9.31 or r_y.earnings <> 107.09
     or r_y.cost_rates <> array[2.000, 5.000]::numeric[] or r_y.link_count <> 2 or r_y.paid_link_count <> 2 then
    raise exception 'day Y wrong: %', row_to_json(r_y);
  end if;
  -- today: 50 on L1 after the rate moved to 8%.
  if r_t.payment_count <> 1 or r_t.settled <> 50 or r_t.cost_rates <> array[8.000]::numeric[]
     or r_t.earnings <> 50 - 1.50 - 3.88 then
    raise exception 'day Y+1 wrong: %', row_to_json(r_t);
  end if;
  raise notice 'PASS freelancer day %: % payments, settled %, fee %, commission %, earnings %, rates %',
    v_y, r_y.payment_count, r_y.settled, r_y.platform_fee, r_y.reseller_commission, r_y.earnings, r_y.cost_rates;
  raise notice 'PASS freelancer day %: % payment, settled %, earnings %, rates %',
    v_y + 1, r_t.payment_count, r_t.settled, r_t.earnings, r_t.cost_rates;

  -- per link: L1 was 5% for the 16:59 payment and 8% for the 17:01 one.
  if (select cost_percent_used_max from daily_link_breakdown(3) where slug = 'aff-main' and business_day = v_y) <> 5
     or (select cost_percent_used_max from daily_link_breakdown(3) where slug = 'aff-main' and business_day = v_y + 1) <> 8
     or (select cost_percent_now from daily_link_breakdown(3) where slug = 'aff-main' and business_day = v_y) <> 8
     or (select cost_percent_used_max from daily_link_breakdown(3) where slug = 'aff-promo' and business_day = v_y) <> 2 then
    raise exception 'per-link cost rate wrong';
  end if;
  if exists (select 1 from daily_link_breakdown(3) where user_id <> auth.uid()) then
    raise exception 'breakdown leaked another user';
  end if;
  raise notice 'PASS per-link: aff-main used 5%% on %, 8%% on %, now 8%%; aff-promo 2%% (profile fallback)', v_y, v_y + 1;

  -- my_earnings_split used to fail with "cost_percent is ambiguous".
  perform * from my_earnings_split();
  if (select cost_percent from my_earnings_split()) <> 2 or (select commission_percent from my_earnings_split()) <> 8 then
    raise exception 'my_earnings_split wrong: %', (select row_to_json(x) from my_earnings_split() x);
  end if;
  raise notice 'PASS my_earnings_split: %', (select row_to_json(x) from my_earnings_split() x);
end $$;

do $$
begin
  begin perform * from daily_link_breakdown(3, 'c1000000-0000-0000-0000-000000000003');
        raise exception 'freelancer read another freelancer';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform * from reseller_team_daily_summary(3); raise exception 'freelancer read a team';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform * from admin_daily_summary(3); raise exception 'freelancer read admin summary';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform * from admin_daily_timeseries(3); raise exception 'freelancer read admin series';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform * from reseller_cycle_digest('b1000000-0000-0000-0000-000000000001'); raise exception 'freelancer read a digest';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  raise notice 'PASS freelancer denied: other breakdown, team, admin summary, admin series, reseller digest';
end $$;

-- ---------------------------------------------------------------
-- 3. Reseller sees self + team (affiliate and assigned), not others
-- ---------------------------------------------------------------
set test.uid = 'b1000000-0000-0000-0000-000000000001';
do $$
declare v_y date := (select y from t_clock); v_emails text;
begin
  select string_agg(distinct email, ',' order by email) into v_emails from reseller_team_daily_summary(3);
  if v_emails <> 'aff.freelancer@gmail.test,assigned.freelancer@gmail.test,res.one@cpay.test' then
    raise exception 'team is %', v_emails;
  end if;
  if (select sum(settled) from reseller_team_daily_summary(3)) <> 200
     or (select sum(reseller_commission) from reseller_team_daily_summary(3) where affiliate) <> 13.19
     or (select sum(reseller_commission) from reseller_team_daily_summary(3) where email like 'assigned%') <> 0
     or (select count(*) from reseller_team_daily_summary(3) where is_self) <> 3 then
    raise exception 'team numbers wrong';
  end if;
  perform * from daily_link_breakdown(3, 'c1000000-0000-0000-0000-000000000002');
  begin perform * from daily_link_breakdown(3, 'c1000000-0000-0000-0000-000000000003');
        raise exception 'reseller read outsider links';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  begin perform * from reseller_cycle_digest('b1000000-0000-0000-0000-000000000002'); raise exception 'reseller read other digest';
  exception when others then if sqlerrm <> 'Not authorized' then raise; end if; end;
  perform * from reseller_cycle_digest('b1000000-0000-0000-0000-000000000001');
  raise notice 'PASS reseller team = %; settled 200 over 3 days; affiliate commission 13.19; assigned 0; outsider and other reseller denied', v_emails;
end $$;

-- ---------------------------------------------------------------
-- 4. Admin sees everyone with profile and email
-- ---------------------------------------------------------------
set test.uid = 'a1000000-0000-0000-0000-000000000001';
do $$
declare v_y date := (select y from t_clock); v_n int; r record;
begin
  select count(distinct user_id) into v_n from admin_daily_summary(3) where user_id::text like 'c1000000-%';
  if v_n <> 3 then raise exception 'admin sees % people with activity, want 3', v_n; end if;
  if exists (select 1 from admin_daily_summary(3) where email is null) then raise exception 'row without email'; end if;
  select * into r from admin_daily_summary(3) where email = 'aff.freelancer@gmail.test' and business_day = v_y;
  if r.reseller_email <> 'res.one@cpay.test' or r.settled <> 120 or r.max_payment_links <> 10 or r.account_status <> 'active' then
    raise exception 'admin row wrong: %', row_to_json(r);
  end if;
  if (select reseller_email from admin_daily_summary(3) where email like 'assigned%' limit 1) <> 'res.one@cpay.test' then
    raise exception 'assigned freelancer reseller missing';
  end if;
  -- unfiltered = every settled payment in the window (other rows may exist
  -- when this runs on a seeded DB), and the three test people add to 270
  if (select sum(settled) from admin_daily_timeseries(3))
       <> (select sum(amount_settled) from payments
           where status = 'settled' and settled_at >= business_day_start(current_business_day() - 2))
     or (select sum(t.settled) from unnest(array['c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002',
                                                 'c1000000-0000-0000-0000-000000000003']::uuid[]) u,
                                    lateral admin_daily_timeseries(3, u) t) <> 270
     or (select sum(settled) from admin_daily_timeseries(3, null, 'b1000000-0000-0000-0000-000000000001')) <> 200
     or (select sum(settled) from admin_daily_timeseries(3, 'c1000000-0000-0000-0000-000000000003')) <> 70
     or (select settled from admin_daily_timeseries(3, null, 'b1000000-0000-0000-0000-000000000001') where business_day = v_y) <> 120
     or (select settled from admin_daily_timeseries(3, null, 'b1000000-0000-0000-0000-000000000001') where business_day = v_y + 1) <> 80
     or (select count(*) from admin_daily_timeseries(45)) <> 45 then
    raise exception 'timeseries wrong';
  end if;
  -- the series, the summary and the ledger agree
  if (select sum(settled) from admin_daily_timeseries(3)) <> (select sum(settled) from admin_daily_summary(3))
     or (select sum(earnings) from admin_daily_timeseries(3)) <> (select sum(earnings) from admin_daily_summary(3))
     or (select sum(settled) from admin_daily_summary(3, 'c1000000-0000-0000-0000-000000000001'))
        <> (select sum(settled) from daily_link_breakdown(3, 'c1000000-0000-0000-0000-000000000001')) then
    raise exception 'series / summary / breakdown disagree';
  end if;
  raise notice 'PASS admin: 3 active people all with email; aff row reseller=% settled=% limit=%; series = ledger; test people total 270; res.one filter 200 (Y 120, Y+1 80); solo filter 70',
    r.reseller_email, r.settled, r.max_payment_links;
end $$;

-- ---------------------------------------------------------------
-- 5. At most 10 active links, soft-delete and deactivate free a slot
-- ---------------------------------------------------------------
reset test.uid;
update profiles set max_payment_links = 50 where id = 'c1000000-0000-0000-0000-000000000003';
set test.uid = 'c1000000-0000-0000-0000-000000000003';
do $$
declare v_msg text;
begin
  insert into payment_links (user_id, slug, display_name)
  select 'c1000000-0000-0000-0000-000000000003', 'solo-extra-' || g, 'Extra ' || g from generate_series(2, 10) g;
  if (select count(*) from payment_links where user_id = auth.uid() and is_active and deleted_at is null) <> 10 then
    raise exception 'setup: want 10 active links';
  end if;
  begin
    insert into payment_links (user_id, slug, display_name) values (auth.uid(), 'solo-extra-11', 'Eleven');
    raise exception '11th link was accepted';
  exception when others then v_msg := sqlerrm;
    if v_msg <> 'Limit reached: you can have at most 10 active links' then raise; end if;
  end;
  -- deactivating one frees a slot; reactivating it while full is refused
  update payment_links set is_active = false where slug = 'solo-extra-10';
  insert into payment_links (user_id, slug, display_name) values (auth.uid(), 'solo-extra-11', 'Eleven');
  begin
    update payment_links set is_active = true where slug = 'solo-extra-10';
    raise exception 'reactivation over the limit was accepted';
  exception when others then if sqlerrm not like 'Limit reached%' then raise; end if; end;
  raise notice 'PASS link limit: 11th insert refused with "%"; deactivate frees a slot; reactivation over limit refused', v_msg;
end $$;

-- soft-deleted links do not count; admin acting for the owner is capped too
reset test.uid;
update payment_links set deleted_at = now(), is_active = false, slug = 'solo-extra-9--deleted-x' where slug = 'solo-extra-9';
set test.uid = 'a1000000-0000-0000-0000-000000000001';
do $$
begin
  insert into payment_links (user_id, slug, display_name) values ('c1000000-0000-0000-0000-000000000003', 'solo-admin-made', 'By admin');
  begin
    insert into payment_links (user_id, slug, display_name) values ('c1000000-0000-0000-0000-000000000003', 'solo-admin-11', 'By admin 11');
    raise exception 'admin created an 11th link';
  exception when others then if sqlerrm not like 'Limit reached%' then raise; end if; end;
  begin
    perform admin_set_link_limit('c1000000-0000-0000-0000-000000000003', 11);
    raise exception 'admin set a limit above 10';
  exception when others then if sqlerrm <> 'Limit must be between 0 and 10' then raise; end if; end;
  -- the per-person limit still applies below the ceiling
  perform admin_set_link_limit('c1000000-0000-0000-0000-000000000001', 2);
  raise notice 'PASS link limit: soft-deleted link freed a slot; admin capped at 10 for the owner; admin_set_link_limit(11) refused';
end $$;
set test.uid = 'c1000000-0000-0000-0000-000000000001';
do $$
begin
  insert into payment_links (user_id, slug, display_name) values (auth.uid(), 'aff-third', 'Third');
  raise exception 'per-person limit of 2 ignored';
exception when others then if sqlerrm <> 'Limit reached: you can have at most 2 active links' then raise; end if;
  raise notice 'PASS link limit: per-person limit 2 still enforced under the ceiling';
end $$;

-- ---------------------------------------------------------------
-- 7. Daily withdrawal limit counts from 17:00 Dhaka (0097)
-- ---------------------------------------------------------------
-- Holds whatever the time of day: under a midnight reset one of the two
-- checks below fails (before 17:00 the 17:01 row is "yesterday"; after
-- 17:00 the 16:59 row is "today").
reset test.uid;
-- enough balance that only the limit can refuse the second request
do $$ begin perform pg_temp.pay(6, 'd1000000-0000-0000-0000-000000000003', 500, (select t from t_clock) - interval '10 days'); end $$;
insert into profile_limits (user_id, daily_withdrawal_limit)
values ('c1000000-0000-0000-0000-000000000003', 40)
on conflict (user_id) do update set daily_withdrawal_limit = 40;
insert into withdrawals (user_id, amount_requested, fee_percent, amount_after_fee, method, destination, status, requested_at)
values ('c1000000-0000-0000-0000-000000000003', 30, 3, 29.1, 'bkash', '01700000000', 'rejected', (select t from t_clock) - interval '1 minute');
-- rejected rows never count; this one only exists to become a paid 16:59 row
update withdrawals set status = 'paid' where user_id = 'c1000000-0000-0000-0000-000000000003';
set test.uid = 'c1000000-0000-0000-0000-000000000003';
do $$
declare v_id uuid; v_msg text;
begin
  select id into v_id from request_withdrawal(35, 'bkash', '01700000000');
  update withdrawals set requested_at = (select t from t_clock) + interval '1 minute' where id = v_id;
  begin
    perform request_withdrawal(10, 'bkash', '01700000000');
    raise exception '17:01 withdrawal did not count toward the daily limit';
  exception when others then v_msg := sqlerrm;
    if v_msg not like 'This request exceeds your daily withdrawal limit%' then raise; end if;
  end;
  raise notice 'PASS withdraw limit 40: $30 paid at 16:59 did not count ($35 accepted); $35 at 17:01 did ($10 refused with "%")', v_msg;
end $$;

-- ---------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------
reset test.uid;
do $$
begin
  if has_function_privilege('authenticated', 'daily_totals_for_cycle(date)', 'execute')
     or has_function_privilege('authenticated', 'dashboard_user_days(uuid[],date,date,boolean)', 'execute')
     or has_function_privilege('authenticated', 'dashboard_settled_payments(uuid[],date,date,boolean)', 'execute')
     or has_function_privilege('anon', 'admin_daily_timeseries(integer,uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'my_daily_summary(integer)', 'execute')
     or not has_function_privilege('authenticated', 'admin_daily_timeseries(integer,uuid,uuid)', 'execute')
     or not has_function_privilege('authenticated', 'reseller_team_daily_summary(integer)', 'execute')
     or not has_function_privilege('authenticated', 'daily_link_breakdown(integer,uuid)', 'execute') then
    raise exception 'grants wrong';
  end if;
  raise notice 'PASS grants: internals and daily_totals_for_cycle closed to authenticated; RPCs closed to anon';
end $$;

rollback;
