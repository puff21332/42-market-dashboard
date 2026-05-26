# 42 Market Dashboard

公开版 42.space 市场健康度看板。它用 GitHub Actions 每 8 小时采集一次 42.space REST API 数据，写入 Supabase，再由 Vercel 部署的 Next.js 页面读取聚合结果。

## 指标

- 总用户、每日新增用户、每日活跃用户
- 总市场数、每日新增市场、当前可交易市场数
- 累计交易量、每日交易量、买入量、卖出量、净资金流入、当前总市场资金
- 每日活跃市场数、Top 5 市场交易量占比、Top 5 市场资金占比、热门市场

## 部署步骤

1. 在 Supabase 创建项目。
2. 打开 Supabase SQL Editor，执行 `supabase/schema.sql`。
3. 在 GitHub 仓库设置 Actions secrets：
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. 把 `github-workflows/collect.yml` 复制到 `.github/workflows/collect.yml`。
5. 到 GitHub Actions 手动运行一次 `Collect 42 Metrics`。
6. 在 Vercel 导入这个 GitHub 仓库，设置环境变量：
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
7. 部署完成后，公开页面会读取 Supabase 里的聚合数据。

当前推送用的 GitHub token 没有 `workflow` scope，所以真正的 `.github/workflows/collect.yml` 需要在 GitHub 网页上创建，或给 `gh` 刷新 workflow 权限后再提交。

## 采集频率

默认 GitHub Actions 每天运行 3 次：

- 00:10 UTC
- 08:10 UTC
- 16:10 UTC

对应北京时间：

- 08:10
- 16:10
- 00:10

## 首次补历史数据

普通运行默认只抓每个 live / ended / resolved 市场最近 3 页 activity，适合 8 小时增量更新。

如果要尽量补历史，在 GitHub Actions 手动运行时可以改：

- `max_activity_pages`: `50` 或更高
- `activity_statuses`: `live,ended,resolved,finalised`

注意：补历史会更慢，可能接近 GitHub Actions 的超时时间。可以分多次运行，数据会按交易哈希去重。

## 数据口径

- 总用户：历史上至少交易过一次的钱包数
- 每日新增用户：当天第一次交易的钱包数
- 每日活跃用户：当天至少交易过一次的钱包数
- 每日交易量：当天 `MINT + REDEEM` 的 collateral 总和
- 净资金流入：当天 `MINT collateral - REDEEM collateral`
- 当前总市场资金：当前 `status = live` 市场的 `totalMarketCap` 总和

## 本地运行

这个项目不要求你本地运行。代码可以直接推到 GitHub，由 GitHub Actions 和 Vercel 在云端执行。

Last workflow refresh: 2026-05-26T11:38:20Z
