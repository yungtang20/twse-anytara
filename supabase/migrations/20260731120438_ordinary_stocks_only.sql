-- Keep the cloud market-data universe limited to Taiwan ordinary shares.
-- Leading-zero exchange-traded products and 91xx depositary receipts are excluded.

delete from public.stock_price
where stock_id !~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$';

delete from public.stock_institutional
where stock_id !~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$';

delete from public.tdcc_shareholding
where stock_id !~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$';

delete from public.dividend_events
where stock_id !~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$';

delete from public.stock_dataset_cache
where stock_id !~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$';

delete from public.stock_meta
where stock_id !~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$';

alter table public.stock_price
  add constraint stock_price_ordinary_stock_id_check
  check (stock_id ~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$');

alter table public.stock_institutional
  add constraint stock_institutional_ordinary_stock_id_check
  check (stock_id ~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$');

alter table public.tdcc_shareholding
  add constraint tdcc_shareholding_ordinary_stock_id_check
  check (stock_id ~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$');

alter table public.dividend_events
  add constraint dividend_events_ordinary_stock_id_check
  check (stock_id ~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$');

alter table public.stock_dataset_cache
  add constraint stock_dataset_cache_ordinary_stock_id_check
  check (stock_id ~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$');

alter table public.stock_meta
  add constraint stock_meta_ordinary_stock_id_check
  check (stock_id ~ '^([1-8][0-9]{3}|9[02-9][0-9]{2})$');
