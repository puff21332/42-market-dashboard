import { browserSupabase, DailyMetric, HotMarket, LatestMetric } from "@/lib/supabase";
import { compactNumber, fullTime, money, percent, shortDate, signedMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

async function getDashboardData() {
  const supabase = browserSupabase();

  const [latestRes, dailyRes, hotRes] = await Promise.all([
    supabase.from("latest_metrics").select("*").eq("id", true).maybeSingle<LatestMetric>(),
    supabase.from("daily_metrics").select("*").order("date", { ascending: false }).limit(31).returns<DailyMetric[]>(),
    supabase
      .from("hot_markets")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(12)
      .returns<HotMarket[]>(),
  ]);

  if (latestRes.error) throw latestRes.error;
  if (dailyRes.error) throw dailyRes.error;
  if (hotRes.error) throw hotRes.error;

  return {
    latest: latestRes.data,
    daily: (dailyRes.data ?? []).slice().reverse(),
    hotMarkets: hotRes.data ?? [],
  };
}

function MetricCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <section className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </section>
  );
}

function MiniBars({
  data,
  field,
  format,
}: {
  data: DailyMetric[];
  field: keyof DailyMetric;
  format: (value: number) => string;
}) {
  const values = data.map((item) => Number(item[field] ?? 0));
  const max = Math.max(...values.map(Math.abs), 1);

  return (
    <div className="bars">
      {data.slice(-30).map((item) => {
        const value = Number(item[field] ?? 0);
        const height = Math.max(4, (Math.abs(value) / max) * 100);
        return (
          <div className="barSlot" key={`${String(field)}-${item.date}`} title={`${item.date}: ${format(value)}`}>
            <div className={value < 0 ? "bar barNegative" : "bar"} style={{ height: `${height}%` }} />
          </div>
        );
      })}
    </div>
  );
}

function TrendPanel({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>{title}</h2>
        <strong>{value}</strong>
      </div>
      {children}
    </section>
  );
}

export default async function Home() {
  const { latest, daily, hotMarkets } = await getDashboardData();
  const today = daily.at(-1);
  const hasData = Boolean(latest && daily.length > 0);

  return (
    <main>
      <header className="hero">
        <div>
          <p>42.space Public Market Dashboard</p>
          <h1>市场增长、资金流向与买卖活动</h1>
        </div>
        <div className="updateBox">
          <span>每 8 小时更新</span>
          <strong>{fullTime(latest?.last_collected_at)}</strong>
        </div>
      </header>

      {!hasData ? (
        <section className="empty">
          <h2>还没有采集数据</h2>
          <p>先在 Supabase 执行建表 SQL，再到 GitHub Actions 手动运行一次 Collect 42 Metrics。</p>
        </section>
      ) : (
        <>
          <section className="metricGrid">
            <MetricCard label="总用户" value={compactNumber(latest?.total_users)} hint="累计交易钱包数" />
            <MetricCard label="每日活跃用户" value={compactNumber(latest?.dau)} hint="当天有交易的钱包" />
            <MetricCard label="当前总市场资金" value={money(latest?.total_market_cap)} hint="Live 市场资金池" />
            <MetricCard label="每日买入量" value={money(latest?.buy_volume)} hint="MINT collateral" />
            <MetricCard
              label="净资金流入"
              value={signedMoney(latest?.net_flow)}
              hint="买入量 - 卖出量"
              tone={Number(latest?.net_flow ?? 0) >= 0 ? "good" : "bad"}
            />
            <MetricCard label="可交易市场" value={compactNumber(latest?.live_markets)} hint="status = live" />
          </section>

          <section className="trendGrid">
            <TrendPanel title="用户增长" value={`新增 ${compactNumber(today?.new_users)}`}>
              <MiniBars data={daily} field="new_users" format={compactNumber} />
            </TrendPanel>
            <TrendPanel title="市场供给" value={`新增 ${compactNumber(today?.new_markets)}`}>
              <MiniBars data={daily} field="new_markets" format={compactNumber} />
            </TrendPanel>
            <TrendPanel title="净资金流入" value={signedMoney(today?.net_flow)}>
              <MiniBars data={daily} field="net_flow" format={money} />
            </TrendPanel>
            <TrendPanel title="交易集中度" value={percent(today?.top5_volume_share)}>
              <MiniBars data={daily} field="top5_volume_share" format={percent} />
            </TrendPanel>
          </section>

          <section className="tablePanel">
            <div className="panelHeader">
              <h2>最近一个月每日指标</h2>
              <strong>{daily.length} 天</strong>
            </div>
            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>总用户</th>
                    <th>新增用户</th>
                    <th>DAU</th>
                    <th>新增市场</th>
                    <th>买卖总额</th>
                    <th>买入</th>
                    <th>卖出</th>
                    <th>净流入</th>
                    <th>活跃市场</th>
                    <th>Top5 交易占比</th>
                  </tr>
                </thead>
                <tbody>
                  {daily
                    .slice()
                    .reverse()
                    .map((item) => (
                      <tr key={item.date}>
                        <td>{shortDate(item.date)}</td>
                        <td>{compactNumber(item.total_users)}</td>
                        <td>{compactNumber(item.new_users)}</td>
                        <td>{compactNumber(item.dau)}</td>
                        <td>{compactNumber(item.new_markets)}</td>
                        <td>{money(item.daily_volume)}</td>
                        <td>{money(item.buy_volume)}</td>
                        <td>{money(item.sell_volume)}</td>
                        <td className={item.net_flow >= 0 ? "positive" : "negative"}>{signedMoney(item.net_flow)}</td>
                        <td>{compactNumber(item.active_markets)}</td>
                        <td>{percent(item.top5_volume_share)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="tablePanel">
            <div className="panelHeader">
              <h2>热门市场</h2>
              <strong>24 小时变化</strong>
            </div>
            <div className="hotGrid">
              {hotMarkets.map((market) => (
                <article className="hotCard" key={market.id}>
                  <span>{market.metric_type}</span>
                  <h3>{market.question}</h3>
                  <p>{market.outcome_name ?? "All outcomes"}</p>
                  <strong>{compactNumber(market.metric_value, 2)}</strong>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
