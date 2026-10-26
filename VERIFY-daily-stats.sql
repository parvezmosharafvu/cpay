-- ============================================================
-- Verify the daily_stats archive against the live ledger
-- ============================================================
-- A day is the Bangladesh calendar day, midnight to midnight Asia/Dhaka
-- (20261021030000_dhaka_calendar_day.sql). Before that it ran 5pm–5pm;
-- this query computed the 5pm edge itself and so reported every recent
-- row wrong after the change. It now asks current_business_day().
--
-- Rows stored before 2026-10-21 keep the 5pm window they were computed
-- with, so older rows may read 'STALE' until daily-report is re-run for
-- them (?days=30 below).
--
-- This uses daily_totals_for_cycle(), the single function that now
-- defines a day for the whole system, so what it checks against is by
-- construction the same thing daily-report wrote.
--
-- Note: daily_stats is no longer displayed anywhere. The admin Earnings
-- tab reads admin_daily_settled() live. This table is an archive, and
-- this query is how you confirm the archive is trustworthy.
-- ============================================================

with cycles as (
  select generate_series(
    current_business_day() - 29,
    current_business_day(),
    interval '1 day'
  )::date as cycle_date
),
expected as (
  select c.cycle_date, t.total_settled, t.payment_count
  from cycles c
  cross join lateral daily_totals_for_cycle(c.cycle_date) t
)
select
  e.cycle_date,
  round(e.total_settled, 2)                as should_be,
  round(coalesce(ds.total_settled, 0), 2)  as stored,
  e.payment_count                          as payments,
  case
    when ds.stat_date is null then 'row missing — run daily-report'
    when round(coalesce(ds.total_settled, 0), 2) = round(e.total_settled, 2) then 'ok'
    else 'STALE — re-run daily-report'
  end as verdict
from expected e
left join daily_stats ds on ds.stat_date = e.cycle_date
order by e.cycle_date desc;


-- ============================================================
-- If anything is not 'ok'
-- ============================================================
-- Backfill (replace <CRON_SECRET>):
--   curl -H "x-cron-secret: <CRON_SECRET>" \
--     "https://riumaeihemgznvgattoc.supabase.co/functions/v1/daily-report?days=30"
--
-- Then re-run the query above. Every row should read 'ok'.
--
-- The newest row is today (Dhaka), still in progress, so it reads low
-- until midnight Dhaka passes. That is expected, not a fault.
