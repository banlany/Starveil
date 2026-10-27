# 各平台直播流 / 弹幕协议与处理办法

> 记录星幕直播（starveil）后端 `live_core` 对接各直播平台的取流与弹幕协议。
> 供后续接入新平台（抖音 / 快手）、排查风控、以及维护时查阅。
>
> 权威参考来源：`dart_simple_live/simple_live_core`（Flutter 原版协议层，抖音/快手已完整实现）。
> 本文档在 starveil 侧尚未实现抖音/快手（计划 0.5.0），但把两边的协议都记全，方便对照移植。

---

## 总览

| 平台 | 取流方式 | 弹幕协议 | 签名/风控 |
|------|---------|---------|----------|
| 哔哩哔哩 | `getRoomPlayInfo` HTTP + WBI 签名 | WebSocket + protobuf（`broadcastlv` 封装） | WBI 签名（`w_rid`/`wts`），Cookie 可选 |
| 斗鱼 | `getH5Play` POST + `homeH5Enc` 签名脚本 | WebSocket + 私有二进制协议（`danmuproxy.douyu.com`） | `homeH5Enc` 下发的 JS 脚本签名 |
| 虎牙 | `m.huya.com` HTML 解析 + `wsSecret` 重算 | WebSocket + Tars 协议（`cdnws.api.huya.com`） | `sFlvAntiCode` 必须用新 `seqid` 重算 `wsSecret` |
| 抖音 | `webcast/room/web/enter` + `a_bogus` 签名 | WebSocket + protobuf（`douyin.pb`） | `a_bogus`（RC4+MD5 变体），需 `ttwid` Cookie |
| 快手 | `m.kuaishou.com` HTML `__INITIAL_STATE__` | WebSocket + JSON（`websocketinfo` 拿 token） | `did` 注册 + `kwfv1`/`Kww` 头 |

---

## 1. 哔哩哔哩

### 取流

- **接口**：`GET https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo`
  - 参数：`room_id`、`protocol=0,1`、`format=0,1,2`、`codec=0,1`、`qn`、`platform=web`、`ptype=8` 等。
  - 响应路径：`data.playurl_info.playurl` → `stream[].format[].codec[].url_info[]`（`host` + `base_url` + `extra` 拼直链）。
- **清晰度**：`g_qn_desc[]`（qn → 描述），`accept_qn[]` 判断可用档。
- **签名**：B 站 WBI 签名（`w_rid` + `wts`），`live_core` 的 `signed_url()` 统一处理（见 `wbi.rs`）。
- **直链选择**：优先非 `mcdn` 节点（`sort_by_key(url.contains("mcdn"))`）。
- **弹幕服务器**：`GET /xlive/web-room/v1/index/getDanmuInfo` 拿 `token_list[].host` 与 `token`。

### 弹幕

- **连接**：`wss://{host}/sub`（host 来自 getDanmuInfo，如 `broadcastlv.chat.bilibili.com`）。
- **协议**：`broadcastlv` 二进制封装（16 字节头：包长 / 头长 16 / 版本 1 / 操作码 / 序列号）。
  - 握手：先发 `op=7`（认证，body 为 JSON：`uid/roomid/protover=3/platform=web/type=2/key=token`）。
  - 心跳：`op=2`，每 30s。
  - 弹幕：`op=5`（通知），body 里可多包拼装（`protover=2` 时 zlib 压缩、`protover=3` 时 brotli 压缩）。
- **弹幕字段**：解析 `info[]` 数组（`info[0][1]` 正文、`info[0][3]` 颜色、`info[0][15].extra` 含表情/彩色弹幕等）。

---

## 2. 斗鱼

### 取流

- **签名**：`GET https://www.douyu.com/swf_api/homeH5Enc` 拉签名脚本，在 WebView 里执行（`douyu_sign.rs`），
  得到 `v=..&did=..&tt=..&sign=..`（starveil 不再用 Rust 侧 RSA/boa，交给 WebView 的 CryptoJS）。
- **接口**：`POST https://www.douyu.com/lapi/live/getH5Play/{rid}`，表单带上述签名参数 + `cdn` + `rate`。
- **直链**：响应 `data.rtmp_url`（可能多个，用 `/` 分隔）与 `data.rtmp_live`。

### 弹幕

- **连接**：`wss://danmuproxy.douyu.com:{port}/`（端口由 `danmaku.rs` 的 `douyu_connect` 决定，如 8501~8506 轮询）。
- **协议**：斗鱼私有二进制协议：
  - 小端序，包结构：`[长度4][长度4][类型2][加密1][保留1][body]`。
  - 客户端发：`689`（登录请求，body 为 `type@=loginreq/roomid@=xxx/...` 键值对，末尾 `\0`）。
  - 心跳：`type@=keeplive/tick@=xxx`，每 45s。
  - 弹幕：`type@=chatmsg`（正文 `txt@=`、昵称 `nn@=`、粉丝牌 `bnn@=` 等）。

---

## 3. 虎牙

### 取流

- **接口**：`GET https://m.huya.com/{room_id}` 返回 HTML，解析内嵌的 `hyPlayerConfig` / 房间 JSON，
  得到 `stream.baseSteamInfoList[].sFlvUrl`、`sStreamName`、`sFlvAntiCode`、`lPresenterUid`、`iBitRate`。
- **关键坑（已在代码注释）**：页面给的 `sFlvAntiCode` 直接拼 URL 会 403，必须用**新的 `seqid`** 重算 `wsSecret`
  （`huya_token.rs` 的 `fetch_token` + `build_play_url`），再拼 `wsTime/wsSecret/seqid/ctype` 等查询参数。
- **直链选择**：`tx.flv` / `hs.flv` 优先，`al.flv` 次之。

### 弹幕

- **连接**：`wss://cdnws.api.huya.com`。
- **协议**：Tars（`huya.rs` 的 `tars` 序列化），注册 + 心跳 + 弹幕消息（`model/tars/*`）。

---

## 4. 抖音（计划 0.5.0 接入，参考 dart）

### 取流

- **房间 ID 两种**：
  - `webRid`（固定，11~12 位，如 `416144012050`）——用户每次开播都相同。
  - `roomId`（一次性，19 位）——每次开播重新生成。
  - 判断：`roomId.length <= 16` 当 webRid，否则当 roomId。
- **接口（webRid）**：`GET https://live.douyin.com/webcast/room/web/enter/`，参数含 `web_rid`、`aid=6383`、`app_name=douyin_web` 等，
  **必须带 `a_bogus` 签名**（`DouyinSign.getAbogusUrl`）。
- **接口（roomId）**：`GET https://webcast.amemv.com/webcast/room/reflow/info/`。
- **清晰度**：响应 `data.live_core_sdk_data.pull_data.stream_data`（JSON），或 `data.flv_pull_url` / `data.hls_pull_url_map`。
- **Cookie**：只需 `ttwid` 即可拿全画质（含蓝光），`LOGIN_STATUS` 等可选。匿名 `ttwid` 内置兜底。
- **签名 `a_bogus`**：`douyin_sign.dart` 内置 JS 脚本（RC4 + MD5 变体），通过 `dart_quickjs` 执行。
  starveil 侧应参考「斗鱼签名」做法：把这段 JS 交给 WebView 执行（CryptoJS/QuickJS），避免 Rust 重实现。

### 弹幕

- **连接**：`wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/`（可能需 `_fetchImContext` 动态换地址）。
- **协议**：WebSocket + protobuf（`douyin.pb.dart`，`WebcastPushFrame` 封装，`compress=gzip`、`resp_content_type=protobuf`）。
- **连接参数**：`room_id`、`user_unique_id`（可从 HTML `userStore.odin.user_unique_id` 取，也可随机生成 12 位）、
  `signature`（`_signatureParameters()`，`X-Bogus` 类签名）。
- **心跳**：`heartbeatDuration`，约 10s。
- **弹幕消息类型**：`ChatMessage`（普通弹幕）、`MemberMessage`（进场）、`GiftMessage`（礼物）、`LikeMessage`（点赞）等。

---

## 5. 快手（计划 0.5.0 接入，参考 dart）

### 取流

- **接口**：`GET https://live.kuaishou.com/u/{roomId}` 返回 HTML，正则提取
  `window.__INITIAL_STATE__=(.*?);`，把 `undefined` 替换成 `null` 后 `jsonDecode`。
- **数据路径**：`liveroom.playList[]` → `liveStream.playUrls`（含 `h264.adaptationSet.representation[]`，每个有 `url`/`name`/`level`）。
- **清晰度**：`detail.data.h264.adaptationSet.representation[]`。
- **Cookie / 设备**：
  - `_getCookie` 首次访问拿 `did` 等 Cookie。
  - `_registerDid` 调 `log-sdk.ksapisrv.com` 上报设备（`did` + `KS_GAME_LIVE_PC`）。
  - 请求头需带 `kwfv1`（Cookie 里）→ `Kww` 头（`resolveServerKww` 处理）。

### 弹幕

- **接口**：`GET https://live.kuaishou.com/live_api/liveroom/websocketinfo?liveStreamId=xxx`，
  拿到 `token` 和 `websocketUrls`（也可从 `__INITIAL_STATE__` 的 `liveroom.websocketUrls` / `token` 直接取）。
- **连接**：WebSocket 连 `websocketUrls`，协议为 **JSON**（非 protobuf）。
- **连接参数**：`roomId`、`liveStreamId`、`token`、`pageId`（随机）、`expTag`、`attach`、`cookie`。

---

## 通用处理办法（各平台共性）

1. **取流统一走 FLV**：所有平台取到的直链，starveil 都经本机 `127.0.0.1:<port>/stream/<token>` 代理，
   由 Rust 补 Referer/CORS，前端 mpegts.js 统一播 FLV（见项目 README / 工作记忆）。
2. **弹幕统一收敛**：`danmaku.rs` 把各平台弹幕收敛成 `DanmakuMessage { user, text, color, system, position, sc }`。
   抖音/快手接入时，需在此新增解析分支（或独立 `douyin_danmaku.rs` / `kuaishou_danmaku.rs`）。
3. **签名策略**：
   - 斗鱼签名已交给 WebView（CryptoJS）。
   - 抖音 `a_bogus` 建议同样交给 WebView 执行下发的 JS，避免 Rust 侧重实现（与斗鱼一致）。
4. **风控**：抖音/快手风控比 B 站/斗鱼严，可能遇到 `444` / `2483`（需登录）等状态码，要预留登录态
   与「匿名 cookie 兜底 + 自定义 cookie 重试」逻辑（dart 的 `_requestWithCustomCookieFallback` 就是这个模式）。
