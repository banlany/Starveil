package com.banlany.starveil

import android.app.PictureInPictureParams
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 主 Activity。
 *
 * Rust 侧拿不到 Activity 引用（ndk-context 里存的是 Application），
 * 所以这里把实例存下来，并提供两个静态桥接方法给
 * `src-tauri/src/lib.rs` 的 `call_activity_static` 调用：
 * 方法名与 `(I)Z` / `()Z` 签名和那边一一对应，改一处必须改另一处。
 */
class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        val window = window ?: return
        // 内容画满整屏（含状态栏、导航栏、挖孔），系统栏透明，留白由 CSS 的 --safe-* 派生。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val params = window.attributes
            params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = params
        }
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            pushSafeInsets(insets)
            insets
        }
        syncSystemBars()
    }

    /**
     * 把系统栏与键盘的高度写成 CSS 变量，前端据此留白。
     *
     * 窗口不再让出系统栏的位置，顶部留白由 `.main` 统一承担；键盘也不会再替窗口重排，
     * 所以 `--ime-bottom` 要前端自己加到底部。
     * 写成 `--sys-safe-*`：CSS 侧的 `--safe-*` 留一层派生，全屏档才能把留白归零。
     * 左右不给留白：横屏时挖孔在侧边，让给画面或侧栏，否则会多出一条竖着的空白。
     */
    private fun pushSafeInsets(insets: WindowInsetsCompat? = null) {
        val window = window ?: return
        val view = findWebView(window.decorView) ?: return
        val current = insets ?: ViewCompat.getRootWindowInsets(window.decorView) ?: return
        val bars = current.getInsets(WindowInsetsCompat.Type.systemBars())
        val ime = current.getInsets(WindowInsetsCompat.Type.ime())
        val density = resources.displayMetrics.density
        fun px(value: Int) = Math.round(value / density).toString() + "px"
        // 键盘弹出时导航栏被它压住，底部留白交给 --ime-bottom，不然会空两份。
        val bottom = if (ime.bottom > 0) 0 else bars.bottom
        val js = "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--sys-safe-top','${px(bars.top)}');" +
            "s.setProperty('--sys-safe-bottom','${px(bottom)}');" +
            "s.setProperty('--sys-safe-left','0px');" +
            "s.setProperty('--sys-safe-right','0px');" +
            "s.setProperty('--ime-bottom','${px(ime.bottom)}');})()"
        view.evaluateJavascript(js, null)
    }

    /** 剧院模式下系统栏会被系统放回来（切前台、退出小窗），重新按当前模式同步一次。 */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && !pipActive) syncSystemBars()
    }

    override fun onDestroy() {
        if (instance === this) {
            instance = null
        }
        super.onDestroy()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pipActive = isInPictureInPictureMode
        enteringPip = false
    }

    /**
     * 小窗里 Activity 依然是「可见」的，但系统照样会走 onPause，
     * 父类在这里调 `webView.onPause()`，WebView 会把页面标成 hidden 并把视频暂停，
     * 小窗就成了静止画面。所以必须照常走完 super（否则抛 SuperNotCalledException），
     * 再把 WebView 恢复回来——mWebView 是父类私有字段，只能从视图树里找。
     */
    override fun onPause() {
        super.onPause()
        if (enteringPip || pipActive || isInPictureInPictureMode) {
            findWebView(window?.decorView)?.let { webView ->
                webView.onResume()
                webView.resumeTimers()
            }
        }
    }

    private fun findWebView(view: View?): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    /**
     * 系统栏可见性：常态常显，剧院模式（视频铺满）时全部隐藏。
     *
     * 常态不再隐藏状态栏。藏起来之后那一块位置仍然占着，系统用纯黑铺它，
     * 浅色主题下就是顶部一条黑边；常显时底色由 setSystemBar 跟着主题走，
     * 与顶栏同色，连成一片。
     */
    private fun syncSystemBars() {
        val window = window ?: return
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (theater) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
        ViewCompat.requestApplyInsets(window.decorView)
    }

    /**
     * 系统返回键。
     *
     * Tauri 2 自带的 `back-button` 事件在这里用不了：AppPlugin 判断「有没有人监听」时
     * 查的是插件自己的 listener 表（只有 `plugin:app|register_listener` 才会往里写），
     * 而 JS 的 `__TAURI__.event.listen` 注册在核心事件系统里，那张表永远是空的。
     * 于是按键被当成没人处理，直接 `activity.onBackPressed()` 把 Activity 结束掉，
     * 表现就是「按一下退回桌面」。
     *
     * 所以这里直接把按键交给前端：`window.__starveilBack()` 按
     * 「关浮层 → 退全屏 → 出直播间 → 返回栈上一页 → 回首页 → 结束应用」逐级后退。
     * evaluateJavascript 是异步的，没法同步拿到结果，因此先假定前端会处理；
     * 只有脚本还没就绪（回 0）时才交还给系统。
     */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val webView = findWebView(window?.decorView)
        if (webView == null) {
            systemBack()
            return
        }
        webView.evaluateJavascript(BACK_SCRIPT) { value ->
            if (value == "0" || value == "null") {
                runOnUiThread { systemBack() }
            }
        }
    }

    /** 交回系统默认返回（AppPlugin 的 callback 和 Activity 的 finish 都在这一路里）。 */
    @Suppress("DEPRECATION")
    private fun systemBack() {
        super.onBackPressed()
    }

    companion object {
        /** 前端返回处理入口（app.js 里挂在 window 上）。回 1 表示已处理，回 0 表示还没就绪。 */
        private const val BACK_SCRIPT =
            "(function(){try{if(typeof window.__starveilBack==='function'){window.__starveilBack();return 1}}catch(e){}return 0})()"

        private var instance: MainActivity? = null

        /** enterPictureInPictureMode 会先触发 onPause，那时 isInPictureInPictureMode 还是 false。 */
        private var enteringPip = false
        private var pipActive = false

        /** 剧院模式（视频铺满）时连导航栏一起藏，其余时候只藏状态栏。 */
        private var theater = false

        /** 屏幕方向：ActivityInfo 的 0 = LANDSCAPE、1 = PORTRAIT、-1 = UNSPECIFIED。 */
        @JvmStatic
        fun setOrientation(value: Int): Boolean {
            val activity = instance ?: return false
            activity.requestedOrientation = value
            return true
        }

        /**
         * 局域网同步里显示给对端看的设备名。
         *
         * Android 没有 COMPUTERNAME 这类主机名，用「厂商 + 机型」区分最直观
         * （两台安卓设备同时出现在列表里时，不能都叫「Android 设备」）。
         */
        @JvmStatic
        fun deviceName(): String {
            val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
            val model = Build.MODEL?.trim().orEmpty()
            return when {
                model.isEmpty() -> manufacturer.ifEmpty { "Android 设备" }
                manufacturer.isEmpty() -> model
                model.startsWith(manufacturer, ignoreCase = true) -> model
                else -> "$manufacturer $model"
            }
        }

        /**
         * 分享运行日志（对应设置里「分享日志」）。
         *
         * 安卓没有「打开应用私有目录」的通用方式（Android 11 之后连 Android/data 都不让翻），
         * 所以这里落地成系统分享面板：文件通过 FileProvider 授权给接收方，
         * 用户可以直接发到微信 / 邮件，或存到本机文件。
         *
         * 日志落在 `filesDir/logs`（见 Rust 侧 `log_dir`），在 `file_paths.xml` 的
         * `files-path` 内；失败时返回原因而不是布尔值，前端才能告诉用户卡在哪。
         */
        @JvmStatic
        fun shareLog(path: String): String {
            val activity = instance ?: return "应用还没准备好"
            val file = java.io.File(path)
            if (!file.exists()) return "日志文件不存在：$path"
            return try {
                val uri = androidx.core.content.FileProvider.getUriForFile(
                    activity,
                    "${activity.packageName}.fileprovider",
                    file,
                )
                val intent = Intent(Intent.ACTION_SEND).apply {
                    // .log 没有公认的 MIME，写 text/plain 时微信/QQ 会拒收，用 */* 最稳。
                    type = "*/*"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, "Starveil 日志")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                activity.startActivity(Intent.createChooser(intent, "分享日志"))
                ""
            } catch (error: Exception) {
                // 多半是 FileProvider 路径没覆盖到，或没有能接收的应用。
                "${error.javaClass.simpleName}: ${error.message ?: "未知原因"}"
            }
        }

        /**
         * 分享一段文本（日志面板的「分享」）。
         *
         * 文本比文件更容易被聊天工具接住，用户不必先存下来再发。
         */
        @JvmStatic
        fun shareText(text: String): String {
            val activity = instance ?: return "应用还没准备好"
            if (text.isBlank()) return "没有可分享的内容"
            return try {
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                    putExtra(Intent.EXTRA_SUBJECT, "Starveil 日志")
                }
                activity.startActivity(Intent.createChooser(intent, "分享日志"))
                ""
            } catch (error: Exception) {
                "${error.javaClass.simpleName}: ${error.message ?: "未知原因"}"
            }
        }

        /**
         * 系统栏配色跟随前端主题。
         *
         * `color` 是 ARGB int，`light` 为 1 表示背景是浅色、状态栏图标要用深色。
         * 系统栏本身透明，状态栏那条由窗口底色与页面底色铺；窗口底色也换成主题色，
         * 首帧和系统栏动画期间不会闪出 Material 默认的纯黑。
         */
        @Suppress("DEPRECATION")
        @JvmStatic
        fun setSystemBar(color: Int, light: Int): Boolean {
            val activity = instance ?: return false
            activity.runOnUiThread {
                val window = activity.window ?: return@runOnUiThread
                window.statusBarColor = Color.TRANSPARENT
                window.navigationBarColor = Color.TRANSPARENT
                window.setBackgroundDrawable(ColorDrawable(color))
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // 不透明内容上的系统栏底衬会盖掉主题色，关掉。
                    window.isStatusBarContrastEnforced = false
                    window.isNavigationBarContrastEnforced = false
                }
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                controller.isAppearanceLightStatusBars = light != 0
                controller.isAppearanceLightNavigationBars = light != 0
                activity.pushSafeInsets()
            }
            return true
        }

        /** 是否正在系统小窗里。前端靠它决定什么时候退出「只留视频」的布局。 */
        @JvmStatic
        fun isInPip(): Boolean = instance?.isInPictureInPictureMode ?: false

        /**
         * 沉浸式全屏：藏起状态栏与导航栏，退出时回到常显。
         *
         * Android WebView 不实现 `requestFullscreen()`（没有 WebChromeClient 的全屏回调），
         * 所以前端的全屏是「CSS 铺满 + 这里把系统栏藏掉」两半拼出来的。
         * 窗口始终铺满整屏（`decorFitsSystemWindows` 在 onCreate 就关掉了），
         * 这里只改系统栏的显隐，`--safe-*` 由全屏档在 CSS 侧归零。
         * `enabled` 用 Int 而不是 Boolean，是为了对齐 Rust 侧 `call_activity_static`
         * 固定的 `(I)Z` 签名（和 setOrientation 一致）。
         */
        @JvmStatic
        fun setImmersive(enabled: Int): Boolean {
            val activity = instance ?: return false
            val on = enabled != 0
            activity.runOnUiThread {
                theater = on
                activity.syncSystemBars()
            }
            return true
        }

        /** 返回键退到无处可退时结束应用。用 finishAffinity 而不是杀进程，任务栈才干净。 */
        @JvmStatic
        fun finishApp(): Boolean {
            val activity = instance ?: return false
            activity.runOnUiThread { activity.finishAffinity() }
            return true
        }

        /**
         * 用外部浏览器打开链接。
         *
         * WebView 里的 `window.open` 会被 Tauri 拦下（没有第二个窗口），
         * 所以「在浏览器打开」只能交给系统 Intent。
         */
        @JvmStatic
        fun openUrl(url: String): Boolean {
            val activity = instance ?: return false
            return try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
                true
            } catch (error: Throwable) {
                false
            }
        }

        /** 写系统剪贴板（「复制链接」「复制直播流」用）。 */
        @JvmStatic
        fun copyText(text: String): Boolean {
            val activity = instance ?: return false
            return try {
                val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                manager.setPrimaryClip(ClipData.newPlainText("Starveil", text))
                true
            } catch (error: Throwable) {
                false
            }
        }

        /** 进入系统画中画（小窗）。API 26 以下没有这个能力，直接返回 false。 */
        @JvmStatic
        fun enterPip(): Boolean {
            val activity = instance ?: return false
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
            if (activity.isInPictureInPictureMode) return true
            return try {
                val params = PictureInPictureParams.Builder()
                    .setAspectRatio(Rational(16, 9))
                    .build()
                enteringPip = true
                val entered = activity.enterPictureInPictureMode(params)
                if (!entered) enteringPip = false
                entered
            } catch (error: Throwable) {
                enteringPip = false
                false
            }
        }
    }
}
