-- Cloud market-data contract.
-- The price table intentionally keeps its existing text date column to avoid a
-- one-million-row table rewrite and temporary disk amplification.

create table if not exists public.stock_meta (
  stock_id text primary key,
  stock_name text not null,
  market text not null check (market in ('TSE', 'OTC')),
  industry_category text,
  type text not null default 'stock',
  status text not null default 'active',
  source text not null,
  last_trade_date text,
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_institutional (
  stock_id text not null,
  date text not null,
  foreign_net bigint not null default 0,
  trust_net bigint not null default 0,
  dealer_net bigint not null default 0,
  foreign_buy bigint not null default 0,
  foreign_sell bigint not null default 0,
  trust_buy bigint not null default 0,
  trust_sell bigint not null default 0,
  dealer_buy bigint not null default 0,
  dealer_sell bigint not null default 0,
  institutional_net bigint not null default 0,
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (stock_id, date)
);

create table if not exists public.tdcc_shareholding (
  stock_id text not null,
  date text not null,
  total_shares bigint not null,
  whale_ratio real not null,
  retail_ratio real not null,
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (stock_id, date)
);

create table if not exists public.dividend_events (
  stock_id text not null,
  date text not null,
  cash_dividend real not null default 0,
  stock_dividend real not null default 0,
  reference_price real,
  source text not null,
  updated_at timestamptz not null default now(),
  primary key (stock_id, date)
);

create table if not exists public.trading_calendar (
  date text primary key,
  is_open boolean not null,
  source text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_dataset_cache (
  stock_id text not null,
  dataset text not null check (dataset in (
    'valuation',
    'monthly_revenue',
    'financial_statements',
    'balance_sheet',
    'cash_flow'
  )),
  period_date text not null,
  payload jsonb not null,
  source text not null default 'finmind',
  cached_at timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  primary key (stock_id, dataset, period_date)
);

create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'failed', 'dry_run')),
  latest_market_date text,
  price_rows integer not null default 0,
  institutional_rows integer not null default 0,
  meta_rows integer not null default 0,
  database_bytes bigint,
  message text
);

create index if not exists stock_price_date_idx
  on public.stock_price (date desc, stock_id);
create index if not exists stock_institutional_date_idx
  on public.stock_institutional (date desc, stock_id);
create index if not exists tdcc_shareholding_date_idx
  on public.tdcc_shareholding (date desc, stock_id);
create index if not exists dividend_events_date_idx
  on public.dividend_events (date desc, stock_id);
create index if not exists stock_dataset_cache_lru_idx
  on public.stock_dataset_cache (last_accessed_at, stock_id);

alter table public.stock_price enable row level security;
alter table public.stock_meta enable row level security;
alter table public.stock_institutional enable row level security;
alter table public.tdcc_shareholding enable row level security;
alter table public.dividend_events enable row level security;
alter table public.trading_calendar enable row level security;
alter table public.stock_dataset_cache enable row level security;
alter table public.sync_runs enable row level security;

revoke all on table
  public.stock_price,
  public.stock_meta,
  public.stock_institutional,
  public.tdcc_shareholding,
  public.dividend_events,
  public.trading_calendar,
  public.stock_dataset_cache,
  public.sync_runs
from anon, authenticated;

grant select on table
  public.stock_price,
  public.stock_meta,
  public.stock_institutional,
  public.tdcc_shareholding,
  public.dividend_events,
  public.trading_calendar
to anon, authenticated;

grant all on table
  public.stock_price,
  public.stock_meta,
  public.stock_institutional,
  public.tdcc_shareholding,
  public.dividend_events,
  public.trading_calendar,
  public.stock_dataset_cache,
  public.sync_runs
to service_role;

grant usage, select on sequence public.sync_runs_id_seq to service_role;

drop policy if exists "stock_price_public_read" on public.stock_price;
create policy "stock_price_public_read" on public.stock_price
  for select to anon, authenticated using (true);
drop policy if exists "stock_meta_public_read" on public.stock_meta;
create policy "stock_meta_public_read" on public.stock_meta
  for select to anon, authenticated using (true);
drop policy if exists "stock_institutional_public_read" on public.stock_institutional;
create policy "stock_institutional_public_read" on public.stock_institutional
  for select to anon, authenticated using (true);
drop policy if exists "tdcc_shareholding_public_read" on public.tdcc_shareholding;
create policy "tdcc_shareholding_public_read" on public.tdcc_shareholding
  for select to anon, authenticated using (true);
drop policy if exists "dividend_events_public_read" on public.dividend_events;
create policy "dividend_events_public_read" on public.dividend_events
  for select to anon, authenticated using (true);
drop policy if exists "trading_calendar_public_read" on public.trading_calendar;
create policy "trading_calendar_public_read" on public.trading_calendar
  for select to anon, authenticated using (true);

create or replace function public.cloud_storage_status()
returns table(database_bytes bigint, public_tables_bytes bigint, budget_bytes bigint)
language sql
security definer
set search_path = ''
as $function$
  select
    pg_database_size(current_database()),
    coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint,
    524288000::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'm');
$function$;

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
  candidates bigint;
  removed bigint := 0;
  affected bigint;
begin
  if price_rows not between 200 and 600
    or institutional_rows not between 20 and 180
    or tdcc_rows not between 20 and 156 then
    raise exception 'retention arguments outside safe bounds';
  end if;

  with targets as (
    select 1
    from (
      select row_number() over (partition by stock_id order by date desc) as rn
      from public.stock_price
    ) ranked where rn > price_rows
    union all
    select 1
    from (
      select row_number() over (partition by stock_id order by date desc) as rn
      from public.stock_institutional
    ) ranked where rn > institutional_rows
    union all
    select 1
    from (
      select row_number() over (partition by stock_id order by date desc) as rn
      from public.tdcc_shareholding
    ) ranked where rn > tdcc_rows
  )
  select count(*) into candidates from targets;

  if not execute_delete then
    return query select candidates, 0::bigint;
    return;
  end if;

  with ranked as (
    select stock_id, date,
      row_number() over (partition by stock_id order by date desc) as rn
    from public.stock_price
  )
  delete from public.stock_price p using ranked r
  where p.stock_id = r.stock_id and p.date = r.date and r.rn > price_rows;
  get diagnostics affected = row_count;
  removed := removed + affected;

  with ranked as (
    select stock_id, date,
      row_number() over (partition by stock_id order by date desc) as rn
    from public.stock_institutional
  )
  delete from public.stock_institutional i using ranked r
  where i.stock_id = r.stock_id and i.date = r.date and r.rn > institutional_rows;
  get diagnostics affected = row_count;
  removed := removed + affected;

  with ranked as (
    select stock_id, date,
      row_number() over (partition by stock_id order by date desc) as rn
    from public.tdcc_shareholding
  )
  delete from public.tdcc_shareholding t using ranked r
  where t.stock_id = r.stock_id and t.date = r.date and r.rn > tdcc_rows;
  get diagnostics affected = row_count;
  removed := removed + affected;

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

revoke all on function public.cloud_storage_status() from public, anon, authenticated;
grant execute on function public.cloud_storage_status() to service_role;
revoke all on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.enforce_cloud_retention(integer, integer, integer, boolean)
  to service_role;

comment on function public.cloud_storage_status() is
  'Service-role-only database size check against the 500 MiB hard budget.';
comment on function public.enforce_cloud_retention(integer, integer, integer, boolean) is
  'Service-role-only retention enforcement. Dry-run unless execute_delete is true.';

create or replace function public.market_dashboard(
  card text,
  result_limit integer default 50
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  latest_date text;
  previous_date text;
  result jsonb;
begin
  if result_limit not between 1 and 100 then
    raise exception 'result_limit must be between 1 and 100';
  end if;

  select date into latest_date
  from public.stock_price
  group by date having count(*) > 100
  order by date desc limit 1;

  select date into previous_date
  from public.stock_price
  where date < latest_date
  group by date having count(*) > 100
  order by date desc limit 1;

  if card = 'movers' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.change_pct desc), '[]'::jsonb)
    into result
    from (
      select p.stock_id, m.stock_name, m.market, p.close as price,
        prev.close as prev_close,
        round((p.close - prev.close)::numeric, 2) as change,
        round(((p.close - prev.close) / nullif(prev.close, 0) * 100)::numeric, 2) as change_pct
      from public.stock_price p
      join public.stock_price prev on prev.stock_id = p.stock_id and prev.date = previous_date
      join public.stock_meta m on m.stock_id = p.stock_id
      where p.date = latest_date and prev.close > 0
      order by change_pct desc
    ) q;
    return jsonb_build_object(
      'date', latest_date,
      'gainers', coalesce((select jsonb_agg(value) from jsonb_array_elements(result) with ordinality e(value, n) where n <= 5), '[]'::jsonb),
      'losers', coalesce((select jsonb_agg(value order by n desc) from jsonb_array_elements(result) with ordinality e(value, n) where n > jsonb_array_length(result) - 5), '[]'::jsonb)
    );
  end if;

  if card = 'recent_dividend' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.event_date), '[]'::jsonb)
    into result
    from (
      select d.stock_id, m.stock_name, d.date as event_date,
        d.cash_dividend, d.stock_dividend,
        round((p.close - d.cash_dividend)::numeric, 2) as reference_price,
        p.close, prev.close as prev_close,
        round(((p.close - prev.close) / nullif(prev.close, 0) * 100)::numeric, 2) as change_pct,
        floor(p.volume / 1000.0) as volume,
        round(((p.volume - prev.volume) / nullif(prev.volume, 0)::numeric * 100), 1) as volume_change_pct
      from public.dividend_events d
      join public.stock_meta m on m.stock_id = d.stock_id
      join public.stock_price p on p.stock_id = d.stock_id and p.date = latest_date
      join public.stock_price prev on prev.stock_id = d.stock_id and prev.date = previous_date
      where d.date >= to_char(current_date, 'YYYY-MM-DD')
      order by d.date
      limit result_limit
    ) q;
    return result;
  end if;

  if card = 'trust_buy_2day' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.trust_net desc), '[]'::jsonb)
    into result
    from (
      select i.stock_id, m.stock_name,
        floor(p.volume / 1000.0) as volume,
        round((p.close * p.volume / 100000000.0)::numeric, 2) as amount,
        least(10, coalesce(streak.trust_days, 2)) as trust_days,
        floor(i.trust_net / 1000.0) as trust_net,
        p.close, prev.close as prev_close,
        round(((p.close - prev.close) / nullif(prev.close, 0) * 100)::numeric, 2) as change_pct,
        round(((p.volume - prev.volume) / nullif(prev.volume, 0)::numeric * 100), 2) as volume_change_pct
      from public.stock_institutional i
      join public.stock_institutional ip
        on ip.stock_id = i.stock_id and ip.date = previous_date and ip.trust_net > 0
      join public.stock_meta m on m.stock_id = i.stock_id
      join public.stock_price p on p.stock_id = i.stock_id and p.date = latest_date
      join public.stock_price prev on prev.stock_id = i.stock_id and prev.date = previous_date
      cross join lateral (
        select count(*)::integer as trust_days
        from (
          select trust_net from public.stock_institutional x
          where x.stock_id = i.stock_id and x.date <= latest_date
          order by x.date desc limit 10
        ) recent
        where trust_net > 0
      ) streak
      where i.date = latest_date and i.trust_net > 0
      order by i.trust_net desc
      limit result_limit
    ) q;
    return result;
  end if;

  if card = 'break_ma200' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.volume desc), '[]'::jsonb)
    into result
    from (
      select candidate.stock_id, candidate.stock_name,
        history.prev_close, history.latest_close,
        round(history.prev_ma200::numeric, 2) as prev_ma200,
        round(history.latest_ma200::numeric, 2) as latest_ma200,
        floor(candidate.volume / 1000.0) as volume,
        candidate.close,
        round(((candidate.close - candidate.prev_close) / nullif(candidate.prev_close, 0) * 100)::numeric, 2) as change_pct,
        round(((candidate.volume - candidate.prev_volume) / nullif(candidate.prev_volume, 0)::numeric * 100), 2) as volume_change_pct
      from (
        select p.stock_id, m.stock_name, p.close, p.volume,
          prev.close as prev_close, prev.volume as prev_volume
        from public.stock_price p
        join public.stock_meta m on m.stock_id = p.stock_id
        join public.stock_price prev on prev.stock_id = p.stock_id and prev.date = previous_date
        where p.date = latest_date and p.volume >= 500000
        order by p.volume desc limit 150
      ) candidate
      cross join lateral (
        select
          max(close) filter (where rn = 1) as latest_close,
          max(close) filter (where rn = 2) as prev_close,
          avg(close) filter (where rn between 1 and 200) as latest_ma200,
          avg(close) filter (where rn between 2 and 201) as prev_ma200,
          count(*) as row_count
        from (
          select close, row_number() over (order by date desc) as rn
          from public.stock_price h
          where h.stock_id = candidate.stock_id
          order by date desc limit 202
        ) prices
      ) history
      where history.row_count >= 201
        and (
          (history.prev_close <= history.prev_ma200 and history.latest_close > history.latest_ma200)
          or history.latest_close / nullif(history.latest_ma200, 0) between 1 and 1.025
        )
      order by candidate.volume desc
      limit result_limit
    ) q;
    return result;
  end if;

  if card = 'limit_up_yesterday' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.change_pct desc), '[]'::jsonb)
    into result
    from (
      select p.stock_id, m.stock_name, p.close, prev.close as prev_close,
        round(((p.close - prev.close) / nullif(prev.close, 0) * 100)::numeric, 2) as change_pct,
        floor(p.volume / 1000.0) as volume,
        round(((p.volume - avg_volume.value) / nullif(avg_volume.value, 0)::numeric * 100), 2) as vol_explosion_pct,
        round(((p.volume - prev.volume) / nullif(prev.volume, 0)::numeric * 100), 2) as volume_change_pct
      from public.stock_price p
      join public.stock_meta m on m.stock_id = p.stock_id
      join public.stock_price prev on prev.stock_id = p.stock_id and prev.date = previous_date
      cross join lateral (
        select avg(volume) as value
        from (
          select volume from public.stock_price h
          where h.stock_id = p.stock_id and h.date < latest_date
          order by date desc limit 5
        ) recent
      ) avg_volume
      where p.date = latest_date and prev.close > 0
        and (p.close - prev.close) / prev.close >= 0.085
      order by change_pct desc
      limit result_limit
    ) q;
    return result;
  end if;

  raise exception 'unsupported dashboard card: %', card;
end;
$function$;

grant execute on function public.market_dashboard(text, integer) to anon, authenticated, service_role;
