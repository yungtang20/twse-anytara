alter table public.tdcc_shareholding
  add column if not exists total_people bigint,
  add column if not exists whale_shares bigint,
  add column if not exists whale_people bigint;

comment on column public.tdcc_shareholding.total_people is
  'TDCC level 17 total shareholder count';
comment on column public.tdcc_shareholding.whale_shares is
  'TDCC level 15 shares held by holders with 1,000 lots or more';
comment on column public.tdcc_shareholding.whale_people is
  'TDCC level 15 holder count';
