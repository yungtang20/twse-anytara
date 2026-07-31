create or replace function public.enforce_cloud_retention(
  price_rows integer default 512,
  institutional_rows integer default 90,
  tdcc_rows integer default 104,
  execute_delete boolean default false
)
returns table(candidate_rows bigint, deleted_rows bigint)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  latest_price_date text;
  latest_institutional_date text;
  latest_tdcc_date text;
  price_cutoff text;
  institutional_cutoff text;
  tdcc_cutoff text;
  candidates bigint := 0;
  removed bigint := 0;
  affected bigint;
begin
  if price_rows not between 200 and 600
    or institutional_rows not between 20 and 180
    or tdcc_rows not between 20 and 156 then
    raise exception 'retention arguments outside safe bounds';
  end if;

  select max(date) into latest_price_date from public.stock_price;
  select max(date) into latest_institutional_date from public.stock_institutional;
  select max(date) into latest_tdcc_date from public.tdcc_shareholding;
  price_cutoff := to_char(latest_price_date::date - ceil(price_rows * 365.0 / 245.0)::integer, 'YYYY-MM-DD');
  institutional_cutoff := to_char(latest_institutional_date::date - ceil(institutional_rows * 365.0 / 245.0)::integer, 'YYYY-MM-DD');
  tdcc_cutoff := to_char(latest_tdcc_date::date - (tdcc_rows * 7), 'YYYY-MM-DD');

  if not execute_delete then
    select
      (select count(*) from public.stock_price where date < price_cutoff)
      + (select count(*) from public.stock_institutional where date < institutional_cutoff)
      + (select count(*) from public.tdcc_shareholding where date < tdcc_cutoff)
    into candidates;
    return query select candidates, 0::bigint;
    return;
  end if;

  if price_cutoff is not null then
    delete from public.stock_price where date < price_cutoff;
    get diagnostics affected = row_count;
    removed := removed + affected;
  end if;
  if institutional_cutoff is not null then
    delete from public.stock_institutional where date < institutional_cutoff;
    get diagnostics affected = row_count;
    removed := removed + affected;
  end if;
  if tdcc_cutoff is not null then
    delete from public.tdcc_shareholding where date < tdcc_cutoff;
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

revoke all on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  to service_role;
