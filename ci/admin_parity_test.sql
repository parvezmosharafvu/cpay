-- M13: Reports and manual statements use guarded RPCs and never touch ledger.
\set ON_ERROR_STOP on
begin;
create or replace function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)
$$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;
insert into auth.users(id,email) values
 ('d3100000-0000-0000-0000-000000000001','parity-admin@test.invalid'),
 ('d3100000-0000-0000-0000-000000000002','parity-member@test.invalid'),
 ('d3100000-0000-0000-0000-000000000003','parity-other@test.invalid');
update profiles set account_status='active',role='admin'
 where id='d3100000-0000-0000-0000-000000000001';
update profiles set account_status='active'
 where id in ('d3100000-0000-0000-0000-000000000002','d3100000-0000-0000-0000-000000000003');

-- Members read their own aggregates; they cannot read or mutate admin data.
select set_config('request.jwt.claim.sub','d3100000-0000-0000-0000-000000000002',true);
select set_config('request.jwt.claims','{"aal":"aal1"}',true);
set local role authenticated;
do $$
declare r jsonb;
begin
  r := my_monthly_report(null);
  if (r->>'attempts')::int <> 0 then raise exception 'unexpected fixture report values'; end if;
  begin
    r := admin_parity_overview();
    raise exception 'non-admin read admin metrics';
  exception when raise_exception then
    if sqlerrm <> 'Not authorized' then raise; end if;
  end;
  begin
    perform * from admin_statement_list(null);
    raise exception 'non-admin read statements';
  exception when raise_exception then
    if sqlerrm <> 'Not authorized' then raise; end if;
  end;
end $$;
reset role;

-- Strong admin can add a statement, but paid requires external proof.
select set_config('request.jwt.claim.sub','d3100000-0000-0000-0000-000000000001',true);
select set_config('request.jwt.claims','{"aal":"aal2"}',true);
set local role authenticated;
do $$
declare v_id uuid; m jsonb;
begin
  m := admin_parity_overview();
  if m ? 'active_links' is false or m ? 'month_fees' is false then
    raise exception 'overview response incomplete';
  end if;
  v_id:=admin_statement_write(null,'d3100000-0000-0000-0000-000000000002','October service',
         'Reviewed manually',25.50,null,'outstanding',null);
  if not exists(select 1 from admin_statement_list('outstanding') where id=v_id and amount_usd=25.50) then
    raise exception 'admin statement missing';
  end if;
  begin
    perform admin_statement_write(v_id,'d3100000-0000-0000-0000-000000000002','October service',
         'Reviewed manually',25.50,null,'paid',null);
    raise exception 'paid without reference';
  exception when raise_exception then
    if sqlerrm <> 'A payment reference is required' then raise; end if;
  end;
  perform admin_statement_write(v_id,'d3100000-0000-0000-0000-000000000002','October service',
       'Reviewed manually',25.50,null,'paid','example-external-receipt');
  if not exists(select 1 from admin_statement_list('paid') where id=v_id and external_reference='example-external-receipt') then
    raise exception 'statement not marked externally paid';
  end if;
  begin
    perform admin_statement_write(v_id,'d3100000-0000-0000-0000-000000000002','October service',
         'Reviewed manually',10,null,'draft',null);
    raise exception 'edited finalized statement';
  exception when raise_exception then
    if sqlerrm <> 'Finalized statement cannot be edited' then raise; end if;
  end;
end $$;
reset role;

-- Tables are service-role/internal only.
select set_config('request.jwt.claim.sub','d3100000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$
begin
  begin
    perform * from admin_statements;
    raise exception 'member read raw private statements';
  exception when others then
    if sqlerrm = 'member read raw private statements' then raise; end if;
  end;
end $$;
reset role;
rollback;
\echo 'admin_parity_test: passed'
