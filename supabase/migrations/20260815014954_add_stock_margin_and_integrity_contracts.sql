-- Canonical contract for the margin endpoint. This table used to exist only in
-- scripts/supabase_migrations.sql, so a clean migration replay could not serve
-- /api/stock/:id/margin.
create table if not exists public.stock_margin (
  stock_id text not null,
  date date not null,
  margin_buy bigint,
  margin_sell bigint,
  margin_cash_redeem bigint,
  margin_balance bigint,
  short_buy bigint,
  short_sell bigint,
  short_balance bigint,
  updated_at timestamptz not null default now(),
  primary key (stock_id, date),
  constraint stock_margin_stock_id_check check (stock_id ~ '^[1-9][0-9]{3}$'),
  constraint stock_margin_nonnegative_check check (
    (margin_buy is null or margin_buy >= 0)
    and (margin_sell is null or margin_sell >= 0)
    and (margin_cash_redeem is null or margin_cash_redeem >= 0)
    and (margin_balance is null or margin_balance >= 0)
    and (short_buy is null or short_buy >= 0)
    and (short_sell is null or short_sell >= 0)
    and (short_balance is null or short_balance >= 0)
  )
);

create index if not exists stock_margin_date_idx
  on public.stock_margin (date desc, stock_id);

alter table public.stock_margin enable row level security;
revoke all on table public.stock_margin from anon, authenticated;
grant select on table public.stock_margin to anon, authenticated;
grant all on table public.stock_margin to service_role;

drop policy if exists "stock_margin_public_read" on public.stock_margin;
create policy "stock_margin_public_read"
on public.stock_margin for select to anon, authenticated using (true);

-- NOT VALID avoids an unbounded validation scan during deployment while still
-- enforcing these contracts for every new or updated row. Operators can run
-- VALIDATE CONSTRAINT in a separately approved maintenance window.
do $integrity$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_margin_stock_id_check'
    and conrelid = 'public.stock_margin'::regclass) then
    alter table public.stock_margin add constraint stock_margin_stock_id_check
      check (stock_id ~ '^[1-9][0-9]{3}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_margin_nonnegative_check'
    and conrelid = 'public.stock_margin'::regclass) then
    alter table public.stock_margin add constraint stock_margin_nonnegative_check check (
      (margin_buy is null or margin_buy >= 0) and (margin_sell is null or margin_sell >= 0)
      and (margin_cash_redeem is null or margin_cash_redeem >= 0)
      and (margin_balance is null or margin_balance >= 0)
      and (short_buy is null or short_buy >= 0) and (short_sell is null or short_sell >= 0)
      and (short_balance is null or short_balance >= 0)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_price_iso_date_check'
    and conrelid = 'public.stock_price'::regclass) then
    alter table public.stock_price add constraint stock_price_iso_date_check
      check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_price_numeric_domain_check'
    and conrelid = 'public.stock_price'::regclass) then
    alter table public.stock_price add constraint stock_price_numeric_domain_check check (
      (open is null or open >= 0) and (high is null or high >= 0) and (low is null or low >= 0)
      and (close is null or close >= 0) and (volume is null or volume >= 0)
      and (amount is null or amount >= 0) and (trade_count is null or trade_count >= 0)
      and (high is null or low is null or high >= low)
      and (high is null or open is null or high >= open)
      and (high is null or close is null or high >= close)
      and (low is null or open is null or low <= open)
      and (low is null or close is null or low <= close)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_institutional_iso_date_check'
    and conrelid = 'public.stock_institutional'::regclass) then
    alter table public.stock_institutional add constraint stock_institutional_iso_date_check
      check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tdcc_shareholding_iso_date_check'
    and conrelid = 'public.tdcc_shareholding'::regclass) then
    alter table public.tdcc_shareholding add constraint tdcc_shareholding_iso_date_check
      check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tdcc_shareholding_numeric_domain_check'
    and conrelid = 'public.tdcc_shareholding'::regclass) then
    alter table public.tdcc_shareholding add constraint tdcc_shareholding_numeric_domain_check check (
      total_shares >= 0 and whale_ratio between 0 and 100
      and (retail_ratio is null or retail_ratio between 0 and 100)
      and (total_people is null or total_people >= 0)
      and (whale_shares is null or whale_shares >= 0)
      and (whale_people is null or whale_people >= 0)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dividend_events_iso_date_check'
    and conrelid = 'public.dividend_events'::regclass) then
    alter table public.dividend_events add constraint dividend_events_iso_date_check
      check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dividend_events_numeric_domain_check'
    and conrelid = 'public.dividend_events'::regclass) then
    alter table public.dividend_events add constraint dividend_events_numeric_domain_check
      check (cash_dividend >= 0 and stock_dividend >= 0
        and (reference_price is null or reference_price >= 0)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trading_calendar_iso_date_check'
    and conrelid = 'public.trading_calendar'::regclass) then
    alter table public.trading_calendar add constraint trading_calendar_iso_date_check
      check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_trade_risk_date_range_check'
    and conrelid = 'public.stock_trade_risk'::regclass) then
    alter table public.stock_trade_risk add constraint stock_trade_risk_date_range_check
      check (end_date is null or end_date >= start_date) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trade_risk_sync_status_counts_check'
    and conrelid = 'public.trade_risk_sync_status'::regclass) then
    alter table public.trade_risk_sync_status add constraint trade_risk_sync_status_counts_check
      check (local_total >= 0 and cloud_total >= 0 and active >= 0 and active <= cloud_total) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_price_stock_meta_fk'
    and conrelid = 'public.stock_price'::regclass) then
    alter table public.stock_price add constraint stock_price_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_institutional_stock_meta_fk'
    and conrelid = 'public.stock_institutional'::regclass) then
    alter table public.stock_institutional add constraint stock_institutional_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tdcc_shareholding_stock_meta_fk'
    and conrelid = 'public.tdcc_shareholding'::regclass) then
    alter table public.tdcc_shareholding add constraint tdcc_shareholding_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dividend_events_stock_meta_fk'
    and conrelid = 'public.dividend_events'::regclass) then
    alter table public.dividend_events add constraint dividend_events_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_dataset_cache_stock_meta_fk'
    and conrelid = 'public.stock_dataset_cache'::regclass) then
    alter table public.stock_dataset_cache add constraint stock_dataset_cache_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_trade_risk_stock_meta_fk'
    and conrelid = 'public.stock_trade_risk'::regclass) then
    alter table public.stock_trade_risk add constraint stock_trade_risk_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stock_margin_stock_meta_fk'
    and conrelid = 'public.stock_margin'::regclass) then
    alter table public.stock_margin add constraint stock_margin_stock_meta_fk foreign key (stock_id)
      references public.stock_meta(stock_id) on update cascade on delete restrict not valid;
  end if;
end;
$integrity$;

comment on table public.stock_margin is
'Daily margin and short balances. Public clients are read-only; service-role jobs own writes.';

create or replace function public.stock_price_histories(
  stock_ids text[], history_limit integer default 512
)
returns table(stock_id text, prices jsonb)
language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(array_length(stock_ids, 1), 0) < 1
     or array_length(stock_ids, 1) > 250
     or history_limit is null or history_limit < 1 or history_limit > 512 then
    raise exception 'invalid bounded history request';
  end if;
  return query
  select requested.stock_id,
    coalesce((select jsonb_agg(to_jsonb(history) order by history.date)
      from (select p.stock_id, p.date, p.open, p.high, p.low, p.close, p.volume, p.amount
        from public.stock_price p where p.stock_id = requested.stock_id
        order by p.date desc limit history_limit) history), '[]'::jsonb)
  from (select distinct unnest(stock_ids) as stock_id) requested
  where requested.stock_id ~ '^[0-9]{4,6}$';
end;
$$;

create or replace function public.stock_institutional_histories(
  stock_ids text[], history_limit integer default 30
)
returns table(stock_id text, rows jsonb)
language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(array_length(stock_ids, 1), 0) < 1
     or array_length(stock_ids, 1) > 250
     or history_limit is null or history_limit < 1 or history_limit > 120 then
    raise exception 'invalid bounded institutional request';
  end if;
  return query
  select requested.stock_id,
    coalesce((select jsonb_agg(to_jsonb(history) order by history.date desc)
      from (select i.stock_id, i.date, i.foreign_net, i.trust_net, i.dealer_net, i.institutional_net
        from public.stock_institutional i where i.stock_id = requested.stock_id
        order by i.date desc limit history_limit) history), '[]'::jsonb)
  from (select distinct unnest(stock_ids) as stock_id) requested
  where requested.stock_id ~ '^[0-9]{4,6}$';
end;
$$;

create or replace function public.tdcc_shareholding_histories(
  stock_ids text[], history_limit integer default 12
)
returns table(stock_id text, rows jsonb)
language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(array_length(stock_ids, 1), 0) < 1
     or array_length(stock_ids, 1) > 250
     or history_limit is null or history_limit < 1 or history_limit > 52 then
    raise exception 'invalid bounded TDCC request';
  end if;
  return query
  select requested.stock_id,
    coalesce((select jsonb_agg(to_jsonb(history) order by history.date desc)
      from (select t.stock_id, t.date, t.source, t.total_shares, t.whale_ratio,
          t.retail_ratio, t.total_people, t.whale_shares, t.whale_people, t.updated_at
        from public.tdcc_shareholding t where t.stock_id = requested.stock_id
        order by t.date desc limit history_limit) history), '[]'::jsonb)
  from (select distinct unnest(stock_ids) as stock_id) requested
  where requested.stock_id ~ '^[0-9]{4,6}$';
end;
$$;

revoke all on function public.stock_price_histories(text[], integer) from public;
revoke all on function public.stock_institutional_histories(text[], integer) from public;
revoke all on function public.tdcc_shareholding_histories(text[], integer) from public;
grant execute on function public.stock_price_histories(text[], integer) to anon, authenticated, service_role;
grant execute on function public.stock_institutional_histories(text[], integer) to anon, authenticated, service_role;
grant execute on function public.tdcc_shareholding_histories(text[], integer) to anon, authenticated, service_role;

comment on function public.stock_price_histories(text[], integer)
  is 'Returns bounded per-stock price histories in one RLS-protected request for strategy scans.';
comment on function public.stock_institutional_histories(text[], integer)
  is 'Returns bounded per-stock institutional histories in one RLS-protected request for strategy scans.';
comment on function public.tdcc_shareholding_histories(text[], integer)
  is 'Returns bounded per-stock TDCC histories in one RLS-protected request for strategy scans.';
