# live_core（Tauri 版内嵌副本）

本目录是从 `gpui_simple_live/crates/live_core` 迁入 Tauri 工程的协议层，
目的是让 `tauri_simple_live` 不再依赖 gpui 工作区的相对路径。

- 原 crate：`live_core`，MIT。
- 这里只保留 Tauri 需要的哔哩哔哩 / 斗鱼 / 虎牙协议与弹幕实现。
- 关闭了 `douyu-js`：斗鱼签名改由 WebView 执行，Tauri 不再需要 boa。
- 修改点：`http.rs` 增加了 gzip 响应兜底解压（虎牙首页会返回 gzip 字节）。
