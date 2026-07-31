-- Public clients may read prices. Only the server-side service role may write.
alter table public.stock_price enable row level security;

revoke all on table public.stock_price from anon, authenticated;
grant select on table public.stock_price to anon, authenticated;
grant all on table public.stock_price to service_role;

drop policy if exists "stock_price_public_read" on public.stock_price;
create policy "stock_price_public_read"
on public.stock_price
for select
to anon, authenticated
using (true);

create or replace function public.prune_stock_price_retention(
  retain_rows integer default 512,
  execute_delete boolean default false
)
returns table(candidate_rows bigint, deleted_rows bigint)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if retain_rows < 1 or retain_rows > 5000 then
    raise exception 'retain_rows must be between 1 and 5000';
  end if;

  if not execute_delete then
    return query
    with ranked as (
      select row_number() over (
        partition by stock_id order by date desc
      ) as row_number
      from public.stock_price
    )
    select count(*) filter (where row_number > retain_rows), 0::bigint
    from ranked;
    return;
  end if;

  return query
  with ranked as (
    select stock_id, date, row_number() over (
      partition by stock_id order by date desc
    ) as row_number
    from public.stock_price
  ),
  targets as materialized (
    select stock_id, date from ranked where row_number > retain_rows
  ),
  deleted as (
    delete from public.stock_price prices
    using targets
    where prices.stock_id = targets.stock_id
      and prices.date = targets.date
    returning 1
  )
  select
    (select count(*) from targets),
    (select count(*) from deleted);
end;
$function$;

revoke all on function public.prune_stock_price_retention(integer, boolean)
from public, anon, authenticated;
grant execute on function public.prune_stock_price_retention(integer, boolean)
to service_role;

comment on function public.prune_stock_price_retention(integer, boolean) is
'Dry-run by default. Keeps the newest N rows per stock_id; service-role only.';
