-- ============================================================
-- 0106: Telegram messages for resellers, replacing the old digest
-- ============================================================
-- Two messages go to each reseller's Telegram group, from one cpay bot
-- (edge secret ALERT_TELEGRAM_BOT_TOKEN, the name the ops alerts already
-- use):
--
--   * payment_settled: one message per settled payment, to the group of
--     every reseller whose team owns the link (and to the admin group,
--     ALERT_TELEGRAM_CHAT_ID, when that secret is set).
--   * daily_close: at 17:00 Asia/Dhaka, one message per reseller for the
--     business day that just closed (17:00 to 17:00), per link and in
--     total.
--
-- Both are rows in telegram_outbox, written by the database: a trigger on
-- the payment's move to 'settled' (every path: the payment service's
-- settle_breez_payment and an admin's manual settle), and
-- enqueue_daily_close() from pg_cron. The unique key (kind, ref,
-- recipient) makes each message exist once, however often a payment is
-- re-settled or the daily job re-runs. The telegram-notify edge function
-- sends pending rows and records the result; a row is never sent twice
-- (see telegram_claim).
--
-- The numbers are the dashboards' numbers: dashboard_settled_payments()
-- with each owner's hide-small threshold (0096). Fee is the platform fee;
-- net is settled minus that fee, so fee + net = gross exactly. A
-- reseller's commission is part of net.
--
-- Where the group lives: reseller_alert_channels.telegram_chat_id (0091),
-- now set by the reseller in their desk or by an admin, through
-- set_reseller_telegram(). The per-reseller bot token and Discord webhook
-- columns go: one cpay bot sends everything, and live had no rows.
--
-- Also removed: telegram_find_payments (live only, broken since 0093
-- renamed btcpay_invoice_id), the reseller-digest function's SQL
-- (reseller_cycle_digest, list_reseller_alert_targets,
-- admin_set_reseller_alerts) and should_suppress_payment_alert, whose only
-- caller was the manual-settle alert this replaces.
--
-- Safe to re-run.
-- ============================================================

-- ---------- 1. Leftovers ----------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'telegram_find_payments'
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;

drop function if exists reseller_cycle_digest(uuid, date);
drop function if exists list_reseller_alert_targets();
drop function if exists admin_set_reseller_alerts(uuid, text, text, text, boolean);
drop function if exists should_suppress_payment_alert(numeric);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job
    where jobname in ('reseller-digest-trigger', 'cpay-reseller-digest');
  end if;
end $$;

-- ---------- 2. Where each reseller's group is ----------
alter table reseller_alert_channels drop column if exists discord_webhook;
alter table reseller_alert_channels drop column if exists telegram_bot_token;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'reseller_alert_channels_chat_id_shape') then
    alter table reseller_alert_channels add constraint reseller_alert_channels_chat_id_shape
      check (telegram_chat_id is null or telegram_chat_id ~ '^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$');
  end if;
end $$;

comment on table reseller_alert_channels is
  'Telegram group per reseller for settled-payment messages and the 17:00 daily close. Set through set_reseller_telegram().';
comment on column reseller_alert_channels.telegram_chat_id is
  'Group chat id (e.g. -1001234567890) or @channelname. The cpay bot must be a member.';

-- The reseller for themselves, or an admin for any reseller. An empty
-- chat id clears it.
create or replace function set_reseller_telegram(p_reseller_id uuid, p_chat_id text, p_enabled boolean default true)
returns table (reseller_id uuid, telegram_chat_id text, enabled boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chat text := nullif(trim(coalesce(p_chat_id, '')), '');
begin
  if auth.uid() is null or not (is_admin() or (auth.uid() = p_reseller_id and is_reseller())) then
    raise exception 'Not authorized';
  end if;
  if not exists (select 1 from profiles where id = p_reseller_id and role = 'moderator') then
    raise exception 'Reseller not found';
  end if;
  if v_chat is not null and v_chat !~ '^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$' then
    raise exception 'Enter the group chat ID, a number like -1001234567890, or a channel name like @mychannel';
  end if;
  insert into reseller_alert_channels as c (reseller_id, telegram_chat_id, enabled, updated_by, updated_at)
  values (p_reseller_id, v_chat, coalesce(p_enabled, true), auth.uid(), now())
  on conflict on constraint reseller_alert_channels_pkey do update set
    telegram_chat_id = excluded.telegram_chat_id,
    enabled = excluded.enabled,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
  perform record_audit('reseller.telegram_updated', 'profile', p_reseller_id::text, null,
    jsonb_build_object('chat_set', v_chat is not null, 'enabled', coalesce(p_enabled, true)));
  return query select c.reseller_id, c.telegram_chat_id, c.enabled from reseller_alert_channels c where c.reseller_id = p_reseller_id;
end;
$$;
revoke all on function set_reseller_telegram(uuid, text, boolean) from public, anon;
grant execute on function set_reseller_telegram(uuid, text, boolean) to authenticated;

-- ---------- 3. The outbox ----------
create table if not exists telegram_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('payment_settled', 'daily_close')),
  -- payment_settled: the payment id. daily_close: the business day.
  ref text not null,
  -- A reseller's profile id, or 'admin'.
  recipient text not null,
  -- The group chat id when the row was written, or 'admin', which the
  -- sender reads from ALERT_TELEGRAM_CHAT_ID.
  chat text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now(),
  constraint telegram_outbox_once unique (kind, ref, recipient)
);
create index if not exists telegram_outbox_due on telegram_outbox (next_attempt_at) where status = 'pending';
alter table telegram_outbox enable row level security;
revoke all on telegram_outbox from public, anon, authenticated;

-- Resellers whose group gets a message about a payment owned by p_user_id:
-- the owner when they are a reseller, the reseller who referred them, and
-- any reseller they are assigned to (the two routes reseller_team_ids()
-- uses). Only active resellers with a group set and switched on.
create or replace function telegram_resellers_for(p_user_id uuid)
returns table (reseller_id uuid, chat text, reseller_name text)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select p_user_id as id
    union select referred_by from profiles where id = p_user_id and referred_by is not null
    union select moderator_id from moderator_assignments where creator_id = p_user_id
  )
  select r.id, c.telegram_chat_id, coalesce(nullif(r.display_name, ''), r.email)
  from candidates k
  join profiles r on r.id = k.id and r.role = 'moderator' and r.account_status = 'active'
  join reseller_alert_channels c on c.reseller_id = r.id and c.enabled and c.telegram_chat_id is not null;
$$;
revoke all on function telegram_resellers_for(uuid) from public, anon, authenticated;

-- ---------- 4. payment_settled ----------
create or replace function enqueue_payment_settled_telegram()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link payment_links;
  v_owner profiles;
  v_payload jsonb;
begin
  -- A message must never stop a payment from settling.
  begin
    if coalesce(new.amount_settled, 0) < hide_threshold_for(new.user_id) then
      return null;
    end if;
    select * into v_link from payment_links where id = new.payment_link_id;
    select * into v_owner from profiles where id = new.user_id;
    v_payload := jsonb_build_object(
      'payment_id', new.id,
      'link_name', coalesce(nullif(v_link.display_name, ''), v_link.slug),
      'link_slug', v_link.slug,
      'owner_id', new.user_id,
      'owner_name', coalesce(nullif(v_owner.display_name, ''), v_owner.email),
      'amount_usd', coalesce(new.amount_settled, 0),
      'amount_sat', new.amount_sat,
      'fee_usd', coalesce(new.platform_fee_amount, 0),
      'net_usd', coalesce(new.amount_settled, 0) - coalesce(new.platform_fee_amount, 0),
      'settled_at', new.settled_at
    );
    insert into telegram_outbox (kind, ref, recipient, chat, payload)
    select 'payment_settled', new.id::text, r.reseller_id::text, r.chat,
           v_payload || jsonb_build_object('reseller_name', r.reseller_name, 'show_owner', r.reseller_id <> new.user_id)
    from telegram_resellers_for(new.user_id) r
    union all
    select 'payment_settled', new.id::text, 'admin', 'admin', v_payload || jsonb_build_object('show_owner', true)
    on conflict on constraint telegram_outbox_once do nothing;
  exception when others then
    raise warning 'telegram message for payment % not queued: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function enqueue_payment_settled_telegram() from public, anon, authenticated;

drop trigger if exists trg_payment_settled_telegram on payments;
create trigger trg_payment_settled_telegram
  after update of status on payments
  for each row
  when (new.status = 'settled' and old.status is distinct from 'settled')
  execute function enqueue_payment_settled_telegram();

-- ---------- 5. daily_close ----------
-- One row per reseller with a group, for business day p_day (default: the
-- day that closed at the last 17:00 Dhaka). Resellers with no payments get
-- a message too. Returns the number of new rows; a re-run returns 0.
create or replace function enqueue_daily_close(p_day date default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := coalesce(p_day, current_business_day() - 1);
  v_added int := 0;
  v_n int;
  r record;
begin
  for r in
    select p.id, coalesce(nullif(p.display_name, ''), p.email) as name, c.telegram_chat_id as chat
    from reseller_alert_channels c
    join profiles p on p.id = c.reseller_id and p.role = 'moderator' and p.account_status = 'active'
    where c.enabled and c.telegram_chat_id is not null
  loop
    insert into telegram_outbox (kind, ref, recipient, chat, payload)
    with ids as (
      select array_agg(t.user_id) || r.id as a from reseller_team_ids(r.id) t
    ),
    pays as (
      select s.* from ids, dashboard_settled_payments(coalesce(ids.a, array[r.id]), v_day, v_day, true) s
    ),
    links as (
      select coalesce(nullif(pl.display_name, ''), pl.slug, 'Payments without a link') as link_name,
             pl.slug as link_slug,
             coalesce(nullif(o.display_name, ''), o.email) as owner_name,
             s.user_id <> r.id as show_owner,
             count(*) as payments,
             sum(s.amount_settled) as gross_usd,
             sum(s.platform_fee) as fee_usd,
             sum(s.amount_settled) - sum(s.platform_fee) as net_usd
      from pays s
      left join payment_links pl on pl.id = s.payment_link_id
      join profiles o on o.id = s.user_id
      group by pl.id, pl.display_name, pl.slug, o.id, o.display_name, o.email, s.user_id
    )
    select 'daily_close', v_day::text, r.id::text, r.chat,
      jsonb_build_object(
        'reseller_name', r.name,
        'business_day', v_day,
        'day_start', business_day_start(v_day),
        'day_end', business_day_end(v_day),
        'links', coalesce((select jsonb_agg(to_jsonb(l) order by l.gross_usd desc, l.link_name) from links l), '[]'::jsonb),
        'totals', (select jsonb_build_object(
            'payments', count(*),
            'gross_usd', coalesce(sum(amount_settled), 0),
            'fee_usd', coalesce(sum(platform_fee), 0),
            'net_usd', coalesce(sum(amount_settled), 0) - coalesce(sum(platform_fee), 0)) from pays)
      )
    on conflict on constraint telegram_outbox_once do nothing;
    get diagnostics v_n = row_count;
    v_added := v_added + v_n;
  end loop;
  return v_added;
end;
$$;
revoke all on function enqueue_daily_close(date) from public, anon, authenticated;
grant execute on function enqueue_daily_close(date) to service_role;

-- ---------- 6. Sending ----------
-- Hands the sender up to p_limit due rows and marks them 'sending'. A row
-- claimed more than 10 minutes ago that never got an answer belongs to a
-- sender that died mid-send: Telegram may or may not have the message, so
-- it is marked failed and never sent again.
create or replace function telegram_claim(p_limit int default 20)
returns setof telegram_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  update telegram_outbox
     set status = 'failed', last_error = 'The sender stopped before recording a result; not resent'
   where status = 'sending' and claimed_at < now() - interval '10 minutes';
  return query
  update telegram_outbox o
     set status = 'sending', claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select id from telegram_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by id
      limit least(greatest(coalesce(p_limit, 20), 1), 100)
      for update skip locked)
  returning o.*;
end;
$$;
revoke all on function telegram_claim(int) from public, anon, authenticated;
grant execute on function telegram_claim(int) to service_role;

-- p_outcome: 'sent', 'skipped' (nothing to send to), 'failed' (Telegram
-- refused it), or 'retry' (Telegram did not take it: rate limit or a
-- server error). A retry waits p_retry_after_secs, else 30 s doubling,
-- and gives up after 5 attempts. Only a row in 'sending' moves.
create or replace function telegram_finish(
  p_id bigint, p_outcome text, p_message_id bigint default null,
  p_error text default null, p_retry_after_secs int default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row telegram_outbox;
begin
  select * into v_row from telegram_outbox where id = p_id for update;
  if not found then return 'not_found'; end if;
  if v_row.status <> 'sending' then return 'already_' || v_row.status; end if;
  if p_outcome = 'sent' then
    update telegram_outbox set status = 'sent', sent_at = now(), telegram_message_id = p_message_id, last_error = null where id = p_id;
  elsif p_outcome in ('skipped', 'failed') then
    update telegram_outbox set status = p_outcome, last_error = left(p_error, 500) where id = p_id;
  elsif p_outcome = 'retry' and v_row.attempts < 5 then
    update telegram_outbox
       set status = 'pending', last_error = left(p_error, 500),
           next_attempt_at = now() + make_interval(secs => coalesce(p_retry_after_secs, 30 * power(2, v_row.attempts - 1)::int))
     where id = p_id;
    return 'pending';
  elsif p_outcome = 'retry' then
    update telegram_outbox set status = 'failed', last_error = left(p_error, 500) where id = p_id;
    return 'failed';
  else
    raise exception 'telegram_finish: unknown outcome %', p_outcome;
  end if;
  return p_outcome;
end;
$$;
revoke all on function telegram_finish(bigint, text, bigint, text, int) from public, anon, authenticated;
grant execute on function telegram_finish(bigint, text, bigint, text, int) to service_role;

-- ---------- 7. Schedule ----------
-- cpay-telegram-send: every minute, calls telegram-notify only when a row
--   is due, so an idle minute makes no HTTP call.
-- cpay-daily-close: 11:00 UTC = 17:00 Dhaka (no DST), queues the day that
--   just closed; the next minute's job sends it.
-- The cron secret and functions URL are read from Vault when each job
-- runs, so rotating CRON_SECRET needs no change here.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed; Telegram jobs were not scheduled.';
    return;
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'pg_net is not installed; Telegram jobs were not scheduled.';
    return;
  end if;
  if (select count(*) from vault.decrypted_secrets where name in ('cpay_functions_url', 'cpay_cron_secret')) < 2 then
    raise notice 'Vault secrets cpay_functions_url/cpay_cron_secret are missing; Telegram jobs were not scheduled.';
    return;
  end if;

  perform cron.unschedule(jobname) from cron.job where jobname in ('cpay-telegram-send', 'cpay-daily-close');

  perform cron.schedule('cpay-telegram-send', '* * * * *', $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'cpay_functions_url') || '/functions/v1/telegram-notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cpay_cron_secret')),
      timeout_milliseconds := 60000)
    where exists (select 1 from public.telegram_outbox where status = 'pending' and next_attempt_at <= now());
  $job$);

  perform cron.schedule('cpay-daily-close', '0 11 * * *', $job$ select public.enqueue_daily_close(); $job$);
end $$;
