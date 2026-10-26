# 星幕直播 · Starveil

用 **Tauri 2 + WebView2** 重写的聚合直播桌面客户端，支持哔哩哔哩 / 斗鱼 / 虎牙的  
推荐、分类、搜索、直播间、弹幕与聊天。

界面是纯 HTML / CSS / ES Modules（无前端框架），播放走 mpegts.js（FLV over MSE），  
协议层是 Rust 写的 [`live_core`](src-tauri/vendor/live_core)（已内嵌进本仓库）。

> 当前版本 **0.3.9** · Windows 10/11 x64 · GPL-3.0 · **非官方第三方客户端，仅供学习交流**

![首页](docs/img/home.png)

## 为什么做这个项目

- **原版在 Windows 上有不少显示问题**：窗口控件与缩放 问题，Flutter 桌面端这些问题不好调，想验证换成 rust+gpui 能不能解决后面换成WebView。
- **独立的功能需求**：我有不少附加的需求，而原版的许多功能我也不需要。
- **顺带做一次 AI 辅助开发的完整实践**，趁手上工具额度还在，把想法一次落地。

参考项目：<https://github.com/June6699/dart_simple_live>  
（原版为 [xiaoyaocz/dart\_simple\_live](https://github.com/xiaoyaocz/dart_simple_live)，GPL-3.0）。

## 与参考项目的关系

|     | 原版 dart_simple_live                | 本项目 Starveil             |
| --- | ---------------------------------- | ------------------------ |
| 界面  | Flutter（GetX）                      | HTML / CSS / ES Modules  |
| 播放  | media_kit（libmpv）                  | mpegts.js（FLV over MSE）  |
| 平台  | Android / iOS / Windows / TV / CLI | Windows 桌面               |
| 协议层 | `simple_live_core`（Dart）           | `live_core`（Rust，移植三站协议） |
| 数据  | Hive                               | localStorage             |

布局、字号、间距、设置分组与直播间结构都对照原版逐页截图还原，  
差异集中在播放内核与部分移动端专属能力（见「已知限制」）。

## 截图

| 分类 | 分类下的房间列表 |
| --- | --- |
| ![分类](docs/img/category.png) | ![分类房间列表](docs/img/category-rooms.png) |

| 直播间（视频 + 滚动弹幕 + 聊天） | 关注 |
| --- | --- |
| ![直播间](docs/img/room.png) | ![关注](docs/img/following.png) |

| 搜索 | 设置 |
| --- | --- |
| ![搜索](docs/img/search.png) | ![设置](docs/img/setting.png) |

> 其余界面截图（登录、外观、弹幕参数等）见 [docs/img/](docs/img)。

## 功能

**外壳与导航**

- 左侧竖向图标栏（首页 / 关注 / 分类 / 设置）+ 顶部平台 Tab（哔哩哔哩 / 斗鱼 / 虎牙 / 抖音 / 快手，  
  未接入的平台标「即将支持」）。
- 深浅色主题、8 色主题色板、界面密度、首次启动免责声明、全局提示、骨架屏与错误重试。

**首页 / 分类 / 搜索**

- 首页是按平台热度排的封面卡网格：平台角标、标题、主播、人气，支持手动刷新与「加载更多」；  
  增量插入卡片 + `content-visibility` + CDN 缩略图 + 懒加载，长列表滚动不掉帧。
- 分类页按一级分区纵向排列，二级分类图标网格，超过 15 项时「显示全部 / 收起」；  
  进入分类后是带返回、居中标题与分页的房间网格。
- 搜索页支持关键词、房间号直达、直播间链接解析，以及「主播」模式（昵称 / UID，B 站 UID 会反查直播间）。

**关注**

- 关注 / 取关、标签分组、按直播状态或平台筛选、网格 / 列表切换、导入导出。
- 排序为「正在直播 → 常看（进房次数）→ 最近访问」，右上角计数跟随当前筛选。

**设置**

一级列表 + 二级详情（分组标题 + 圆角卡片行）：  
外观、主页、播放页、直播、弹幕、关注、定时关闭、其他、数据同步、链接解析、账号管理、免责声明、关于。  
数据同步可导出 / 导入设置、关注、观看记录与**登录信息**。

**直播间**

- 视频铺满，`object-fit` 可切适应 / 铺满 / 拉伸；顶部浮层显示房间标题、主播、分区、人气与关注。
- 弹幕层基于 [fly-barrage](https://github.com/feiafei27/fly-barrage)：canvas 渲染 + 虚拟轨道避让，  
  支持颜色、字号、粗细、不透明度、描边、显示区域、行数、滚动速度、重复过滤与关键词/用户屏蔽。
- 右侧聊天面板：主播信息 + 聊天 / SC / 关注 / 设置四个 Tab；SC 分「正在显示 / 历史」，到期自动归档。
- 底部控制条：音量、直播时长、清晰度、线路、弹幕开关、设置、画中画、全屏（直播不提供暂停）；  
  底部动作栏：刷新、关注、标签、分享、复制链接、复制直播流。
- 单击画面唤出控制条，双击或按 `F` 全屏，`D` 开关弹幕，`Esc` 返回，`↑/↓` 调音量；  
  鼠标静止 2.8 秒自动隐藏浮层。直播流卡顿或结束时自动换线 / 重连。

## 技术栈

| 层   | 选型                      | 说明                                |
| --- | ----------------------- | --------------------------------- |
| 外壳  | Tauri 2                 | Windows 原生窗口 + WebView2，产物约 16 MB |
| 界面  | HTML / CSS / ES Modules | 无构建步骤，改完刷新即可                      |
| 播放  | mpegts.js               | FLV over MSE，直播低延迟                |
| 弹幕  | fly-barrage             | canvas + 虚拟轨道，避免叠字                |
| 协议层 | Rust `live_core`        | 三站推荐 / 分类 / 搜索 / 详情 / 取流 / 弹幕     |
| 流代理 | 内置 `127.0.0.1` 转发       | 补齐 CDN 需要的 Referer / CORS         |

## 目录结构

```
Starveil/
├─ src-tauri/
│  ├─ src/main.rs           命令：推荐/搜索/分类/房间/取流/弹幕/登录/剪贴板
│  ├─ capabilities/         Tauri 2 权限
│  ├─ tauri.conf.json       窗口、构建与打包配置（版本号以这里为准）
│  ├─ icons/                应用图标（tools/make_icon.py 生成）
│  └─ vendor/live_core/     内嵌直播协议层（B 站 / 斗鱼 / 虎牙 + Tars token）
├─ web/
│  ├─ index.html
│  ├─ styles.css            设计变量、外壳、卡片、按钮、弹窗
│  ├─ pages.css             首页 / 分类 / 关注 / 设置 / 搜索
│  ├─ room.css              直播间、弹幕、聊天、播放器控制
│  ├─ js/
│  │  ├─ app.js             路由、导航、平台切换、首次启动
│  │  ├─ api.js             Tauri 命令封装 + 浏览器演示数据
│  │  ├─ store.js           设置 / 关注 / 历史 / 搜索历史持久化
│  │  ├─ danmaku.js         弹幕层：封装 fly-barrage
│  │  ├─ ui.js              卡片、弹窗、菜单、空态、加载态
│  │  ├─ icons.js           SVG 图标与平台图标
│  │  └─ pages/             home / category / category-rooms / follow / search / settings / room
│  ├─ assets/               平台图标、应用 logo
│  └─ vendor/               mpegts.js、fly-barrage.js、cryptojs、qrcode
├─ tools/
│  ├─ serve.py              开发用静态服务（禁用缓存）
│  ├─ cdp.mjs               WebView2 / Edge DevTools 调试（截图、执行 JS、读 console）
│  ├─ shot.py               按进程截图与点击（DPI 感知）
│  └─ make_icon.py          生成 1024 图标、ico 与 web logo
├─ docs/
│  ├─ reference-spec.md     原版界面逐页记录
│  └─ img/                  界面截图（README 引用，其余图片不入库）
├─ dist/                    本机构建产物（Starveil.exe 不入库）
├─ CHANGELOG.md             更新日志
└─ ToDo.md                  当前待办与最近一轮记录
```

## 运行与构建

**环境要求**：Windows 10/11 x64、WebView2 运行时、Rust 1.95（`rust-toolchain.toml` 已固定）、  
`cargo-tauri` 2.6+。

**开发**（前端无构建步骤，起静态服务让 Tauri 的 `devUrl` 指向它）：

```bash
python tools/serve.py 1420 web   # 必须禁缓存，否则 WebView2 拿到 304 会白屏
cargo tauri dev                  # 另开一个终端
```

调试界面可以用 DevTools 协议（浏览器里打开同一个地址即可）：

```bash
# 用 Edge 打开 http://127.0.0.1:1420 并加 --remote-debugging-port=9225
# bash：CDP_PORT=9225 node tools/cdp.mjs shot shot.png
# PowerShell：$env:CDP_PORT = "9225"; node tools/cdp.mjs shot shot.png
node tools/cdp.mjs shot shot.png
node tools/cdp.mjs eval "document.title"
```

**打包**：

```bash
cargo tauri build --no-bundle
# 产物：src-tauri/target/release/starveil.exe（会把 web/ 嵌入二进制）
```

**数据位置**：设置、关注、观看记录与登录 Cookie 存在  
`%LOCALAPPDATA%\top.june6699.starveil\EBWebView`；删除该目录会同时清掉设置与登录态。

## 后端命令

| 命令                                                                        | 说明                            |
| ------------------------------------------------------------------------- | ----------------------------- |
| `recommend(platform, page)`                                               | 平台热度推荐                        |
| `search(platform, keyword)`                                               | 搜索直播间                         |
| `search_anchors(platform, keyword, page)`                                 | 搜索主播（B 站纯数字 UID 会反查直播间）       |
| `categories(platform)`                                                    | 分类树                           |
| `category_rooms(platform, parentId, subId, name, page)`                   | 分类下直播间（分页）                    |
| `open_room(platform, roomId)`                                             | 房间详情 + 清晰度，会话存在后端             |
| `play(key, index)`                                                        | 按清晰度取直链与请求头                   |
| `start_danmaku(key)` / `stop_danmaku()`                                   | 弹幕订阅，消息通过 `danmaku` 事件推送      |
| `resolve_input(current, input)`                                           | 链接 / 房间号解析                    |
| `copy_text(text)` / `open_url(url)` / `quit_app()`                        | 剪贴板、浏览器、退出                    |
| `set_cookie(platform, cookie)` / `clear_cookie(platform)`                 | 注入 / 清除登录 Cookie 并重建 LiveCore |
| `login_status(platform, cookie)`                                          | 校验登录态                         |
| `bili_qr_generate()` / `bili_qr_poll(key)`                                | B 站扫码登录                       |
| `douyu_qualities(key, signedArgs)` / `douyu_play(key, index, signedArgs)` | 斗鱼 WebView 签名后的清晰度 / 直链       |

## 已知限制

- 播放内核是 mpegts.js（FLV over MSE），HLS 线路会被过滤，画质切换细节与原生 mpv 不完全一致。
- 抖音、快手接口未移植，Tab 已预留。
- 贡献榜 / 亲密榜的数据源不接（需求已取消）。
- 虎牙不支持登录；斗鱼未登录时最高画质约 10 分钟过期，过期后会触发自动重取流。
- 窗口标题栏目前用 Windows 原生样式，暂未做自绘标题栏（见 `ToDo.md`）。
- 所有数据只在本机，不上传服务器。

## 文档

- [CHANGELOG.md](CHANGELOG.md)：版本更新日志
- [ToDo.md](ToDo.md)：当前待办与最近一轮的实现记录
- [docs/reference-spec.md](docs/reference-spec.md)：原版界面逐页对照
- [docs/img/](docs/img)：界面截图（README 引用的配图都在这里；仓库不收录其它图片）

## 许可与致谢

本项目是**独立仓库**，不是原项目的官方分支，与原项目作者无隶属关系。

- **界面**：布局结构、交互细节与平台图标参考 [`dart_simple_live`](https://github.com/xiaoyaocz/dart_simple_live)（GPL-3.0）。
- **协议**：各平台的房间信息、清晰度、取流签名与弹幕编解码，是从原项目 Dart 实现
  （`simple_live_core`）移植为 Rust 的（`src-tauri/vendor/live_core`），并非原创；
  迁移过程中补充了虎牙 Tars `getCdnTokenInfoEx`、斗鱼 WebView 签名等实现。
  因此本项目属于原项目的衍生作品，沿用 **GPL-3.0**，完整源码随本仓库提供，见 [LICENSE](LICENSE)。
- **依赖**：播放使用 [mpegts.js](https://github.com/xqq/mpegts.js)（Apache-2.0）；
  弹幕使用 [fly-barrage](https://github.com/feiafei27/fly-barrage)（MIT，本地构建 IIFE 后放进 `web/vendor/`）；
  斗鱼签名环境使用 CryptoJS（MIT）；登录二维码使用 qrcode-generator（MIT）。

## 免责声明

本项目仅用于个人学习与技术研究，**不提供、不存储、不转播任何直播内容**，也不绕过任何平台的付费或登录限制。

所有视频流、弹幕、封面与商标归各直播平台及主播所有。请遵守所在地区法律法规与各平台服务条款，
**请勿用于商业用途**。因使用本项目产生的任何后果由使用者自行承担。

