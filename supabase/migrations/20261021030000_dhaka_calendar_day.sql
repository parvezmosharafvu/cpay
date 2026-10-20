-- 20261021030000: "daily" = the Bangladesh calendar day, midnight to midnight
-- Asia/Dhaka (UTC+6). Owner request 2026-10-21.
--
-- Until now a business day ran 17:00 to 17:00 Dhaka (0040, 0096), so every
-- dashboard, admin daily stat, the daily withdrawal limit and the Telegram
-- report rolled over at 5 PM. business_day(), business_day_start() and
-- business_day_end() are the single source for all of them (and for
-- daily_totals_for_cycle(), business_days(), current_business_day()), so
-- changing them moves everything at once. Two functions computed the 17:00
-- edge inline (telegram_context) or bucketed by UTC date (revenue_desk);
-- their bodies are rewritten below. Idempotent: CI applies it twice.
--
-- Stored rows in daily_stats for past days keep the 17:00 window they were
-- computed with; daily-report recomputes the last 3 days on each run.

create or replace function public.business_day(p_ts timestamptz)
returns date
language sql immutable parallel safe
set search_path = public
as $$
  select (p_ts at time zone 'Asia/Dhaka')::date;
$$;

create or replace function public.business_day_start(p_day date)
returns timestamptz
language sql immutable parallel safe
set search_path = public
as $$
  select (p_day + time '00:00') at time zone 'Asia/Dhaka';
$$;

-- business_day_end(d) = business_day_start(d + 1): unchanged, now midnight.

do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('telegram_context', 'revenue_desk')
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    v_new := replace(v_new, '((now() at time zone ''Asia/Dhaka'') - interval ''17 hours'')::date', '(now() at time zone ''Asia/Dhaka'')::date');
    v_new := replace(v_new, '|| '' 17:00'')::timestamp at time zone ''Asia/Dhaka''', '|| '' 00:00'')::timestamp at time zone ''Asia/Dhaka''');
    v_new := replace(v_new, '''17:00–17:00 Asia/Dhaka''', '''00:00–24:00 Asia/Dhaka (calendar day)''');
    v_new := replace(v_new, 'at time zone ''utc''), ''YYYY-MM-DD'')', 'at time zone ''Asia/Dhaka''), ''YYYY-MM-DD'')');
    if v_new <> v_def then
      execute v_new;
      raise notice 'rewrote %() to the Dhaka calendar day', r.proname;
    end if;
  end loop;
end $$;

-- Nothing in public may still use the 5 PM edge or a UTC date bucket.
do $$
declare v_left text;
begin
  select string_agg(p.proname, ', ') into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.prosrc ~ ' 17:00' or p.prosrc ~ 'time ''17:00''' or p.prosrc ~* '17 hours'
         or p.prosrc ~* 'time zone ''utc''\), ''YYYY-MM-DD''');
  if v_left is not null then
    raise exception 'still on the 17:00 / UTC day: %', v_left;
  end if;
end $$;
