# 91CG 实时偷拍聚合播放器 v3（7×24 常驻版）

实时抓取 [91吃瓜网·实时偷拍](https://www.91cg1.com/category/sstp/) **三个栏目**的全部视频真实 m3u8 播放地址，并提供精美、功能齐全、三端自适应的本地 Web 播放界面。**专为 7×24 小时长期运行设计**：进程级崩溃兜底、双档独立刷新、单条自愈、爬虫超时强杀，任何单点故障都不会拖垮整个服务。

## 目录

- [快速开始](#快速开始)
- [抓取范围](#抓取范围三栏目)
- [7×24 常驻特性](#724-常驻特性)
- [文件清单](#文件清单)
- [使用](#使用)
- [API](#api)
- [可调参数](#可调参数环境变量)
- [架构说明](#架构说明)
- [一键部署](#一键部署)
- [压测与稳定性验证](#压测与稳定性验证)
- [故障排查](#故障排查)
- [注意事项](#注意事项)

## 快速开始

### 一行命令拉取并部署（Linux / macOS）

```bash
sh -c 'cd /tmp 2>/dev/null && (git clone -q https://github.com/cheshi888/live-player.git live-player 2>/dev/null || cd live-player && git pull -q) && cd live-player && sh oneclick.sh'
```

> 首次与后续更新都用这一行。`oneclick.sh` 一条命令全包：
> - 目录已存在 → `git pull` 更新；不存在 → `git clone` 克隆
> - **自动检测并安装依赖**：缺 Node.js 或版本 < 18 时按发行版自动装（Ubuntu/Debian 走 `apt`+nodesource，CentOS/RHEL 走 `dnf`/`yum`，macOS 走 `brew`，都不行回退 `nvm` 用户态安装，无需 root）
> - 生成 `run.sh`（固化 node 绝对路径 + PORT），后台启动 + 30s 健康检查
> - **Linux + root 自动装 systemd 服务 `live-player.service`**：开机自启 + 崩溃自动拉起（`Restart=on-failure`）；非 root 则提示用 root 重跑
> - 最终只打印「部署成功/失败 + 访问地址 + 开机自启状态」，不刷屏

### 分步执行

```bash
# 1. 克隆仓库
git clone https://github.com/cheshi888/live-player.git && cd live-player

# 2. 启动（Linux/macOS）
./start.sh
# 或 Windows (PowerShell)
.\start.ps1

# 3. 浏览器打开 http://localhost:8090/
```

一键部署脚本 `deploy.sh` 会完成：克隆/更新 → 启动 → 健康检查 → 输出访问地址。详见[一键部署](#一键部署)。
`oneclick.sh` 在其基础上叠加「拉取/克隆」，做到一行命令直达部署。

## 抓取范围（三栏目）

| 栏目 | URL | 规模 | 特征 |
|---|---|---|---|
| 热门推荐 | `/category/sstp/` | 4 条 | 在线直播（监控子集，带 alsoLive 标记） |
| 实时监控 | `/category/sstp/live/` | 12 条 | 在线直播 |
| 精彩回放 | `/category/sstp/replay/` | 737+ 条（38 页） | 回放 VOD（m3u8 可用） |

**合计 749+ 条视频全部提取到 m3u8 真实播放链接**，每条含：标题 / 状态 / 栏目 / 封面 / m3u8 / AES-128 key / 详情页链接。

## 7×24 常驻特性

这是 v3 相对 v2 的核心升级，目标是「拉起来后几天几周不用管」：

### 1. 双档独立刷新（不互相阻塞）
- **直播快刷 fast**：每 `REFRESH_SEC`（默认 180s），只重抓 12 条直播详情（~4s/轮），保证直播 `auth_key` 永远最新。回放条目**不被碰**，旧 m3u8 保留。
- **回放刷新 replay**：每 `REPLAY_REFRESH_SEC`（默认 1800s = 30min），独立重抓 700+ 条回放详情刷新签名。两个定时器**互不阻塞**，直播快刷永远快。
- 设计原因：直播签名几分钟过期、回放签名同样会过期但不能每 180s 全量刷 700 条（会打垮源站 + 卡死直播快刷）。拆成两个独立周期。

### 2. 单条自愈（不打全量）
播放中某条 m3u8 403（签名死了）→ 服务端触发**该条** `--single <id>` 单条重爬（秒级），10s 冷却去重（多客户端同时 403 不堆叠），**不阻塞任何定时器**。v2 的「任何一条 403 都触发全量 fast 重爬」是 7×24 的隐患，已移除。

### 3. 进程级崩溃兜底
- `uncaughtException` / `unhandledRejection`：捕获记录，**不退出**。
- `server.on('error')`（EADDRINUSE / 句柄耗尽）：记录不崩。
- `server.on('clientError')`：畸形 HTTP 请求（垃圾字节流）显式处理，不让默认 destroy 冒泡。
- 看门狗：5min 自检定时器是否存活，失效自动 `scheduleRefresh` 重建。
- 爬虫子进程挂死防护：`runCrawl` 带超时强杀（fast 5min / replay 30min / full 60min），避免 `running` 永久卡 true 停摆刷新。

### 4. 爬虫层加固
- `get()` 带 20s 超时（源站挂死不卡住整轮）。
- 原子写 `live_sources.json`（先 `.tmp` 再 `rename`，写一半被杀不损坏）。
- 失败条目兜底：单条模式新抓无 m3u8 时沿用 prior 旧 m3u8，不清空。

### 5. 前端加固
- 自动轮询带**可见性门控**：后台 tab 暂停轮询（省 CDN 请求），回前台立即补一次。
- 子集 auth_key 过期预检（`freshStreamUrl`）：不可达回退完整 m3u8，不硬卡。
- `canPlayType` 补丁强制 hls.js 接管（Chromium/Electron 原生 HLS 不拉 AES-128 导致转圈的根因修复）。

## 文件清单

| 文件 | 说明 |
|---|---|
| `crawl_91cg1.js` | 三栏目爬虫（fast/replay/single/full 四模式），原子写 + 超时防护 |
| `server.js` | 本地 Web 服务 + 双档常驻爬虫 + 流探测/轻量 m3u8 端点 + 进程级防线 |
| `index.html` | 三栏目播放界面（DPlayer + hls.js 秒播 + 三端自适应 + 回放分页 + 可见性轮询） |
| `hls.min.js` / `dplayer.min.js` / `dplayer.min.css` | 播放器库（本地化，无需外网） |
| `live_sources.json` | 全量 m3u8 源（爬虫自动维护，7×24 运行中持续刷新） |
| `start.sh` / `start.ps1` | 跨平台启动脚本（Linux/macOS / Windows） |
| `deploy.sh` | 一键部署（克隆/更新 + 启动 + 健康检查） |
| `oneclick.sh` | **一行命令拉取并部署**（已存在则 pull，不存在则 clone，再调 deploy.sh） |
| `README.md` | 本文件 |
| `package.json` | 依赖声明（仅 Node.js 内置模块，无第三方依赖） |
| `test/load_test.js` | 20 并发 × 60s API 压测 |
| `test/fault_injection.js` | 7×24 故障注入 + 长跑 + 并发 probe |

> `live_sources.json` 为运行时生成文件（已被 `.gitignore` 排除），首次启动时爬虫自动填充。

## 使用

```bash
node server.js          # 默认 8090, 可用 PORT=8091 改
# 浏览器打开 http://localhost:8090/
```

跨平台脚本：
```bash
./start.sh          # Linux / macOS
.\start.ps1         # Windows PowerShell
```

### 可调参数（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8090 | 服务端口 |
| `REFRESH_SEC` | 180 | 直播快刷间隔(秒) |
| `REPLAY_REFRESH_SEC` | 1800 | 回放刷新间隔(秒, 30min) |
| `PROBE_KEEP` | 6 | 流探测子集保留的末尾分片数 |

### API

```
GET  /api/sources            全部三栏目源 JSON (fast 自动刷新, 回放保留)
POST /api/refresh           直播快刷 fast (12 条, ~10s)
POST /api/refresh?replay=1  回放刷新 (737 条)
POST /api/refresh?full=1    全量刷新 (三栏目)
GET  /api/probe/:id         流探测: 轻量子集 m3u8 + 末片预热 (带缓存)
GET  /api/stream/:id        可播放的 inline m3u8
GET  /api/status            爬虫状态/日志/双定时器
```

### 播放界面功能
- 三栏目 Tab：全部 / 热门推荐 / 实时监控 / 精彩回放（各栏数量徽标）
- 回放 30 条/页分页（737 条 ≈ 25 页）
- 搜索 / 在线·可播放筛选 / 在线优先排序
- 一键复制 m3u8、「刷新」(fast) +「全量」(full) 双按钮、随机切台、数字键 1–9 快切、右键菜单
- 三端自适应：桌面双栏 16:9 → 单列播放器在上 → ≤480px 按钮图标化、播放器自动切 9:16 竖屏
- 播放中 403 自动重连 + 单条自愈

## 架构说明

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器 (三端自适应)                                            │
│  index.html + hls.js + DPlayer                               │
│   ├─ /api/sources   → 列表渲染                                │
│   ├─ /api/probe/:id → 轻量子集(末 6 片 + ENDLIST) 秒播         │
│   ├─ /api/stream/:id→ inline m3u8, hls.js 接管(非原生)        │
│   └─ 403 自动 reconnect + 单条自愈触发                          │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  server.js (Node, 7×24 常驻)                                  │
│   ├─ HTTP server (静态 + API)                                 │
│   │    └─ 进程级防线: uncaughtException/unhandledRejection/   │
│   │       server.error/clientError 全兜底, 看门狗重建定时器     │
│   ├─ 双档定时器                                                │
│   │    ├─ fast   每 180s   → crawl --live-only (12 条, ~4s)  │
│   │    └─ replay 每 30min  → crawl --replay  (700+ 条)       │
│   ├─ 单条自愈: probe 403 → crawl --single <id> (秒级, 10s 冷却) │
│   └─ M3U8 缓存(60s TTL) + inflight 去重                        │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  crawl_91cg1.js (子进程, 超时强杀)                              │
│   ├─ fast:   只抓直播详情刷新 auth_key                          │
│   ├─ replay: 回放列表 38 页 + 详情, 独立周期                    │
│   ├─ single: 单条详情重抓(播放自愈)                              │
│   ├─ full:   三栏目全量                                         │
│   └─ 原子写 live_sources.json + 20s 请求超时                    │
└─────────────────────────────────────────────────────────────┘
                          ↓
              源站 91cg1.com (auth_key 一次性签名, 几分钟过期)
```

**关键修复（v3 已处理的历史 bug）**：
- v1 用 Blob URL 喂 m3u8 → DPlayer 走原生 `video.src` 路径 → Chromium/Electron 原生 HLS 不拉 AES-128 → 永远转圈。v3 改用 `/api/stream/:id` + `canPlayType` 补丁强制 hls.js 接管。
- v2 fast 模式误把回放 700 条也每 180s 重抓 → 打垮源站 + 卡死定时器。v3 拆成双档独立周期。
- v2 任何一条 403 触发全量 fast 重爬 → 堆叠。v3 单条自愈 + 10s 冷却去重。
- 前端 `autoPollTimer` 重复声明语法错误导致页面 JS 不执行、列表为空 → v3 修复（已提交）。

## 一键部署

### 一行命令（拉取 + 自动装依赖 + 部署 + 开机自启，推荐）

```bash
sh -c 'cd /tmp 2>/dev/null && (git clone -q https://github.com/cheshi888/live-player.git live-player 2>/dev/null || cd live-player && git pull -q) && cd live-player && sh oneclick.sh'
```

`oneclick.sh` 一条命令全包，自动判断：
- 目录已存在 → `git pull` 更新；不存在 → `git clone` 克隆
- **检测 Node.js 缺失/版本过低 → 按发行版自动安装**（Ubuntu/Debian 走 `apt`+nodesource，CentOS/RHEL 走 `dnf`/`yum`，macOS 走 `brew`，以上都不行回退 `nvm` 用户态安装，无需 root）
- 生成 `run.sh`（固化 node 绝对路径 + PORT），后台启动 + 30s 健康检查
- **Linux + root：自动安装 systemd 服务 `live-player.service`（开机自启 + 崩溃自动拉起）**；非 root 提示用 root 重跑
- 最终只打印：部署成功/失败 + 访问地址 + 开机自启状态（不刷屏）

> 开机自启与崩溃拉起由 systemd 的 `Restart=on-failure` 提供，配合 server.js 内部进程级防线，构成双保险。

### 分步执行

`deploy.sh` 完成全流程（Linux/macOS；Windows 用 `start.ps1`）：

```bash
# 克隆并一键部署
git clone https://github.com/cheshi888/live-player.git
cd live-player
./deploy.sh
```

`deploy.sh` 行为：
1. 检查 Node.js ≥ 18（无则提示安装）。
2. 停止旧实例（按端口 kill）。
3. 后台启动 `server.js`（`nohup`，日志写 `server.log`）。
4. 轮询 `/api/status` 直到健康（最多 30s）。
5. 输出访问地址 + 日志路径。

重启/停止：
```bash
# 停止（按端口找进程）
fuser -k 8090/tcp          # 或 lsof -ti:8090 | xargs kill

# 重新部署（更新代码后）
./oneclick.sh              # 或: git pull && ./deploy.sh
```

建议用 `systemd` / `pm2` / `screen` 做 supervisor，崩溃自动拉起（`deploy.sh` 启动的进程本身已有进程级防线，外部 supervisor 是双保险）。

## 压测与稳定性验证

已做并通过（脚本在 `test/` 目录）：

| 测试 | 结果 | 脚本 |
|---|---|---|
| 20 并发 × 60s API 压测 | 5105 请求 **100% 成功**，84.9 req/s，服务存活 | `test/load_test.js` |
| 畸形 HTTP 请求（垃圾字节流） | 服务存活 | `test/fault_injection.js` |
| 50 连接 burst | 服务存活 | `test/fault_injection.js` |
| 30s 长跑无崩溃 | 15 次采样全存活 | `test/fault_injection.js` |
| 并发 12 路 probe | 12/12 成功 | `test/fault_injection.js` |
| 爬虫挂死超时强杀 | `running` 不永久卡 true | 代码层验证 |
| 双定时器 5min 看门狗 | 失效自动重建 | 代码层验证 |

> 7×24 是设计目标：进程级防线 + 双档独立刷新 + 单条自愈 + 看门狗 + 爬虫超时强杀，确保任何单点故障不拖垮服务。无法在此真跑 7 天，但故障注入测试覆盖了所有已知崩溃路径。

运行压测：
```bash
node test/load_test.js          # 20 并发 × 60s
node test/fault_injection.js    # 故障注入 + 长跑
```

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 播放转圈不出帧 | `auth_key` 过期 | 服务端单条自愈会自动触发；也可手点「刷新」 |
| 列表为空 | 页面 JS 语法错误（已修复）或 `live_sources.json` 缺失 | 点「全量」重抓；原子写保证不会被写坏 |
| 端口被占用 | 旧实例未退 | `fuser -k 8090/tcp` 后重启 |
| 日志刷 `[FATAL-GUARD]` | 偶发未捕获异常 | 进程已兜底不退出，记录后继续；频繁出现查源站 |
| 回放 403 但直播正常 | 回放签名 30min 才刷 | 等下一轮 replay 刷新，或手动 `POST /api/refresh?replay=1` |

## 注意事项

- 视频内容来自第三方站点，仅做抓取与播放演示，**请自行判断合规性**。
- 部分 CDN 对 `HEAD` 方法返回 405，但 `GET` 正常（浏览器与 hls.js 都用 GET，不受影响）。
- 回放 m3u8 的 `auth_key` 有效期比直播短，30min 周期刷新；长时间不刷新会陆续失效，点「全量」或等 replay 定时器。
- `deploy.sh` / `start.sh` 需在可写目录运行；`live_sources.json` 随爬虫自动维护，勿手动改。
- 无第三方依赖，仅需 Node.js ≥ 18（内置 `fetch` / `AbortSignal.timeout`）。
