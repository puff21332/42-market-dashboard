import { createClient } from "@supabase/supabase-js";

export type DailyMetric = {
  date: string;
  total_users: number;
  new_users: number;
  dau: number;
  total_markets: number;
  new_markets: number;
  live_markets: number;
  total_volume: number;
  daily_volume: number;
  buy_volume: number;
  sell_volume: number;
  net_flow: number;
  total_market_cap: number;
  active_markets: number;
  top5_volume_share: number;
  top5_market_cap_share: number;
  updated_at: string;
};

export type LatestMetric = Omit<DailyMetric, "date"> & {
  id: boolean;
  last_collected_at: string | null;
};

export type HotMarket = {
  id: number;
  market_address: string;
  question: string;
  outcome_name: string | null;
  category: string | null;
  metric_type: string;
  metric_value: number;
  price: number | null;
  volume_24h: number | null;
  captured_at: string;
};

export function browserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
