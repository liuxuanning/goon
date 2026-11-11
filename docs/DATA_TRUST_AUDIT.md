# Goon 数据可信度首轮审计

审计时间：2026-11-11。范围：线上页面可见状态、`server.mjs`、`public/app.js`、`index.html`、`data/snapshots.json`、本地测试 SQLite。

## 已观察到的事实
- JSON 快照文件含 4 个快照记录，日期为 2026-11-10、2026-11-11；来源为 Google Play 新品榜和 App Store，各 2 天。
- App Store 每日 100 条，字段来自 Apple 新应用 RSS 与 Apple Lookup；RSS 中的 `rank` 实为 Feed 序号，不是市场排名。
- Google Play 每日 10 条，榜单页面来源为 AppsXRay，详情字段尝试由 Google Play 官方详情页补齐。
- 最近 Google Play 快照有 1 条缺少描述、1 条缺少开发者，10 条未获取上线日期。
- Product Hunt 采集需 `PRODUCT_HUNT_TOKEN`，当前快照中无 Product Hunt 记录。
- SQLite schema 已包含 snapshots、candidates、labels、app_analysis、activity_logs、sync_runs；本地 `test-analysis.sqlite3` 当前有 4 条快照、2 条分析记录，其余协作/日志表为空。

## 首要风险
1. `public/app.js` 原先内置示例应用，且真实 API 返回空数组时回退到示例数据，可能把演示内容误认为真实机会。
2. 趋势详情原先在快照不足时使用固定模拟数列绘制曲线，制造不存在的历史轨迹。
3. `buildTrackedApps` 将 7 天窗口中首末榜单位置差值作为趋势变化；对榜单定义变更、缺失日期、榜单截断和不同国家/平台的可比性尚无严格校验。
4. `classifyDemand` 是基于名称、subtitle、category 的关键词规则；类别回退不能证明需求，跨平台信号也只基于同一规则标签。
5. `dataStatus` 把开发者/描述缺失与历史不足混合为单一状态，质量问题原因不够可解释。
6. AI 证据仅做规范化后的子串检查；没有证据字符区间、逐项输出完整性/重复 ID 校验、复核人身份和复核历史接口。
7. `candidates`、`labels`、`activity_logs`、`sync_runs` 虽已建表，但当前界面/接口尚未形成完整双人协作闭环。
8. 本地 CSV/JSON 导入与候选标记使用浏览器 localStorage，不等同于服务端持久化和多人共享。
9. 服务监听地址为 `127.0.0.1`；线上可访问性依赖外部部署/反向代理配置，本轮未验证生产鉴权、TLS、备份和部署流水线。

## P0 整改原则
- 真实数据为空时显示空状态，不回退示例数据。
- 没有至少两个有效快照时不绘制趋势曲线。
- 位置字段使用 `source_position`/`feed_position` 等语义，避免笼统称市场排名。
- 对来源、国家、平台、榜单类型、榜单版本、采集时间建立可比性边界。
- 数据质量、趋势成熟度、需求证据成熟度分开表达。
- 所有缺失保持 null，并显示具体缺失原因。

## 本轮已完成的 P0 改动
- 前端默认不再加载内置示例应用；API 返回空列表时展示真实空状态，不再把示例数据当作真实记录。
- 移除了详情趋势图的固定模拟数列；不足 2 个有效历史快照时不绘制趋势曲线。
- “跨平台潜力/跨平台需求”统一改为“跨平台线索”，并明确提示规则匹配结果仍需人工核验。
- 连续上升判断增加相邻自然日校验，缺少中间日期的快照不再被视为连续日增长。
- CSV/JSON 导入状态文案明确标记为“仅当前浏览器”，不再与示例数据混称。

## 验证结果
- `node --check`：server.mjs、public/app.js、scripts/import-snapshots.mjs 均通过。
- 本地 HTTP 冒烟测试：`/`、`/app.js`、`/api/apps`、`/api/snapshots` 均返回 HTTP 200。
- `/api/apps` 返回 110 条基于快照构建的记录，未发现 `isSample` 示例记录。
- 本轮未执行生产部署。AIproduct 本地运行环境已配置 SQLite 和豆包；Product Hunt Token 尚未配置。项目目录未发现 Docker/CI 工作流配置。不能据此推断生产主机配置，部署链路仍需单独核验。

## 尚未完成的关键整改
- 已将字段完整度、历史成熟度、来源可信度拆成独立质量维度，并显示缺失字段与补全失败原因。
- 为快照补充榜单定义/国家/平台/采集批次标识，严格限定排名可比性。
- 增加采集任务运行日志、失败重试、数据去重和来源变更告警。
- 已增加豆包返回 ID 完整性/重复 ID 校验、证据字符区间、输入哈希、模型/提示词版本与未审核状态；双人身份和复核历史仍待实现。
- 将候选、导入、标签、复核与决策从 localStorage 迁移到服务端协作存储。
- 验证生产 API 鉴权、TLS、备份恢复、部署和回滚流程。

## 本轮代码变更
- 已移除前端内置示例应用作为默认/空数据回退来源，应用列表只展示 API 返回的真实快照记录。
- 趋势图无历史数据占位和数据质量分层已完成；采集运行日志、双人协作与生产部署核验仍待实现。

## 2026-11-11 后续实施记录
- 豆包配置：从 GEO 项目现有 `.env` 安全复用 `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_MODEL` 到 `goon-trend-radar/.env`；密钥未输出，目标目录 `.gitignore` 已忽略 `.env`。
- 本地 SQLite：已配置 `GOON_SQLITE_BIN`、`GOON_DB_FILE`，首次启动将 4 个 JSON 快照迁移到 `data/goon.sqlite3`；数据库文件已加入忽略规则。
- 豆包连通性：实际 Chat Completions 请求 HTTP 200，模型返回 `doubao-seed-2-0-pro-260215`。
- 需求分析端到端：豆包 API 实测 HTTP 200；已验证 3 条 demand-v3 与 3 条 demand-v4 小批次，最新 demand-v4 3/3 原文证据通过，保存输入哈希、模型、提示词版本、证据字段/字符区间和 review_status=unreviewed。10 条大批次请求曾返回 HTTP 500，前端默认批次已降为 3，后续继续观察稳定性。
- P1 字段质量：新增完整度百分比、缺失字段、历史成熟度、来源可信度和补全失败原因；数据完整度与历史成熟度不再混为一个状态。
- 最近一次同步：App Store 100 条，Google Play 新品榜 10 条；Product Hunt 因缺少 Token 未同步。App Store 与 Google Play 当前字段完整度均为 100%，但历史仅 2 天；Google Play 官方详情页在 Runner 环境连接失败，已透明回退到 AppsXRay 第三方详情页补齐字段。
- 重要边界：本地 SQLite/豆包已验证，不代表生产站点已部署或线上进程已加载新配置。
- Google Play 详情补全策略：Runner 无法连接 `play.google.com` 时，改用 AppsXRay 应用详情页的 `SoftwareApplication` JSON-LD 作为明确标注的第三方回退来源；不把第三方字段伪装成 Google 官方数据。
- 回退实测：10/10 条 Google Play 新品均成功补齐描述、开发者、上线日期、更新时间、价格等字段；9/10 有评分数量数据；元数据来源全部标记为 `AppsXRay 第三方应用详情页`。
- 当前 `/api/apps` 质量检查：App Store 100/100 条字段完整度 100%；Google Play 10/10 条字段完整度 100%；两来源历史成熟度仍只有 2 天，不能据此判断持续趋势。
- P2 趋势：应用列表改为保留观察窗口内出现过的全部应用，不因某天退出榜单而消失；`/api/apps?window=7|30` 已支持 7/30 天窗口，记录最后出现日期。当前只有 2 天历史，趋势仍显示待积累。
- 豆包审计状态：SQLite 当前保存 4 条分析（1 条 demand-v3、3 条 demand-v4），全部未审核；其中 3 条 demand-v4 当前有效且原文证据 3/3 通过，旧版本记录会标记为过期。尚有 107 条待分析候选，不自动批量消耗额度。
## 2026-11-11 机会证据/协作/发布准备验收
- 新增 `opportunity.mjs` 与 `public/opportunity-ui.js`，本地 SQLite 增加 `opportunity_evidence`、`opportunity_review`、`opportunity_assessment` 和追加式 `opportunity_audit` 表。
- 两份审核员令牌仅在忽略提交的本地 `.env`。API 拒绝未授权访问、同人自审和重复提交；同步/豆包 POST 也已经加鉴权。
- 五维评分权重：需求30%、增长25%、付费20%、竞争15%、可行性10%；必须满足至少7期历史、三个独立域名、有经人工核验的用户反馈/公开价格/竞品证据及两人全维评价，才给出人工主观分。证据不足保持 null。
- 临时库集成测试 `python scripts/integration-smoke.py` 两次通过：3种证据、3个独立域名、2人各评价5维，示例人工分80/100，审计8条；模拟数据未写入正式 SQLite。
- Apple 官方 Customer Reviews RSS 接口实测可用；对临时 App Store 测试记录抓取10条真实公开评论，全部保留 pending，不自动判为已核验。Reddit 自动采集未接通。
- 采集运行日志在 `sync_runs` 表；`GET /api/sync-runs` 需审核员令牌；采集错误信息去除可能包含凭证的命令行。
- 新增 SQLite 一致性备份及完整性检查，本地结果 ok；HTTP 健康检查读取到110条应用、4批快照。
- 构建白名单 `dist/goon-release.zip`，不包含 `.env`、SQLite、历史原始数据或令牌；systemd、定时器、Nginx/HTTPS 模板与回滚手册已创建。
- 通过浏览器检查 `http://<production-host>/goon/`：仍为旧界面且为明文 HTTP。新协作 UI 在公开 HTTP 页面阻止令牌输入；上线需先配置 TLS，并核实 SSH/服务器目录/权限。
- 生产未部署、定时器未启用，远端上线、回滚和长期稳定性仍待验。
- 已加入共享候选任务表 `candidate_workflow`，支持两位审核员在不同浏览器下查看相同任务状态、任务负责人和备注，不再把“共享候选”视为 localStorage 本地收藏。
- 临时 SQLite 集成测试再次通过：共享任务由审核员A分配给B，B通过 API 读取同一条任务；两位独立复核、跨人证据核验、缺失证据不打分均通过，共记录 9 条追加式审计事件。
- 审核凭证通过 HTTPS 或本机 localhost 传送；生产需配备可信代理头和 `GOON_REQUIRE_HTTPS=1`，当前 HTTP 站点仍不可启用敏感协作操作。
