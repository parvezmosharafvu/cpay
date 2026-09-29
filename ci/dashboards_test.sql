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
  perform pg_temp.pay(1, 'd1000000-0000-0000-0000-000000000001', 100, v_t - interval '1 minute');
  update payment_links set cost_percent = 8 where id = 'd1000000-0000-0000-0000-000000000001';
  perform pg_temp.pay(2, 'd1000000-0000-0000-0000-000000000001', 50,  v_t + interval '1 minute');
  perform pg_temp.pay(3, 'd1000000-0000-0000-0000-000000000002', 20,  v_t - interval '3 hours');
  perform pg_temp.pay(4, 'd1000000-0000-0000-0000-000000000004', 30,  v_t + interval '2 minutes');
  perform pg_temp.pay(5, 'd1000000-0000-0000-0000-000000000003', 70,  v_t + interval '3 minutes');
end $$;
