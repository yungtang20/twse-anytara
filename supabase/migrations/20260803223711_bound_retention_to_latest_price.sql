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

  select date
  into shared_cutoff
  from public.trading_calendar
  where is_open
    and date <= (select max(date) from public.stock_price)
  order by date desc
  offset (price_rows - 1)
  limit 1;

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

revoke all on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  to service_role;

comment on function public.enforce_cloud_retention(integer, integer, integer, boolean) is
  'Deletes market rows before the shared 512-date cutoff, bounded by the latest stored price date.';
