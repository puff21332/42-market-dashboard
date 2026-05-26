import { createClient } from "@supabase/supabase-js";

const API_BASE = "https://rest.ft.42.space/api/v1";
const MARKET_LIMIT = 500;
const ACTIVITY_LIMIT = 100;

type Market = {
  address: string;
  question: string;
  status: string;
  categories?: string[];
  createdAt?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  volume?: number | null;
  totalMarketCap?: number | null;
  traders?: number | null;
};

type Activity = {
  transactionHash: string;
  marketAddress: string;
  userAddress: string;
  timestamp: number;
  type: string;
  collateral?: number | null;
  size?: number | null;
  tokenId?: string | null;
  outcome?: string | null;
  price?: number | null;
  marketCapAtTime?: number | null;
};

type TokenStat = {
  marketAddress: string;
  totalVolume?: number;
  price?: number;
  traders?: number;
  statsChanges?: {
    volumeChange24h?: number;
    priceChange24h?: number;
  };
  outcome?: {
    name?: string;
  };
  question?: {
    title?: string;
  };
};

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function intEnv(name: string, fallback: number) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function csvEnv(name: string, fallback: string) {
  return (process.env[name] ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${url}: ${body.slice(0, 300)}`);
  }

  return response.json() as Promise<T>;
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(item);
  }

  return result;
}

function toIsoFromUnix(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

function toDateFromUnix(seconds: number) {
  return toIsoFromUnix(seconds).slice(0, 10);
}

async function fetchMarkets(statuses: string[]) {
  const markets: Market[] = [];

  for (const status of statuses) {
    for (let offset = 0; ; offset += MARKET_LIMIT) {
      const url = `${API_BASE}/markets?status=${encodeURIComponent(status)}&limit=${MARKET_LIMIT}&offset=${offset}`;
      const json = await getJson<{ data: Market[]; pagination?: { hasMore?: boolean } }>(url);
      markets.push(...(json.data ?? []));
      if (!json.pagination?.hasMore || (json.data ?? []).length === 0) break;
    }
  }

  const unique = new Map<string, Market>();
  for (const market of markets) unique.set(market.address.toLowerCase(), market);
  return [...unique.values()];
}

async function fetchMarketActivities(marketAddress: string, maxPages: number) {
  const activities: Activity[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * ACTIVITY_LIMIT;
    const url = `${API_BASE}/market-data/activity?market=${marketAddress}&limit=${ACTIVITY_LIMIT}&offset=${offset}`;
    const json = await getJson<{ data: Activity[]; pagination?: { hasMore?: boolean } }>(url);
    const pageData = json.data ?? [];
    activities.push(...pageData);
    if (!json.pagination?.hasMore || pageData.length === 0) break;
  }

  return activities;
}

async function main() {
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  const maxActivityPages = intEnv("MAX_ACTIVITY_PAGES", 3);
  const statuses = csvEnv("COLLECT_STATUSES", "live,ended,resolved,finalised");
  const activityStatuses = csvEnv("ACTIVITY_STATUSES", "live,ended,resolved");
  const maxMarkets = intEnv("MAX_MARKETS", 0);

  const run = await supabase
    .from("collector_runs")
    .insert({ status: "running", message: `statuses=${statuses.join(",")} pages=${maxActivityPages}` })
    .select("id")
    .single();

  if (run.error) throw run.error;
  const runId = run.data.id as number;

  let marketsSeen = 0;
  let tradesSeen = 0;

  try {
    const markets = await fetchMarkets(statuses);
    marketsSeen = markets.length;

    const marketRows = markets.map((market) => ({
      address: market.address,
      question: market.question,
      status: market.status,
      categories: market.categories ?? [],
      created_at: market.createdAt,
      start_date: market.startDate,
      end_date: market.endDate,
      volume: market.volume ?? 0,
      total_market_cap: market.totalMarketCap ?? 0,
      traders: market.traders ?? 0,
      raw: market,
      updated_at: new Date().toISOString(),
    }));

    for (const batch of chunks(marketRows, 200)) {
      const { error } = await supabase.from("markets").upsert(batch, { onConflict: "address" });
      if (error) throw error;
    }

    const snapshotRows = markets.map((market) => ({
      market_address: market.address,
      volume: market.volume ?? 0,
      total_market_cap: market.totalMarketCap ?? 0,
      traders: market.traders ?? 0,
      status: market.status,
    }));

    for (const batch of chunks(snapshotRows, 200)) {
      const { error } = await supabase.from("market_snapshots").insert(batch);
      if (error) throw error;
    }

    const marketsForActivity = markets
      .filter((market) => activityStatuses.includes(market.status))
      .slice(0, maxMarkets > 0 ? maxMarkets : undefined);

    for (const [index, market] of marketsForActivity.entries()) {
      const activities = await fetchMarketActivities(market.address, maxActivityPages);
      tradesSeen += activities.length;

      const tradeRows = uniqueBy(
        activities
          .filter((item) => item.transactionHash && item.userAddress && item.marketAddress)
          .map((item) => ({
            transaction_hash: item.transactionHash,
            market_address: item.marketAddress,
            user_address: item.userAddress,
            type: item.type,
            occurred_at: toIsoFromUnix(item.timestamp),
            trade_date: toDateFromUnix(item.timestamp),
            collateral: item.collateral ?? 0,
            size: item.size ?? 0,
            token_id: item.tokenId ?? "",
            outcome: item.outcome ?? null,
            price: item.price ?? null,
            market_cap_at_time: item.marketCapAtTime ?? null,
            raw: item,
          })),
        (item) => `${item.transaction_hash}:${item.market_address}:${item.type}:${item.token_id}`,
      );

      for (const batch of chunks(tradeRows, 200)) {
        const { error } = await supabase
          .from("trades")
          .upsert(batch, { onConflict: "transaction_hash,market_address,type,token_id" });
        if (error) throw error;
      }

      if ((index + 1) % 25 === 0) {
        console.log(`activity ${index + 1}/${marketsForActivity.length}, trades=${tradesSeen}`);
      }
    }

    await refreshHotMarkets(supabase);

    await refreshDashboardMetrics(supabase);

    const finish = await supabase
      .from("collector_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        markets_seen: marketsSeen,
        trades_seen: tradesSeen,
        message: `Collected ${marketsSeen} markets and ${tradesSeen} activity rows.`,
      })
      .eq("id", runId);

    if (finish.error) throw finish.error;
    console.log(`done: markets=${marketsSeen}, activity_rows=${tradesSeen}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("collector_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        markets_seen: marketsSeen,
        trades_seen: tradesSeen,
        message,
      })
      .eq("id", runId);
    throw error;
  }
}

async function refreshHotMarkets(supabase: any) {
  const json = await getJson<{ data: TokenStat[] }>(
    `${API_BASE}/market-data/tokens/stats?status=live&order_by=volume&limit=100`,
  );

  const stats = json.data ?? [];
  const rows = [
    ...stats
      .slice()
      .sort((a, b) => Math.abs(b.statsChanges?.volumeChange24h ?? 0) - Math.abs(a.statsChanges?.volumeChange24h ?? 0))
      .slice(0, 6)
      .map((item) => hotRow(item, "24h volume change", item.statsChanges?.volumeChange24h ?? 0)),
    ...stats
      .slice()
      .sort((a, b) => Math.abs(b.statsChanges?.priceChange24h ?? 0) - Math.abs(a.statsChanges?.priceChange24h ?? 0))
      .slice(0, 6)
      .map((item) => hotRow(item, "24h price change", item.statsChanges?.priceChange24h ?? 0)),
  ];

  if (rows.length > 0) {
    const insert = await supabase.from("hot_markets").insert(rows);
    if (insert.error) throw insert.error;
  }

  // Keep cleanup out of the critical path. The dashboard reads only latest rows.
}

function hotRow(item: TokenStat, metricType: string, metricValue: number) {
  return {
    market_address: item.marketAddress,
    question: item.question?.title ?? item.marketAddress,
    outcome_name: item.outcome?.name ?? null,
    category: null,
    metric_type: metricType,
    metric_value: metricValue,
    price: item.price ?? null,
    volume_24h: item.totalVolume ?? null,
  };
}

async function refreshDashboardMetrics(supabase: any) {
  const today = new Date().toISOString().slice(0, 10);

  const [markets, trades] = await Promise.all([
    fetchAllRows(supabase, "markets", "address,status,created_at,total_market_cap,volume"),
    fetchAllRows(supabase, "trades", "user_address,market_address,type,trade_date,collateral"),
  ]);
  const firstTradeDate = new Map<string, string>();
  const dates = new Set<string>([today]);

  for (const trade of trades) {
    const user = String(trade.user_address).toLowerCase();
    dates.add(trade.trade_date);

    const previous = firstTradeDate.get(user);
    if (!previous || trade.trade_date < previous) firstTradeDate.set(user, trade.trade_date);
  }

  for (const market of markets) {
    const created = String(market.created_at ?? "").slice(0, 10);
    if (created) dates.add(created);
  }

  const sortedDates = [...dates].filter(Boolean).sort();
  const liveMarkets = markets.filter((market: any) => market.status === "live");
  const totalMarketCap = liveMarkets.reduce((sum: number, market: any) => sum + Number(market.total_market_cap ?? 0), 0);
  const top5MarketCap = liveMarkets
    .map((market: any) => Number(market.total_market_cap ?? 0))
    .sort((a: number, b: number) => b - a)
    .slice(0, 5)
    .reduce((sum: number, value: number) => sum + value, 0);

  const rows = sortedDates.map((date) => {
    const allUsers = new Set<string>();
    const dayUsers = new Set<string>();
    const activeMarkets = new Set<string>();
    const marketVolume = new Map<string, number>();

    let totalVolume = 0;
    let dailyVolume = 0;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of trades) {
      const user = String(trade.user_address).toLowerCase();
      const collateral = Number(trade.collateral ?? 0);

      if (trade.trade_date <= date) {
        allUsers.add(user);
        totalVolume += collateral;
      }

      if (trade.trade_date === date) {
        dayUsers.add(user);
        activeMarkets.add(trade.market_address);
        dailyVolume += collateral;
        if (trade.type === "MINT") buyVolume += collateral;
        if (trade.type === "REDEEM") sellVolume += collateral;
        marketVolume.set(trade.market_address, (marketVolume.get(trade.market_address) ?? 0) + collateral);
      }
    }

    const top5Volume = [...marketVolume.values()]
      .sort((a, b) => b - a)
      .slice(0, 5)
      .reduce((sum, value) => sum + value, 0);

    return {
      date,
      total_users: allUsers.size,
      new_users: [...firstTradeDate.values()].filter((firstDate) => firstDate === date).length,
      dau: dayUsers.size,
      total_markets: markets.filter((market: any) => String(market.created_at ?? "").slice(0, 10) <= date).length,
      new_markets: markets.filter((market: any) => String(market.created_at ?? "").slice(0, 10) === date).length,
      live_markets: date === today ? liveMarkets.length : 0,
      total_volume: totalVolume,
      daily_volume: dailyVolume,
      buy_volume: buyVolume,
      sell_volume: sellVolume,
      net_flow: buyVolume - sellVolume,
      total_market_cap: date === today ? totalMarketCap : 0,
      active_markets: activeMarkets.size,
      top5_volume_share: dailyVolume > 0 ? (top5Volume / dailyVolume) * 100 : 0,
      top5_market_cap_share: date === today && totalMarketCap > 0 ? (top5MarketCap / totalMarketCap) * 100 : 0,
      updated_at: new Date().toISOString(),
    };
  });

  for (const batch of chunks(rows, 200)) {
    const daily = await supabase.from("daily_metrics").upsert(batch, { onConflict: "date" });
    if (daily.error) throw daily.error;
  }

  const latestRow = rows.find((row) => row.date === today) ?? rows.at(-1);
  if (!latestRow) return;

  const latest = await supabase.from("latest_metrics").upsert(
    {
      id: true,
      ...Object.fromEntries(Object.entries(latestRow).filter(([key]) => key !== "date")),
      last_collected_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (latest.error) throw latest.error;
}

async function fetchAllRows(supabase: any, table: string, columns: string) {
  const pageSize = 1000;
  const rows: any[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const result = await supabase.from(table).select(columns).range(from, to);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
    if (!result.data || result.data.length < pageSize) break;
  }

  return rows;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
