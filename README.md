# Goon 新品趋势雷达

这是一个给两人产品团队使用的本地新品发现工具。它把“新品排行”变成可持续积累的每日快照，并把候选、噪声、需求聚类与证据放在同一个界面里。

## 打开方式

在本目录运行：

```powershell
npm start
```

然后打开 <http://127.0.0.1:4173>。

## 当前能力

- 内置 10 条明确标注的示例数据，用来体验完整筛选流程。
- 一键同步 Google Play 公开新品榜和 Apple 官方 App Store RSS；首次同步不会伪造增长率。
- Product Hunt 官方接口已预留，通过服务器环境变量 `PRODUCT_HUNT_TOKEN` 启用；未配置时会明确提示。
- 导入 CSV 或 JSON 榜单，保存在浏览器本地。
- 搜索、筛选、连续上升/跨平台/候选视图。
- 根据名称、描述和类别进行可解释的需求聚类；同一需求同时出现在 Android 与 iOS 时标记跨平台信号。
- 通过 Apple 官方 Lookup 接口记录 App Store 评分和评分数量，并随每日快照计算增量。
- 查看排名轨迹、证据时间线、相邻竞品与评论主题。
- 加入候选或标记噪声。

## 导入字段

CSV 首行可使用：`name,source,platform,country,rank,category,launchDate,rating,ratingCount,url`。

公开榜单只是需求线索，不代表收入、留存或产品机会已经成立。建议积累至少 7 天快照，再结合评论、搜索趋势和付费验证做判断。

生产环境使用独立 SQLite 数据库。通过 `GOON_SQLITE_BIN` 指定 SQLite 3.54.1 可执行文件，通过 `GOON_DB_FILE` 指定数据库路径；未设置时，本地开发仍使用 JSON 快照。
