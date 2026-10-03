# 远程一起看视频油猴脚本设计

日期：2026-06-30

## 目标

先做一个可以工作的远程一起看视频工具，覆盖 bilibili 和一些小视频网站，例如稀饭动漫、次元城、agefans-like 站点。第一版使用 Tampermonkey 油猴脚本，加一个 Cloudflare Worker 小后端；后续再迁移成 Chrome 浏览器插件。

MVP 的核心体验是：朋友之间能看到彼此的视频进度，并且可以选择是否跟随房主。观看时界面要尽量安静，不要一直占据注意力。

## 非目标

- 第一版不做 Chrome 插件。
- 不要求自建 VPS 或购买服务器。
- 不做账号系统或登录。
- 第一版不要求 WebSocket 实时同步。
- 不保证支持所有魔改播放器。
- 第一版不同步弹幕、字幕、清晰度、播放速度或选集。
- 不做常驻聊天功能。

## 推荐方案

采用一个小型 monorepo：

- `userscript/watch-party.user.js`：Tampermonkey 油猴脚本。
- `worker/`：Cloudflare Worker 后端。
- `worker/schema.sql`：Cloudflare D1 数据库结构。
- `docs/`：安装、部署、站点适配说明。
- `fixtures/`：本地测试页，用来验证普通 `<video>` 和 iframe `<video>` 检测。

油猴脚本负责检测当前视频、渲染安静的浮动控件、向 Worker 上报本地播放状态、定时拉取房间状态，并在用户开启对应开关后跟随房主。

Worker 负责把房间和成员状态保存到 D1。后端保持很小：创建房间、加入房间、接收状态上报、返回房间状态。

## 产品行为

### 房间模型

创建房间的人就是房主。其他人通过输入房间码加入。第一版不支持转让房主，也不支持多人抢控制权。

每个浏览器本地保存一个成员身份。房主额外保存一个本地 `hostToken`。只有带正确 `hostToken` 的请求才能更新房主状态。

### 默认同步行为

默认是被动模式：

- 成员可以看到彼此进度。
- 不会自动跳转任何人的进度。
- 不会控制任何人的播放或暂停。

用户可以打开两个独立开关：

- 自动跟随房主进度：如果本地时间和房主时间差超过 5 秒，就跳到房主进度。
- 跟随房主播放/暂停：如果房主暂停或播放，本地也执行同样状态。

用户手动拖动本地进度条后，会进入 8 秒保护窗口。在保护窗口内暂停自动跟随，避免刚拖完进度就被立刻拉回去。

### 轮询频率

MVP 使用 HTTP 轮询：

- 加入房间后，每 5 秒上报一次本地播放状态。
- 加入房间后，每 5 秒拉取一次房间状态。
- 发生关键事件时尽量立即上报：播放、暂停、seek 完成、视频源变化。

这个方案足够简单，也适合 Cloudflare Workers/D1 免费额度。后续如果需要更顺滑的实时体验，可以升级到 WebSocket 或 Durable Objects。

## 用户界面

界面应尽量安静。

### 闲置状态

用户未加入房间时，只在页面右侧显示一个很小的悬浮按钮。点击按钮后展开面板，展示创建房间和加入房间入口。

### 已加入房间但面板收起

用户已加入房间且面板收起时，只显示低存在感按钮或小状态胶囊。它可以显示极简状态，例如“房间中”、连接颜色点、或与房主的进度差。

### 展开面板

展开面板包含：

- 当前房间码和复制按钮。
- 当前身份：房主或成员。
- 本地视频检测状态。
- 成员列表，包含进度、播放/暂停状态、最后在线新鲜度。
- 手动“跳到房主进度”按钮。
- 自动跟随房主进度开关。
- 跟随房主播放/暂停开关。
- 显示模式：安静模式、状态胶囊、固定面板。
- 离开房间按钮。

如果用户大约 10 秒没有操作，面板自动收起，除非用户把它固定。同步失败、房主离线、进度差过大等错误以短暂提示出现，不做大面积常驻 UI。

### 全屏行为

全屏播放时，默认隐藏所有一起看视频 UI。第一版不强行把控件嵌入播放器控制栏，因为每个站点 DOM 和全屏行为差异很大。等某些站点适配稳定后，可以再做站点专属的播放器控制栏嵌入。

## 视频检测与控制

### 适配器策略

采用分层适配器：

1. 通用页面视频适配器：在当前文档中寻找最合适的 `<video>` 元素。
2. 通用 iframe 适配器：在可访问的同源 iframe 或 userscript 匹配到的 frame 中注入检测逻辑，并通过 `postMessage` 转发视频状态。
3. Bilibili 适配器：优先使用页面里真实的 `<video>` 元素，不触碰弹幕、登录、账号或清晰度控制。
4. Agefans-like 适配器：参考 Agefans Enhance 的思路，让内部 iframe 把播放事件发送给外层页面。

所有适配器暴露同一套接口：

- `detect()`：判断是否存在可控制视频。
- `getState()`：返回当前时间、总时长、暂停状态、视频源、标题、URL 和适配器名称。
- `seek(time)`：设置播放位置。
- `play()`：在浏览器策略允许时开始播放。
- `pause()`：暂停播放。
- `onChange(callback)`：监听有意义的本地变化。

### 视频选择规则

如果页面里有多个视频，选择最可能是主视频的那个：

- 优先选择可见视频。
- 优先选择总时长非零的视频。
- 优先选择渲染面积最大的视频。
- 尽量忽略很小的预览视频或广告视频。

如果找不到可控制视频，UI 应显示“未检测到播放器”，不要静默失败。

## 后端 API

所有 API 响应都是 JSON。Worker 需要给油猴脚本来源返回宽松的 CORS 头。
房间码由 4 个字母或数字组成。

### `POST /rooms`

创建房间。

请求体：

```json
{
  "displayName": "Alice"
}
```

响应：

```json
{
  "roomId": "AB12",
  "participantId": "p_...",
  "hostToken": "h_..."
}
```

### `POST /rooms/:roomId/join`

加入已有房间。

请求体：

```json
{
  "displayName": "Bob"
}
```

响应：

```json
{
  "roomId": "AB12",
  "participantId": "p_...",
  "role": "participant"
}
```

### `POST /rooms/:roomId/state`

上报本地成员状态。房主需要携带 `hostToken`。

请求体：

```json
{
  "participantId": "p_...",
  "hostToken": "h_...",
  "state": {
    "currentTime": 123.4,
    "duration": 1440,
    "paused": false,
    "url": "https://example.com/video",
    "title": "Episode 1",
    "source": "video-src-or-page-id",
    "adapter": "generic-video"
  }
}
```

响应：

```json
{
  "ok": true
}
```

### `GET /rooms/:roomId/state`

拉取房间状态。

响应：

```json
{
  "roomId": "AB12",
  "hostParticipantId": "p_...",
  "participants": [
    {
      "participantId": "p_...",
      "displayName": "Alice",
      "role": "host",
      "state": {
        "currentTime": 123.4,
        "duration": 1440,
        "paused": false,
        "url": "https://example.com/video",
        "title": "Episode 1",
        "source": "video-src-or-page-id",
        "adapter": "generic-video"
      },
      "updatedAt": "2026-06-30T12:00:00.000Z"
    }
  ]
}
```

## 数据模型

使用 Cloudflare D1。

### `rooms`

- `id`：房间码，主键。
- `host_participant_id`：创建者的成员 ID。
- `host_token_hash`：房主 token 的哈希值。
- `created_at`：ISO 时间戳。
- `updated_at`：ISO 时间戳。

### `participants`

- `id`：成员 ID，主键。
- `room_id`：房间码。
- `display_name`：显示名称。
- `role`：`host` 或 `participant`。
- `state_json`：最新播放状态。
- `created_at`：ISO 时间戳。
- `updated_at`：ISO 时间戳。

几分钟没有更新的成员在 UI 中视为离线。清理逻辑可以后续用定时任务做，也可以在 API 处理过程中顺手清理。

## 错误处理

油猴脚本：

- 没有适配器能控制视频时，显示“未检测到播放器”。
- 无法连接 Worker 时，显示“同步不可用”。
- 房主长时间没有更新时，显示“房主离线”。
- 如果同一次纠偏失败，不要反复 seek。
- 用户本地手动 seek 后进入冷却保护。

Worker：

- 未知房间返回 `404`。
- 使用错误 host token 更新房主状态时返回 `403`。
- 请求结构不合法返回 `400`。
- 限制房间 ID、显示名称、标题、URL、视频源和适配器名称的字符串长度。
- 只保存一起看视频所需状态，不保存账号凭据或 cookie。

## 安全与隐私

油猴脚本不收集 cookie、账号 token、弹幕数据或页面 HTML。它只发送同步所需的播放元数据：

- 房间 ID
- 成员 ID
- 显示名称
- 当前时间
- 总时长
- 暂停状态
- 页面 URL
- 页面/视频标题
- 视频源标识
- 适配器名称

房间码应随机生成，避免被轻易猜到。`hostToken` 不在 UI 中展示，只保存在本地。

## 迁移到 Chrome 插件的路径

即使第一版打包成单个 `.user.js` 文件，也要按模块组织逻辑：

- `apiClient`
- `roomStore`
- `videoAdapters`
- `syncEngine`
- `panelUi`
- `settings`

这样后续迁移到 Chrome 插件时，大部分逻辑可以复用。Chrome 插件只需要把 Tampermonkey 存储和菜单能力替换成 Chrome storage、popup 和 content scripts，同时继续使用同一套 Worker API 和同步规则。

## 测试计划

后端：

- 创建房间并确认返回 host token。
- 加入房间并确认成员状态出现。
- 使用错误 token 更新房主状态应被拒绝。
- 多成员场景下能正确拉取状态。
- 错误 payload 应被拒绝。

油猴脚本文档夹具：

- 检测并控制直接的 `<video>`。
- 检测并控制可访问 iframe 中的 `<video>`。
- 页面没有视频时显示“未检测到播放器”。
- 只有开启自动跟随且进度差超过 5 秒时才跳转。
- 只有开启播放/暂停跟随时才同步播放状态。
- 尊重手动 seek 的保护窗口。
- 全屏时隐藏 UI。

人工站点验证：

- Bilibili 公开视频播放页。
- 一个普通小站的可见 `<video>` 页面。
- 一个 agefans-like iframe 小站，例如稀饭动漫或次元城。

## 实现注意事项

- `@match` 列表先从较窄范围开始，随着站点验证逐步扩大。
- 轮询间隔和进度差阈值应作为常量放在油猴脚本靠前位置。
- 本地 Worker 地址和部署后的 Worker 地址都应可配置。
- 如果本地开发时 Cloudflare D1 还没准备好，可以先用 Worker 内存存储验证 UI 和 API，但目标后端仍然是 D1。
