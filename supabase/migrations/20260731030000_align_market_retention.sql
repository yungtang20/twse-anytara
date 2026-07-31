-- Keep all cloud market datasets aligned to the exact 512th newest price
-- trading date. Institutional and TDCC data may start with shorter histories,
-- but they accumulate until reaching the same shared cutoff.

drop index if exists public.idx_stock_price_stock_date;

-- The cloud UI only consumes the three net values. The local SQLite schema
-- remains unchanged and can still keep its detailed buy/sell breakdown.
alter table public.stock_institutional
  drop column if exists foreign_buy,
  drop column if exists foreign_sell,
  drop column if exists trust_buy,
  drop column if exists trust_sell,
  drop column if exists dealer_buy,
  drop column if exists dealer_sell,
  drop column if exists updated_at;

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
  where (dataset = 'valuation' and period_date < to_char(current_date - interval '2 years', 'YYYY-MM-DD'))
     or (dataset = 'monthly_revenue' and period_date < to_char(current_date - interval '3 years', 'YYYY-MM-DD'))
     or (dataset in ('financial_statements', 'balance_sheet', 'cash_flow')
         and period_date < to_char(current_date - interval '4 years', 'YYYY-MM-DD'));
  get diagnostics affected = row_count;
  removed := removed + affected;

  return query select candidates, removed;
end;
$function$;

create or replace function public.market_missing_institutional_dates(
  target_dates integer default 60
)
returns table(date text)
language sql
security definer
set search_path = ''
as $function$
  with recent_price_dates as (
    select p.date, count(*)::bigint as price_rows
    from public.stock_price p
    group by p.date
    having count(*) > 100
    order by p.date desc
    limit target_dates
  ),
  institutional_dates as (
    select i.date, count(*)::bigint as institutional_rows
    from public.stock_institutional i
    group by i.date
  )
  select p.date
  from recent_price_dates p
  left join institutional_dates i on i.date = p.date
  where coalesce(i.institutional_rows, 0) < p.price_rows * 0.7
  order by p.date;
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
  with cutoff as (
    select retained.date
    from (
      select distinct date
      from public.stock_price
      order by date desc
      offset 511
      limit 1
    ) retained
  )
  select
    (select date from cutoff),
    (select count(distinct date) from public.stock_price),
    (select count(distinct date) from public.stock_institutional),
    (select count(distinct date) from public.tdcc_shareholding),
    (select min(date) from public.stock_price),
    (select min(date) from public.stock_institutional),
    (select min(date) from public.tdcc_shareholding),
    (select max(date) from public.stock_price);
$function$;

revoke all on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  to service_role;

revoke all on function public.market_missing_institutional_dates(integer)
  from public, anon, authenticated;
grant execute on function public.market_missing_institutional_dates(integer)
  to service_role;

revoke all on function public.market_retention_status()
  from public, anon, authenticated;
grant execute on function public.market_retention_status()
  to service_role;

comment on function public.enforce_cloud_retention(integer, integer, integer, boolean) is
  'Deletes price, institutional, and TDCC rows before the shared 512-price-date cutoff.';
comment on function public.market_missing_institutional_dates(integer) is
  'Returns incomplete institutional dates among the newest requested market trading dates.';
comment on function public.market_retention_status() is
  'Service-role-only coverage report for the aligned cloud retention window.';
