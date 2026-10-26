# 0.3.9 本轮记录

> 基线 0.3.8 → 0.3.9。本轮把弹幕内核换成 fly-barrage，并把直播间/关注页遗留的逻辑问题一次修完；
> 同时把「关于」页的版本号改成运行时读取，避免下次打包再漏改。

## 已完成

- [x] 弹幕组件替换为 [fly-barrage](https://github.com/feiafei27/fly-barrage)
  - `fly-barrage-master/` 用 `npm install` + `npx vite build` 出 IIFE（`dist/fly-barrage.iife.js`），
    产物复制为 `web/vendor/fly-barrage.js`；Tauri 侧不需要 Node 构建链。
  - 新增 `web/js/danmaku.js`：把 canvas 渲染器包成项目接口（字号/行数/区域/速度/不透明度/描边/开关），
    直播间只负责屏蔽、去重和转交。
  - 自研的 `laneItems / laneCursor / danmakuQueue / activeDanmaku` DOM 轨道调度整体删除，
    `room.css` 里旧的 `.danmaku` 规则一并清掉。
  - 踩坑记录：
    - 库里的 `lineHeight` 是**行高倍数**（内部按 `fontSize * lineHeight` 算高度），
      传像素会让每条弹幕算成 560px 高、排不进轨道，表现为「一条都不显示」。
    - `send()` 依赖虚拟轨道已初始化，直播逐条发送时必须先 `initTracks()`，
      否则每条都抛 `Cannot read properties of undefined (reading 'top')`。
    - `resize()` / `setRenderConfig()` 触发的热重排会清空「可渲染集合」导致画面变空，
      所以尺寸或布局参数变化时改为**重建渲染器**，不再调它的 resize。
    - 库不回收已下屏实例，长时间观看按 `sent > limit` 定期重建，避免内存持续增长。
- [x] 关注页排序与计数
  - 排序：直播中优先 → 进房次数（`clicks`，由 `touchFollowVisit` 累加）→ 最近访问 → 昵称。
  - 右上角计数跟随筛选：`N 位主播 / N 位直播中 / N 位未开播 / N 位 · 平台`。
  - 「按状态 / 按平台」补上选中态和勾选图标，点了能看出区别。
- [x] 导出 / 导入包含登录信息
  - 备份新增 `accounts`（各平台 Cookie 与登录态），设置页与关注页两处导出、导入都同步。
  - 导入后由 `init()` 统一 `setCookie` 回灌后端，不用手动重登。
- [x] 直播间 SC 分「正在显示 / 历史 SC」
  - 删除或到期自动消失的 SC 进入历史区，带结束时间与原因（手动 / 到期），上限 200 条。
  - 角标计数只统计正在显示的 SC。
- [x] 左下角时间改为直播时长
  - 后端 `LiveRoomDetail` 新增 `live_start_time`（B 站 `room_info.live_start_time`、斗鱼 `show_time`、虎牙 `lLiveTime`），
    拿不到时退回「本次观看时长」，不再是当前时钟。
  - 聊天区不再显示人气热度，只保留平台与开播状态。
- [x] 右侧栏显示 B 站在看人数
  - 后端新增 `viewers`（B 站 `room_info.watched_show.num`），聊天头部显示「N 人在看」。
- [x] 直播间关注栏
  - 只列**正在直播**的关注，副标题只显示平台名、状态用左侧圆点；刷新按钮并发拉取全部关注状态。
- [x] 返回逻辑
  - 新增 `ctx.exitRoom()`：直播间的返回按钮与 Esc 一律回到「进入直播间之前的一级页面」，
    从关注栏 A 进 B 再返回不会退回 A。
- [x] 断流修复
  - 去掉按固定间隔（虎牙 3 分钟 / 其他 9 分钟）无条件重取流的定时器——它会在地址没过期时销毁播放器，
    表现为「看一会儿断一下」。
  - 改为只依赖卡顿检测（6 秒无进展）和播放错误：优先换线，线路用尽再重取流，全程不需要用户操作。
- [x] 版本号不再硬编码
  - 「关于」页改为 `window.__TAURI__.app.getVersion()`，读不到时（浏览器演示）用兜底常量；
    权限补了 `core:app:default`。今后只需改 `tauri.conf.json` 与 `Cargo.toml`。
- [x] 工程整理
  - 新增 `tools/serve.py`（禁缓存开发静态服务）、`tools/shot.py`（按进程截图/点击，含 DPI 感知与置顶）。
  - `tools/cdp.mjs` 继续作为浏览器验证入口（`CDP_PORT=9225 node tools/cdp.mjs shot x.png`）。
  - 浏览器演示模式补了假弹幕（`api.js` 的 `startDemoDanmaku`），没有后端也能调弹幕样式。
- [x] 文档配图整理
  - 截图统一收进 `docs/img/`，README 的截图表格补成真实图片；`docs/screenshots/` 与 `docs/verify-*.png` 移除。
  - `.gitignore` 忽略 `docs/img/`、`web/assets/`、`src-tauri/icons/` 之外的图片，
    以后随手截的调试图不会混进仓库。

## 待办

- [ ] **自绘标题栏**：弃用 Windows 提供的原生标题栏，自行实现一条标题栏，
      跟随浅色 / 深色主题与主题色同步，包含图标、标题、最小化 / 最大化 / 关闭与拖拽区，
      并保留双击最大化、贴边吸附等系统习惯。需要同时处理 `decorations: false`、
      窗口拖拽区域（`data-tauri-drag-region`）与全屏 / 最大化状态下的圆角与按钮位置。（加一些视觉设计如有鼠标移动到关闭按钮，按钮变红的高亮）
- [ ] 后台常驻（最小化继续播放）未实现。
- [ ] 数据存放位置改变，无需使用`%LOCALAPPDATA%\top.june6699.starveil\EBWebView`；可以改成本项目自己的地址如\starveil\。
- [ ] 构建workflow文件，上传GitHub action

## 已取消

- [x] ~~贡献榜 / 亲密榜数据源接入~~：需求已划掉，相关 Tab 在 0.3.1 已从聊天面板移除。

## 说明

- 验证提示：本机 WebView2 窗口没有重定向表面，`PrintWindow` 与屏幕 BitBlt 都只能拿到黑图，
  验证界面请用 `tools/cdp.mjs`（浏览器 DevTools 协议）。
- 版本号以 `src-tauri/tauri.conf.json` 为准；「关于」页运行时读 `app.getVersion()`，
  改版本时只需改配置与 `Cargo.toml`。
- 更早的迭代记录见 [CHANGELOG.md](CHANGELOG.md) 与 `git log`。
- `dist/Starveil.exe` 目前还是修复「关于」页版本号之前的构建，下次打包会一起带上（本机没有重新编译）。
