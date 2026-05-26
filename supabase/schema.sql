create table if not exists public.markets (
  address text primary key,
  question text not null,
  status text not null,
  categories text[] not null default '{}',
  created_at timestamptz,
  start_date timestamptz,
  end_date timestamptz,
  volume numeric not null default 0,
  total_market_cap numeric not null default 0,
  traders integer not null default 0,
  raw jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  transaction_hash text not null,
  market_address text not null references public.markets(address) on delete cascade,
  user_address text not null,
  type text not null,
  occurred_at timestamptz not null,
  trade_date date not null,
  collateral numeric not null default 0,
  size numeric not null default 0,
  token_id text,
  outcome text,
  price numeric,
  market_cap_at_time numeric,
  raw jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  primary key (transaction_hash, market_address, type, token_id)
);

create table if not exists public.market_snapshots (
  id bigint generated always as identity primary key,
  market_address text not null references public.markets(address) on delete cascade,
  captured_at timestamptz not null default now(),
  volume numeric not null default 0,
  total_market_cap numeric not null default 0,
  traders integer not null default 0,
  status text not null
);

create table if not exists public.daily_metrics (
  date date primary key,
  total_users integer not null default 0,
  new_users integer not null default 0,
  dau integer not null default 0,
  total_markets integer not null default 0,
  new_markets integer not null default 0,
  live_markets integer not null default 0,
  total_volume numeric not null default 0,
  daily_volume numeric not null default 0,
  buy_volume numeric not null default 0,
  sell_volume numeric not null default 0,
  net_flow numeric not null default 0,
  total_market_cap numeric not null default 0,
  active_markets integer not null default 0,
  top5_volume_share numeric not null default 0,
  top5_market_cap_share numeric not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.latest_metrics (
  id boolean primary key default true,
  total_users integer not null default 0,
  new_users integer not null default 0,
  dau integer not null default 0,
  total_markets integer not null default 0,
  new_markets integer not null default 0,
  live_markets integer not null default 0,
  total_volume numeric not null default 0,
  daily_volume numeric not null default 0,
  buy_volume numeric not null default 0,
  sell_volume numeric not null default 0,
  net_flow numeric not null default 0,
  total_market_cap numeric not null default 0,
  active_markets integer not null default 0,
  top5_volume_share numeric not null default 0,
  top5_market_cap_share numeric not null default 0,
  last_collected_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint latest_metrics_singleton check (id = true)
);

create table if not exists public.hot_markets (
  id bigint generated always as identity primary key,
  market_address text not null,
  question text not null,
  outcome_name text,
  category text,
  metric_type text not null,
  metric_value numeric not null default 0,
  price numeric,
  volume_24h numeric,
  captured_at timestamptz not null default now()
);

create table if not exists public.collector_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  markets_seen integer not null default 0,
  trades_seen integer not null default 0,
  message text
);

create index if not exists trades_trade_date_idx on public.trades(trade_date);
create index if not exists trades_user_date_idx on public.trades(user_address, trade_date);
create index if not exists trades_market_date_idx on public.trades(market_address, trade_date);
create index if not exists market_snapshots_market_captured_idx on public.market_snapshots(market_address, captured_at desc);
create index if not exists hot_markets_captured_idx on public.hot_markets(captured_at desc);

create or replace function public.refresh_dashboard_metrics()
returns void
language plpgsql
security definer
as $$
declare
  today date := (now() at time zone 'utc')::date;
  live_count integer := 0;
  current_market_cap numeric := 0;
  top5_cap_share numeric := 0;
  last_run timestamptz;
begin
  select count(*), coalesce(sum(total_market_cap), 0)
  into live_count, current_market_cap
  from public.markets
  where status = 'live';

  select
    case when coalesce(sum(total_market_cap), 0) = 0 then 0
      else (
        select coalesce(sum(total_market_cap), 0)
        from (
          select total_market_cap
          from public.markets
          where status = 'live'
          order by total_market_cap desc
          limit 5
        ) top_markets
      ) / coalesce(sum(total_market_cap), 1) * 100
    end
  into top5_cap_share
  from public.markets
  where status = 'live';

  select max(finished_at)
  into last_run
  from public.collector_runs
  where status = 'success';

  delete from public.daily_metrics;

  insert into public.daily_metrics (
    date,
    total_users,
    new_users,
    dau,
    total_markets,
    new_markets,
    live_markets,
    total_volume,
    daily_volume,
    buy_volume,
    sell_volume,
    net_flow,
    total_market_cap,
    active_markets,
    top5_volume_share,
    top5_market_cap_share,
    updated_at
  )
  with bounds as (
    select coalesce(
      least(
        (select min(trade_date) from public.trades),
        (select min((created_at at time zone 'utc')::date) from public.markets)
      ),
      today
    ) as start_date
  ),
  days as (
    select generate_series((select start_date from bounds), today, interval '1 day')::date as day
  ),
  first_users as (
    select user_address, min(trade_date) as first_day
    from public.trades
    group by user_address
  ),
  trade_day as (
    select
      trade_date as day,
      count(distinct user_address) as dau,
      count(distinct market_address) as active_markets,
      coalesce(sum(collateral), 0) as daily_volume,
      coalesce(sum(collateral) filter (where type = 'MINT'), 0) as buy_volume,
      coalesce(sum(collateral) filter (where type = 'REDEEM'), 0) as sell_volume
    from public.trades
    where type in ('MINT', 'REDEEM')
    group by trade_date
  ),
  market_day as (
    select (created_at at time zone 'utc')::date as day, count(*) as new_markets
    from public.markets
    where created_at is not null
    group by 1
  ),
  market_volume_day as (
    select trade_date as day, market_address, coalesce(sum(collateral), 0) as volume
    from public.trades
    where type in ('MINT', 'REDEEM')
    group by trade_date, market_address
  ),
  ranked_market_volume as (
    select day, volume, row_number() over (partition by day order by volume desc) as rn
    from market_volume_day
  ),
  top5_volume_day as (
    select
      t.day,
      case when t.daily_volume = 0 then 0
        else coalesce(sum(r.volume) filter (where r.rn <= 5), 0) / t.daily_volume * 100
      end as top5_volume_share
    from trade_day t
    left join ranked_market_volume r on r.day = t.day
    group by t.day, t.daily_volume
  )
  select
    d.day,
    (select count(*) from first_users fu where fu.first_day <= d.day)::integer as total_users,
    (select count(*) from first_users fu where fu.first_day = d.day)::integer as new_users,
    coalesce(td.dau, 0)::integer as dau,
    (select count(*) from public.markets m where m.created_at is not null and (m.created_at at time zone 'utc')::date <= d.day)::integer as total_markets,
    coalesce(md.new_markets, 0)::integer as new_markets,
    case when d.day = today then live_count else 0 end as live_markets,
    (select coalesce(sum(collateral), 0) from public.trades t where t.type in ('MINT', 'REDEEM') and t.trade_date <= d.day) as total_volume,
    coalesce(td.daily_volume, 0),
    coalesce(td.buy_volume, 0),
    coalesce(td.sell_volume, 0),
    coalesce(td.buy_volume, 0) - coalesce(td.sell_volume, 0),
    case when d.day = today then current_market_cap else 0 end,
    coalesce(td.active_markets, 0)::integer,
    coalesce(tv.top5_volume_share, 0),
    case when d.day = today then coalesce(top5_cap_share, 0) else 0 end,
    now()
  from days d
  left join trade_day td on td.day = d.day
  left join market_day md on md.day = d.day
  left join top5_volume_day tv on tv.day = d.day;

  insert into public.latest_metrics (
    id,
    total_users,
    new_users,
    dau,
    total_markets,
    new_markets,
    live_markets,
    total_volume,
    daily_volume,
    buy_volume,
    sell_volume,
    net_flow,
    total_market_cap,
    active_markets,
    top5_volume_share,
    top5_market_cap_share,
    last_collected_at,
    updated_at
  )
  select
    true,
    total_users,
    new_users,
    dau,
    total_markets,
    new_markets,
    live_markets,
    total_volume,
    daily_volume,
    buy_volume,
    sell_volume,
    net_flow,
    total_market_cap,
    active_markets,
    top5_volume_share,
    top5_market_cap_share,
    last_run,
    now()
  from public.daily_metrics
  where date = today
  on conflict (id) do update set
    total_users = excluded.total_users,
    new_users = excluded.new_users,
    dau = excluded.dau,
    total_markets = excluded.total_markets,
    new_markets = excluded.new_markets,
    live_markets = excluded.live_markets,
    total_volume = excluded.total_volume,
    daily_volume = excluded.daily_volume,
    buy_volume = excluded.buy_volume,
    sell_volume = excluded.sell_volume,
    net_flow = excluded.net_flow,
    total_market_cap = excluded.total_market_cap,
    active_markets = excluded.active_markets,
    top5_volume_share = excluded.top5_volume_share,
    top5_market_cap_share = excluded.top5_market_cap_share,
    last_collected_at = excluded.last_collected_at,
    updated_at = now();
end;
$$;

alter table public.daily_metrics enable row level security;
alter table public.latest_metrics enable row level security;
alter table public.hot_markets enable row level security;
alter table public.markets enable row level security;
alter table public.trades enable row level security;
alter table public.market_snapshots enable row level security;
alter table public.collector_runs enable row level security;

drop policy if exists "Public dashboard reads daily metrics" on public.daily_metrics;
create policy "Public dashboard reads daily metrics"
on public.daily_metrics for select
using (true);

drop policy if exists "Public dashboard reads latest metrics" on public.latest_metrics;
create policy "Public dashboard reads latest metrics"
on public.latest_metrics for select
using (true);

drop policy if exists "Public dashboard reads hot markets" on public.hot_markets;
create policy "Public dashboard reads hot markets"
on public.hot_markets for select
using (true);

drop policy if exists "Public dashboard reads markets" on public.markets;
create policy "Public dashboard reads markets"
on public.markets for select
using (true);

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.refresh_dashboard_metrics() to service_role;
