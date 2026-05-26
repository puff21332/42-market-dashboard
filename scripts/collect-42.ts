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

      const tradeRows = activities
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
        }));

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

    const rpc = await supabase.rpc("refresh_dashboard_metrics");
    if (rpc.error) throw rpc.error;

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

  const cleanup = await supabase
    .from("hot_markets")
    .delete()
    .lt("captured_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  if (cleanup.error) throw cleanup.error;
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
