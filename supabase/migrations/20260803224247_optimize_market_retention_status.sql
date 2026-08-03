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
  with bounds as (
    select
      (select min(date) from public.stock_price) as price_min,
      (select max(date) from public.stock_price) as price_max,
      (select min(date) from public.stock_institutional) as institutional_min,
      (select min(date) from public.tdcc_shareholding) as tdcc_min
  )
  select
    (select date
     from public.trading_calendar
     where is_open and date <= bounds.price_max
     order by date desc offset 511 limit 1),
    (select count(*)
     from public.trading_calendar calendar
     where calendar.is_open
       and calendar.date between bounds.price_min and bounds.price_max
       and exists (select 1 from public.stock_price price where price.date = calendar.date)),
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

revoke all on function public.market_retention_status()
  from public, anon, authenticated;
grant execute on function public.market_retention_status()
  to service_role;

comment on function public.market_retention_status() is
  'Service-role coverage report using indexed date existence probes.';
