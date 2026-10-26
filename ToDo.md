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

- [x] **自绘标题栏**（0.4.0）
  - `decorations: false` + `web/js/titlebar.js`：图标、名称、Starveil 角标、最小化 / 最大化 / 关闭。
  - 拖动走 `data-tauri-drag-region`（系统接管移动），双击拖动区最大化；
    无边框后系统不再给 `WS_THICKFRAME`，四边四角自己放了 `.resize-handle` 调 `startResizeDragging`。
  - 颜色全走主题变量，深浅色与主题色自动同步；关闭按钮悬停 `#e81123`、按下更亮的红。
  - 最大化状态由 `onResized` + `isMaximized()` 同步，按钮图标在「最大化 / 还原」间自动切换，
    最大化与全屏时隐藏缩放热区。
  - 兜底：`STARVEIL_DECORATED=1` 可退回系统标题栏排查。
  - 已知取舍：无边框窗口在 Windows 上会失去系统「贴边吸附（Aero Snap）」，需要的话后续自己实现。
- [x] 后台常驻（0.4.0）
  - 关闭按钮走 `window_close`：常驻开启时 `hide()`，否则 `exit(0)`；`CloseRequested`（Alt+F4 / 任务栏关闭）同样处理。
  - 托盘图标（`TrayIconBuilder`）：左键恢复窗口，菜单「显示主界面 / 退出星幕直播」。
  - WebView2 关掉后台节流（`--disable-background-timer-throttling` 等），最小化不再停画面。
  - 设置 → 其他设置新增「关闭窗口时退到托盘」，前端用 `set_resident` 同步给后端。
- [x] WebView2 数据目录（0.4.0）
  - 改为 `%LOCALAPPDATA%\Starveil\WebView2`（`WebviewWindowBuilder::data_directory`）。
  - 首次启动把旧的 `top.june6699.starveil\EBWebView\Default\Local Storage` 复制过来，设置/关注/登录不丢。
  - 排查开关：`STARVEIL_NO_DATADIR=1` 退回 WebView2 默认目录。
- [x] GitHub Actions（0.4.0）
  - `.github/workflows/build.yml`：Windows runner + Rust 1.95 + `tauri-apps/tauri-action`，
    tag 推上来出 NSIS 安装包，并额外上传免安装 zip。

## 待验证（本机条件所限，留给下一次实机确认）

- [ ] 自绘标题栏在应用内的**实际观感**：本机 WebView2 窗口截不到画面，
      目前只在 Edge 里按 20px/40px 两档看过图标与布局。
- [ ] 关闭 → 托盘 → 左键恢复这条链，需要人手点一次确认。
- [ ] 无边框窗口的贴边吸附确实没了，若不能接受需要自己补吸附逻辑。

## 已取消

- [x] ~~贡献榜 / 亲密榜数据源接入~~：需求已划掉，相关 Tab 在 0.3.1 已从聊天面板移除。

## 说明

- 验证提示：本机 WebView2 窗口没有重定向表面，`PrintWindow` 与屏幕 BitBlt 都只能拿到黑图；
  WebView2 自身的 `--remote-debugging-port` 在这台机器上不监听（试过环境变量与
  `additionalBrowserArgs` 两种方式）。界面验证请用 **Edge + CDP**：
  `python tools/serve.py 1420 web` → Edge 打开 `http://127.0.0.1:1420/index.html?titlebar=1`
  并加 `--remote-debugging-port=9225` → `CDP_PORT=9225 node tools/cdp.mjs shot|eval`。
  `?titlebar=1` 是标题栏预览开关（浏览器里默认隐藏自绘标题栏）。
- 版本号以 `src-tauri/tauri.conf.json` 为准；「关于」页运行时读 `app.getVersion()`，
  改版本时只需改配置与 `Cargo.toml`（前端兜底常量在 `settings.js` 顶部）。
- 更早的迭代记录见 [CHANGELOG.md](CHANGELOG.md) 与 `git log`。
