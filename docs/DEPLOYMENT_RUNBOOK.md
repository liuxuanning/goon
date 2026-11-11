# Goon 安全部署与回滚手册（模板，尚未在生产执行）

## 现状
- AIproduct 工作区：`<local-project-directory>`
- 现有公开站点：`http://<production-host>/goon/`，浏览器检查仍是旧界面（有“跨平台潜力”文案）；新代码**尚未部署**。
- 项目中未找到可用于该生产 IP 的 SSH 主机配置、生产部署凭证或明确的目录归属。本手册不代表已取得生产服务器授权。
- 生产目前是 HTTP 明文。**在配置 HTTPS 之前，不得在公开站点输入审核员令牌、豆包 Key 或其他凭证。**
- 本地仅提供模板与包，不能声称实现了无人值守生产部署。

## 0. 部署前必要确认
1. 服务器操作系统、SSH 接入身份、生产目录、服务管理器、反向代理位置。
2. 真实域名和 TLS 证书；仅使用 IP 直接开启不可信证书不构成安全上线。
3. 原生产进程备份、数据库路径、现有数据保留方式、上一次可用版本目录。
4. 两人各自持有不同 `GOON_REVIEWER_A_TOKEN` / `GOON_REVIEWER_B_TOKEN`；生产需在服务器 Secret 管理中分别生成，切勿复制到 ZIP 或提交 Git。
5. 生产必须配置 `GOON_REQUIRE_HTTPS=1`；反向代理仅可信地设置 `X-Forwarded-Proto: https`。

## 1. 生成发布包（工作区操作）
```bash
python scripts/integration-smoke.py
python scripts/build-release.py
```
ZIP 固定白名单打包，不包含 `.env`、SQLite 文件、用户评论、历史快照或密钥。
版本切换应先在服务器新目录 `releases/<版本>` 完成，再原子切换 `current` 软链接；禁止在旧目录原地覆盖。

## 2. 服务器环境变量
在权限严格的服务器配置文件（模板 `/etc/goon/goon.env`）设置：
```text
GOON_PORT=4173
GOON_SQLITE_BIN=/usr/bin/sqlite3
GOON_DB_FILE=/var/lib/goon/goon.sqlite3
GOON_BACKUP_DIR=/var/backups/goon
GOON_REQUIRE_HTTPS=1
ARK_API_KEY=<从服务器 Secret 安全注入>
ARK_BASE_URL=<方舟兼容接口>
ARK_MODEL=<已有豆包模型>
GOON_REVIEWER_A_TOKEN=<仅审核员A持有>
GOON_REVIEWER_B_TOKEN=<仅审核员B持有>
```
生产数据库必须放在版本目录**之外**，以免换版本导致历史丢失。不要把密钥复制进本地 `README`、systemd 单元或发布 ZIP。

## 3. TLS、进程与定时任务
- `deploy/nginx-goon.conf.template`：`/goon/` 映射到本机 `127.0.0.1:4173`；上线前替换域名并配置可信 HTTPS 证书。
- `deploy/goon-app.service.template`：只在本机监听 HTTP，外部只能经 HTTPS 代理访问。
- `deploy/goon-sync.service.template` 与 `deploy/goon-sync.timer.template`：**待管理员安装启用**，模板按北京时间每天 09:00 执行一次同步与数据库备份。
- 安装或启动服务前：确保 `goon` 用户可以读 release、读 Secret、写 `/var/lib/goon` 和 `/var/backups/goon`。
- 如需调整采集频率，先考虑数据源服务条款、API 配额和异常重试，不并行跑相同采集任务。

## 4. 切换前后验证
1. 对原数据库执行 `node scripts/backup-db.mjs`，确认备份完整性为 `ok`。
2. 执行 `node --check server.mjs`、`node --check opportunity.mjs`。
3. 在**隔离测试数据库**上执行 `python scripts/integration-smoke.py`。
4. 先在新 release 运行服务，检查 `node scripts/healthcheck.mjs`；核对应用数量、快照数量、来源。
5. 通过 HTTPS 查看前端的新“机会证据与双人复核”面板；使用两套不同生产令牌进行最小非破坏性授权检查。验证不带令牌 POST 返回 401。
6. 检查同步日志 `GET /api/sync-runs`（需审核员令牌），确认失败没有被当作成功。
7. 仅当以上验证通过，再切换反向代理 / 软链接到新版本；保留旧版和数据备份以便回滚。

## 5. 回滚
- 程序回滚：停止新进程、恢复旧 release 软链接、重启服务、运行 healthcheck。
- 数据库：schema 为增量建表，默认不要回滚数据。只有确实出现不可兼容数据变更且已核实备份时，管理员才执行恢复。恢复前必须停写并保存故障现场。
- 审核与证据表不允许直接清空；回滚不能篡改审计历史。

## 尚未验证 / 尚未交付
- 生产服务器 SSH/权限、TLS/域名、实际反向代理配置、systemd 定时任务执行、远端备份恢复、线上新版本运行。
- Product Hunt Token 尚未配置；Reddit 自动采集未接通（可人工提交带来源的记录）。
- 当前已收集的样本只有约两天历史，不能得出持续增长结论。
