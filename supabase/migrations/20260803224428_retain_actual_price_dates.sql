create or replace function public.enforce_cloud_retention(
  price_rows integer default 512,
  institutional_rows integer default 512,
  tdcc_rows integer default 512,
  execute_delete boolean default false
)
returns table(candidate_rows bigint, deleted_rows bigint)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  shared_cutoff text;
  candidates bigint := 0;
  removed bigint := 0;
  affected bigint;
begin
  if price_rows not between 200 and 600
    or institutional_rows not between 20 and 600
    or tdcc_rows not between 20 and 600 then
    raise exception 'retention arguments outside safe bounds';
  end if;

  select retained.date
  into shared_cutoff
  from (
    select distinct date
    from public.stock_price
    order by date desc
    offset (price_rows - 1)
    limit 1
  ) retained;

  if shared_cutoff is not null then
    select
      (select count(*) from public.stock_price where date < shared_cutoff)
      + (select count(*) from public.stock_institutional where date < shared_cutoff)
      + (select count(*) from public.tdcc_shareholding where date < shared_cutoff)
    into candidates;
  end if;

  if not execute_delete then
    return query select candidates, 0::bigint;
    return;
  end if;

  if shared_cutoff is not null then
    delete from public.stock_price where date < shared_cutoff;
    get diagnostics affected = row_count;
    removed := removed + affected;

    delete from public.stock_institutional where date < shared_cutoff;
    get diagnostics affected = row_count;
    removed := removed + affected;

    delete from public.tdcc_shareholding where date < shared_cutoff;
    get diagnostics affected = row_count;
    removed := removed + affected;
  end if;

  delete from public.dividend_events
  where date < to_char(current_date - interval '10 years', 'YYYY-MM-DD');
  get diagnostics affected = row_count;
  removed := removed + affected;

  delete from public.stock_dataset_cache
  where (dataset in ('valuation', 'institutional', 'margin', 'foreign_shareholding')
         and period_date < to_char(current_date - interval '2 years', 'YYYY-MM-DD'))
     or (dataset = 'monthly_revenue'
         and period_date < to_char(current_date - interval '3 years', 'YYYY-MM-DD'))
     or (dataset in ('financial_statements', 'balance_sheet', 'cash_flow')
         and period_date < to_char(current_date - interval '4 years', 'YYYY-MM-DD'))
     or (dataset = 'dividend'
         and period_date < to_char(current_date - interval '10 years', 'YYYY-MM-DD'));
  get diagnostics affected = row_count;
  removed := removed + affected;

  return query select candidates, removed;
end;
$function$;

create or replace function public.market_retention_status()
returns table(
  cutoff_date text,
  price_dates bigint,
  institutional_dates bigint,
  tdcc_dates bigint,
  price_min_date text,
  institutional_min_date text,
  tdcc_min_date text,
  latest_date text
)
language sql
security definer
set search_path = ''
as $function$
  with price_dates as materialized (
    select distinct date from public.stock_price
  ), bounds as (
    select
      (select min(date) from price_dates) as price_min,
      (select max(date) from price_dates) as price_max,
      (select min(date) from public.stock_institutional) as institutional_min,
      (select min(date) from public.tdcc_shareholding) as tdcc_min
  )
  select
    (select date from price_dates order by date desc offset 511 limit 1),
    (select count(*) from price_dates),
    (select count(*)
     from public.trading_calendar calendar
     where calendar.is_open
       and calendar.date between bounds.institutional_min and bounds.price_max
       and exists (select 1 from public.stock_institutional flow where flow.date = calendar.date)),
    (select count(*)
     from public.trading_calendar calendar
     where calendar.date between bounds.tdcc_min and bounds.price_max
       and exists (select 1 from public.tdcc_shareholding tdcc where tdcc.date = calendar.date)),
    bounds.price_min,
    bounds.institutional_min,
    bounds.tdcc_min,
    bounds.price_max
  from bounds;
$function$;

revoke all on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  to service_role;
revoke all on function public.market_retention_status()
  from public, anon, authenticated;
grant execute on function public.market_retention_status()
  to service_role;

comment on function public.enforce_cloud_retention(integer, integer, integer, boolean) is
  'Deletes market rows before the 512th newest stored price date.';
comment on function public.market_retention_status() is
  'Service-role coverage report scanning the indexed price dates once.';
