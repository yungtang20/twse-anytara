drop policy if exists "stock_dataset_cache_service_only" on public.stock_dataset_cache;
create policy "stock_dataset_cache_service_only"
on public.stock_dataset_cache
for all
to service_role
using (true)
with check (true);

drop policy if exists "sync_runs_service_only" on public.sync_runs;
create policy "sync_runs_service_only"
on public.sync_runs
for all
to service_role
using (true)
with check (true);
