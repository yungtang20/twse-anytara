alter table public.trade_risk_sync_status
  drop constraint if exists trade_risk_sync_status_status_check;

alter table public.trade_risk_sync_status
  add constraint trade_risk_sync_status_status_check
  check (status in ('success', 'degraded', 'failed'));

alter table public.trade_risk_sync_status
  alter column synced_at drop not null,
  add column if not exists attempted_at timestamptz not null default now(),
  add column if not exists error text;
