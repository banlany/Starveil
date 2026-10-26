# dev 分支说明

`main` 是发布分支，代码保持干净；这条分支用于**排查问题与做实验**。

## 相比 main 多了什么

- `src-tauri/src/main.rs` 里带调试探针：
  - debug 构建在窗口就绪后自动打开 DevTools；
  - 启动 3 秒后注入 DOM 探针（`PROBE href=... ready=... bodyLen=...`），
    用来确认页面到底有没有渲染、JS 上下文是否成立。
- 本机诊断脚本在 `tools/` 下（**不入库**，见 `.gitignore`），换机器时需要重写。

## 排查 WebView2 显示问题的标准流程

1. **先拿 Chromium 自己的日志**（最有效的证据来源）：

   ```bash
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--enable-logging --v=1 --log-file=<路径> ./dist/Starveil.exe
   ```

   该变量里的参数是**追加**到配置 `additionalBrowserArgs` 之后的，不会覆盖它。
   release 版 Chromium 的断言文本已被剥掉，从 crashpad dump 里挖不到，只能靠这个日志。

2. **看崩溃转储数量**：`%LOCALAPPDATA%\Starveil\WebView2\EBWebView\Crashpad\reports\*.dmp`
   每多一个 `.dmp` 就是浏览器主进程崩了一次。

3. **看 WebView2 子进程树**：正常应能看到 `browser` / `gpu-process` / `renderer` /
   `network` / `storage` / `crashpad-handler` 六个。缺 `gpu-process` 就是 GPU 起不来。

4. **判断是不是真黑屏**：用屏幕 BitBlt 抓图（`PrintWindow` 对 WebView2 只能拿到黑图）：

   ```bash
   python tools/minimize_others.py tauri      # 先把别的窗口最小化，否则会抓到背后窗口
   python tools/shot_any.py Starveil.exe out.png --topmost
   python tools/pixel_stat.py out.png          # 客观统计非黑像素占比
   ```

## 已知的环境陷阱

- **父进程处于 Job Object 中时，Chromium 的 GPU 沙箱起不来**
  （要给子进程建「受限令牌 + 嵌套 Job」，父进程已在 Job 里就建不出来），
  GPU 进程连续 `exit_code=7` 崩溃后浏览器主进程 FATAL 退出 → 窗口全黑。
  `main` 分支已用 `IsProcessInJob` 判定并自动降级，这里只作为背景知识。
- **每次实验前必须清理残留进程**，否则 profile 被锁、结果互相污染：
  `taskkill /F /IM Starveil.exe` 及其 webview2 子进程。
- **每轮只改一个变量并重新编译**。中途曾因为「改了 decorations 但没清
  `--disable-gpu-sandbox`」得出过完全相反的错误结论。
- **进程会被工具回收**：用 `(./dist/Starveil.exe &)` 启动的进程会在命令结束时被杀掉，
  启动与观察必须在同一条命令里完成。
