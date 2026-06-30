# Watch Party Sync · 一起看视频同步工具

一个安静、低打扰的远程「一起看」工具，支持 bilibili 以及稀饭动漫、次元城、agefans 类等中小视频站点。它让两个或多个朋友能看到彼此的播放进度，并可选择跟随房主同步。

这是规格文档
[`docs/superpowers/specs/2026-06-30-watch-party-design.zh-CN.md`](docs/superpowers/specs/2026-06-30-watch-party-design.zh-CN.md)
所描述的 MVP 版本：一个 **Tampermonkey（油猴）脚本** 作为前端，搭配一个小型的
**Cloudflare Worker + D1** 服务作为后端，采用 HTTP 轮询（暂不使用 WebSocket）。

---

## 目录

- [Watch Party Sync · 一起看视频同步工具](#watch-party-sync--一起看视频同步工具)
  - [目录](#目录)
  - [它能做什么](#它能做什么)
  - [项目结构](#项目结构)
  - [整体架构](#整体架构)
  - [第一步：申请并配置 Cloudflare D1](#第一步申请并配置-cloudflare-d1)
    - [1.1 注册 Cloudflare 账号](#11-注册-cloudflare-账号)
    - [1.2 安装 Wrangler 命令行工具](#12-安装-wrangler-命令行工具)
    - [1.3 创建 D1 数据库](#13-创建-d1-数据库)
    - [1.4 初始化数据库表结构](#14-初始化数据库表结构)
  - [第二步：部署后端 Worker 服务](#第二步部署后端-worker-服务)
    - [2.1 本地试跑（推荐先做一遍）](#21-本地试跑推荐先做一遍)
    - [2.2 部署到线上](#22-部署到线上)
  - [第三步：安装并配置前端油猴脚本](#第三步安装并配置前端油猴脚本)
    - [3.1 安装 Tampermonkey](#31-安装-tampermonkey)
    - [3.2 添加脚本](#32-添加脚本)
    - [3.3 配置 Worker 地址（关键）](#33-配置-worker-地址关键)
    - [3.4 保存并启用](#34-保存并启用)
  - [第四步：开始使用](#第四步开始使用)
  - [本地开发与调试](#本地开发与调试)
  - [运行后端测试](#运行后端测试)
  - [API 接口说明](#api-接口说明)
  - [适配器说明](#适配器说明)
  - [安全与隐私](#安全与隐私)
  - [常见问题](#常见问题)

---

## 它能做什么

- **看到彼此进度**：房间内每个人的当前播放时间、播放/暂停状态、在线情况都会显示。
- **可选跟随房主**：
  - 自动跟随房主进度：当本地与房主时间差超过 5 秒时，自动跳转到房主位置。
  - 跟随房主播放/暂停：房主暂停或播放时，本地同步执行。
- **安静不打扰**：默认只在页面右侧显示一个半透明小圆钮，全屏播放时自动隐藏所有界面。
- **手动拖动保护**：你自己拖动进度条后，会有 8 秒不被自动拉回的保护窗口。
- **零账号**：不需要注册登录，凭随机房间码加入即可。

---

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `userscript/watch-party.user.js` | 油猴脚本（前端，所有模块打包在一个文件里）。 |
| `worker/src/index.js` | Cloudflare Worker 入口：HTTP 路由 + CORS。 |
| `worker/src/room-service.js` | 房间/参与者核心逻辑（创建、加入、状态上报与拉取）。 |
| `worker/schema.sql` | D1 数据库表结构（`rooms` 和 `participants`）。 |
| `worker/wrangler.toml.example` | 复制为 `wrangler.toml` 并填入 D1 数据库 id。 |
| `tests/` | 基于 `node:test` 的后端测试（含内存版 D1 桩）。 |
| `fixtures/` | 本地适配器测试用的 HTML 页面。 |
| `docs/` | 设计规格文档与本说明。 |

---

## 整体架构

```
┌─────────────────────┐         HTTP 轮询(每 5 秒)        ┌──────────────────────┐
│  浏览器 A (房主)     │  ── POST /rooms/:id/state ──▶    │                      │
│  油猴脚本           │  ◀── GET  /rooms/:id/state ──    │  Cloudflare Worker   │
└─────────────────────┘                                  │  + D1 数据库         │
┌─────────────────────┐                                  │  (rooms /            │
│  浏览器 B (参与者)   │  ── POST /rooms/:id/state ──▶    │   participants)      │
│  油猴脚本           │  ◀── GET  /rooms/:id/state ──    │                      │
└─────────────────────┘                                  └──────────────────────┘
```

- 前端检测当前视频，把本地播放状态上报给 Worker，并定时拉取房间状态、可选地跟随房主。
- 后端把房间与参与者状态存进 D1，职责非常轻：建房、加入、接收状态、返回状态。

---

## 第一步：申请并配置 Cloudflare D1

### 1.1 注册 Cloudflare 账号

1. 打开 [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) 注册一个免费账号。
2. 免费套餐（Workers Free Plan）即可满足本工具的用量，无需绑定信用卡也能使用 Workers 与 D1 的免费额度。

### 1.2 安装 Wrangler 命令行工具

Wrangler 是 Cloudflare 官方的部署工具，需要本地已安装 [Node.js](https://nodejs.org/)（建议 18 及以上）。

```bash
npm install -g wrangler
```

安装后登录（会打开浏览器授权）：

```bash
wrangler login
```

验证是否登录成功：

```bash
wrangler whoami
```

### 1.3 创建 D1 数据库

进入 `worker` 目录，先把配置模板复制成正式配置：

```bash
cd worker
cp wrangler.toml.example wrangler.toml
```

创建 D1 数据库：

```bash
wrangler d1 create video_sync_watch_party
```

命令成功后会输出一段类似下面的内容，**请复制其中的 `database_id`**：

```toml
[[d1_databases]]
binding = "DB"
database_name = "video_sync_watch_party"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

打开刚才复制出来的 `worker/wrangler.toml`，把里面的占位 id 替换成上面真实的 `database_id`：

```toml
name = "video-sync-watch-party"
main = "src/index.js"
compatibility_date = "2026-06-30"

[[d1_databases]]
binding = "DB"
database_name = "video_sync_watch_party"
database_id = "把这里替换成你的真实 database_id"
```

> 也可以在 Cloudflare 控制台用图形界面创建：左侧菜单 **Storage & Databases → D1 → Create database**，名称填 `video_sync_watch_party`，创建后在数据库详情页能看到它的 `database_id`。

### 1.4 初始化数据库表结构

把 `schema.sql` 应用到数据库。本地开发库和线上库要分别执行：

```bash
# 本地库（给 wrangler dev 用）
wrangler d1 execute video_sync_watch_party --local --file=./schema.sql

# 线上库（部署到生产环境用）
wrangler d1 execute video_sync_watch_party --remote --file=./schema.sql
```

这会建立 `rooms` 和 `participants` 两张表以及相关索引。

---

## 第二步：部署后端 Worker 服务

### 2.1 本地试跑（推荐先做一遍）

仍在 `worker` 目录下：

```bash
wrangler dev
```

成功后 Worker 会运行在 `http://127.0.0.1:8787`。可以用 curl 验证建房接口：

```bash
curl -X POST http://127.0.0.1:8787/rooms \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Alice"}'
```

若返回类似 `{"roomId":"AB12CD","participantId":"p_...","hostToken":"h_...","role":"host"}`，说明后端工作正常。

### 2.2 部署到线上

```bash
wrangler deploy
```

部署成功后会输出线上访问地址，形如：

```
https://video-sync-watch-party.<你的账号>.workers.dev
```

**记下这个地址**，第三步配置前端时要用到。

---

## 第三步：安装并配置前端油猴脚本

### 3.1 安装 Tampermonkey

在浏览器中安装 [Tampermonkey（油猴）扩展](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均支持）。

### 3.2 添加脚本

1. 点击浏览器工具栏的 Tampermonkey 图标 → **添加新脚本**。
2. 删除默认模板，把 `userscript/watch-party.user.js` 的全部内容粘贴进去。

### 3.3 配置 Worker 地址（关键）

在脚本顶部找到 `CONFIG` 配置块，修改这几项：

```js
const CONFIG = {
  // 本地开发用的 Worker 地址
  workerUrlLocal: "http://127.0.0.1:8787",
  // 你在第二步部署后得到的线上地址
  workerUrlRemote: "https://video-sync-watch-party.example.workers.dev",
  // 日常使用填 false（走线上）；本地调试填 true（走本地）
  useLocalWorker: false,
  // ...
};
```

把 `workerUrlRemote` 改成你自己的 `workers.dev` 地址即可。

### 3.4 保存并启用

按 `Ctrl/Cmd + S` 保存。打开脚本顶部 `@match` 列表里列出的任意一个支持站点（如 bilibili 视频页），页面右侧会出现一个半透明小圆钮。

> `@match` 列表是有意写得比较窄的。每验证好一个新站点，就把它的域名加进 `@match` 列表。

---

## 第四步：开始使用

1. 默认情况下页面上**不显示任何悬浮窗或图标**，保持干净。需要一起看时，点击浏览器工具栏的 **Tampermonkey 图标 → 菜单中的「Open Watch Party」** 呼出面板。
2. 填入你的昵称，点 **Create room（创建房间）**，你就是房主，会得到一个 6 位房间码。进房后右侧才会出现小圆钮（悬浮窗），离开房间后再次隐藏。
3. 把房间码发给朋友，朋友同样用 Tampermonkey 菜单呼出面板，点 **Join（加入）**、输入房间码即可作为参与者加入。
4. 默认情况下大家只是「互相看到进度」。参与者可以按需勾选：
   - **Auto-follow host progress**：自动跟随房主进度（漂移 > 5 秒时跳转）。
   - **Follow host play/pause**：跟随房主的播放/暂停。
5. 你自己拖动进度条后，自动跟随会暂停 8 秒，避免被立刻拉回。
6. 同一浏览器同一房间只有一个标签在「同步中」。在另一个标签打开房间会自动接管，原标签转为待机并显示「在此标签同步」按钮供你切回。
7. 如果当前页面和房主不是同一个视频，会暂停跟随，并在面板显示「跳转到一起看的视频」按钮——点它会暂停当前视频并在新标签打开房主的视频（新标签自动接管同步）。
8. 同步中的标签切到后台再切回前台时，会立即对齐到房主进度（漂移不大则不跳动）。
9. 面板约 10 秒无操作后自动收起（除非选了 **Pinned 固定** 模式）。
10. 全屏播放时，所有界面自动隐藏。
11. 点 **Leave（离开）**（或菜单里的「Leave room」）会移除全部界面，页面恢复到原始干净状态。

---

## 本地开发与调试

如果想用项目里的本地 fixture 页面测试适配器，先在仓库根目录起一个静态服务器（`file://` 协议会限制部分浏览器 API）：

```bash
npx http-server -p 5500 .
```

然后访问：

- `http://127.0.0.1:5500/fixtures/direct-video.html` —— 直接的 `<video>` 页面。
- `http://127.0.0.1:5500/fixtures/iframe-video.html` —— 同源 iframe 内嵌视频（agefans 类）。
- `http://127.0.0.1:5500/fixtures/no-video.html` —— 无视频，验证「未检测到播放器」提示。

本地调试时，记得在脚本的 `@match` 里临时加一条 `http://127.0.0.1:5500/*`，并把 `useLocalWorker` 设为 `true`。

---

## 运行后端测试

后端逻辑有基于 `node:test` 的单元测试（使用内存版 D1 桩，无需真实数据库）：

```bash
npm test
```

覆盖：建房返回房主 token、加入房间、错误 token 被拒、多人状态排序、非法负载被拒、未知房间返回 404、数值边界裁剪等。

---

## API 接口说明

所有响应均为 JSON，Worker 会带上允许跨域的 CORS 头。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /rooms` | 创建房间。返回 `roomId`、`participantId`、`hostToken`。 |
| `POST /rooms/:roomId/join` | 加入房间。返回 `roomId`、`participantId`、`role`。 |
| `POST /rooms/:roomId/state` | 上报本地播放状态。房主需带上 `hostToken`。 |
| `GET /rooms/:roomId/state` | 拉取房间内所有参与者的状态。 |

错误码：`400` 负载非法，`403` 房主 token 无效，`404` 房间不存在。

**上报状态请求示例：**

```json
{
  "participantId": "p_...",
  "hostToken": "h_...",
  "state": {
    "currentTime": 123.4,
    "duration": 1440,
    "paused": false,
    "url": "https://example.com/video",
    "title": "第 1 集",
    "source": "video-src-or-page-id",
    "adapter": "generic-video"
  }
}
```

---

## 适配器说明

前端采用分层适配器策略，所有适配器暴露相同接口（`detect`、`getState`、`seek`、`play`、`pause`、`onChange`）：

- **通用页面视频适配器**：自动挑选页面里最可能是「主视频」的 `<video>`（可见、有时长、渲染面积最大；忽略广告/预览类小视频）。
- **iframe 聚合适配器（顶层窗口）**：监听各 iframe 上报的视频状态，并能向下广播 seek/play/pause 控制指令。
- **iframe 上报器（运行在 iframe 内）**：检测内嵌 `<video>` 并把状态 `postMessage` 给顶层窗口，同时执行顶层下发的控制指令。
- **bilibili 适配器**：优先选取主播放器容器内的视频，避免触碰弹幕、登录、画质等控件。

agefans 类站点通过 iframe 路径工作，思路与 "Agefans Enhance" 一致——把内层帧的播放事件转发给外层页面。

若页面找不到可控视频，面板会显示「**player not detected（未检测到播放器）**」而不是静默失败。

---

## 安全与隐私

- 油猴脚本只上报同步所需的播放元数据：房间 id、参与者 id、昵称、当前时间、时长、暂停状态、页面 URL、页面/视频标题、来源标识、适配器名。
- **不会** 收集 cookie、账号 token、弹幕数据或页面 HTML。
- 房主 token 仅存在本地，绝不在界面上显示。
- 房间码是随机生成的，难以被随意猜中。
- 当前 Worker 的 CORS 设置为 `Access-Control-Allow-Origin: *`（符合 MVP 设定：无账号、无凭证，只流转不透明的房间码/token）。若后续加入敏感内容，建议收紧为指定来源。

---

## 常见问题

**Q：`wrangler d1 execute` 报找不到数据库？**
A：确认 `wrangler.toml` 里的 `database_name` 与 `database_id` 已正确填写，且和 `wrangler d1 create` 时使用的名字一致。

**Q：脚本装好了但右侧没有出现小圆钮？**
A：检查当前页面 URL 是否匹配脚本顶部的 `@match` 列表；不匹配就把域名加进去再刷新。

**Q：能创建/加入房间，但进度不同步？**
A：确认参与者已勾选「Auto-follow host progress」；同时注意只有房主的进度会被其他人跟随，并且漂移要超过 5 秒才会触发跳转。

**Q：面板提示 Sync unavailable / Host offline？**
A：`Sync unavailable` 表示连不上 Worker，检查 `workerUrlRemote` 是否正确、Worker 是否已部署；`Host offline` 表示房主长时间没有上报状态。

**Q：以后想换成 Chrome 扩展？**
A：脚本已按 `apiClient`、`roomStore`、`videoAdapters`、`syncEngine`、`panelUi`、`settings` 模块化组织，后端 API 与同步规则可直接复用，只需把 Tampermonkey 的存储/菜单 API 换成 Chrome 的 storage、popup、content script 即可。
