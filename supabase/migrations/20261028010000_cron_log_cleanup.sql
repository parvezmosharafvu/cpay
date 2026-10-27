-- CPAY — 20261028010000: keep pg_cron's run log to 7 days.
-- cron.job_run_details was never cleaned (67,000 rows, 51 MB since
-- 2026-09-22, about 3,200 more a day). wallet_ops_health() counts failed
-- runs in it with a full scan, which took about 3 s and sometimes passed
-- the 8 s statement timeout when several jobs started together, so the
-- health check alerted "statement timeout".
--
-- Deletes runs that ended more than 7 days ago now, then daily at 03:20 UTC
-- (job 'cron-log-cleanup'). Only the log is touched; jobs are unchanged.
-- Rollback: select cron.unschedule('cron-log-cleanup');

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — skipping cron-log-cleanup.';
    return;
  end if;
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  perform cron.unschedule('cron-log-cleanup') where exists (select 1 from cron.job where jobname = 'cron-log-cleanup');
  perform cron.schedule('cron-log-cleanup', '20 3 * * *',
    $job$delete from cron.job_run_details where end_time < now() - interval '7 days'$job$);
end $$;
