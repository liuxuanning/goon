# Goon 新品趋势雷达

这是一个给两人产品团队使用的本地新品发现工具。它把“新品排行”变成可持续积累的每日快照，并把候选、噪声、需求聚类与证据放在同一个界面里。

## 打开方式

在本目录运行：

```powershell
npm start
```

然后打开 <http://127.0.0.1:4173>。

## 当前能力

- 真实数据为空时显示空状态，不以示例应用或模拟趋势填充真实机会列表。
- 一键同步 Google Play 公开新品榜和 Apple 官方 App Store RSS；首次同步不会伪造增长率。
- Product Hunt 官方接口已预留，通过服务器环境变量 `PRODUCT_HUNT_TOKEN` 启用；未配置时会明确提示。
- 导入 CSV 或 JSON 榜单，保存在浏览器本地。
- 搜索、筛选、连续上升/跨平台/候选视图。
- 根据名称、描述和类别进行可解释的需求聚类；同一需求同时出现在 Android 与 iOS 时标记跨平台信号。
- 通过 Apple 官方 Lookup 接口记录 App Store 评分和评分数量，并随每日快照计算增量。
- 通过 Apple Lookup 与 Google Play 官方详情页补全产品描述、开发者、评分、类别和更新时间；字段同时记录来源与采集时间。
- 使用服务器环境变量中的豆包模型进行批量需求提取；保存输入哈希、模型、提示词版本、逐字证据校验和人工复核状态，AI 结果不会直接替代原始数据。
- 启动时自动读取本目录 `.env`（文件已在 `.gitignore` 中排除）；豆包配置使用 `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_MODEL`，SQLite 使用 `GOON_SQLITE_BIN`、`GOON_DB_FILE`。生产环境应通过部署 Secret 注入，不要提交 `.env`。
- 查看排名轨迹、证据时间线、相邻竞品与评论主题。
- 加入候选或标记噪声。

## 导入字段

CSV 首行可使用：`name,source,platform,country,rank,category,launchDate,rating,ratingCount,url`。

公开榜单只是需求线索，不代表收入、留存或产品机会已经成立。建议积累至少 7 天快照，再结合评论、搜索趋势和付费验证做判断。

生产环境使用独立 SQLite 数据库。通过 `GOON_SQLITE_BIN` 指定 SQLite 3.54.1 可执行文件，通过 `GOON_DB_FILE` 指定数据库路径；未设置时，本地开发仍使用 JSON 快照。

当采集节点与网站服务器分离时，可使用 `node scripts/import-snapshots.mjs <快照文件>` 将经过核验的快照事务性写入生产 SQLite；脚本只按“日期 + 来源”更新对应快照，不删除其他历史数据。

## 证据与双人复核
- 在应用详情侧栏打开“机会证据与双人复核”，使用两名不同审核员的服务端令牌（`GOON_REVIEWER_A_TOKEN`、`GOON_REVIEWER_B_TOKEN`）。令牌只能在 HTTPS 或本机 localhost 中输入。
- 支持人工登记真实评论、社区讨论、价格、竞品、搜索趋势等**带原文和公开 URL**的证据；全部初始为 pending。
- App Store 应用可以通过 Apple 官方 Customer Reviews RSS 最多一次收集 10 条公开评论；导入仍为 pending，须人工核实原文和上下文。Reddit 自动采集与 Product Hunt 令牌尚未配置。
- 审核员不能交叉核实自己提交的证据；两个独立身份各自提交一次正式结论，后续不能静默覆盖。
- “共享候选”与任务分配已经写入 SQLite 的 `candidate_workflow`，支持状态、负责人（审核员A/B）和备注；`GET/POST /api/candidates` 均须登录。现有浏览器 localStorage 的旧候选没有自动合并到共享库，避免错误覆盖多人数据。
- 五维评分权重：需求 30%、增长 25%、付费 20%、竞争 15%、OPC 可行性 10%。必须有至少 7 期历史、3 个独立域名、已核验的用户反馈/价格/竞品来源及两份完整独立评价才输出人工参考分；**不是成功概率**。
- `GET /api/opportunities/<URL编码的产品ID>` 查看证据、审核、评分门槛和审计日志；`POST` 支持 `evidence`、`verify`、`review`、`appleReviews` 动作（必须授权）。
- 同步与豆包分析 POST 也必须携带审核员令牌。同步历史见 `GET /api/sync-runs`。

## 验证与发布
```powershell
python scripts/integration-smoke.py
node scripts/backup-db.mjs
node scripts/healthcheck.mjs
python scripts/build-release.py
```
发布包位于 `dist/goon-release.zip`，严格排除密钥和数据库。生产部署条件、HTTPS、安全验证、定时任务和回滚步骤见 `docs/DEPLOYMENT_RUNBOOK.md`。目前**尚未部署到线上站点**，不要在现有 HTTP 站点输入任何令牌。
