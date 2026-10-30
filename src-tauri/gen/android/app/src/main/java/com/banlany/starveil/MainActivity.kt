package com.banlany.starveil

import android.app.PictureInPictureParams
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
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
         * 系统栏配色跟随前端主题。
         *
         * `color` 是 ARGB int，`light` 为 1 表示背景是浅色、状态栏图标要用深色。
         * 主题资源里的固定色（`@color/starveil_status_bar`）只是首帧兜底，
         * 启动后由前端调这里覆盖，否则浅色主题下状态栏一直是黑的。
         */
        @Suppress("DEPRECATION")
        @JvmStatic
        fun setSystemBar(color: Int, light: Int): Boolean {
            val activity = instance ?: return false
            activity.runOnUiThread {
                val window = activity.window ?: return@runOnUiThread
                window.statusBarColor = color
                window.navigationBarColor = color
                var flags = window.decorView.systemUiVisibility
                flags = if (light != 0) {
                    flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
                        View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                } else {
                    flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv() and
                        View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                }
                window.decorView.systemUiVisibility = flags
            }
            return true
        }

        /** 是否正在系统小窗里。前端靠它决定什么时候退出「只留视频」的布局。 */
        @JvmStatic
        fun isInPip(): Boolean = instance?.isInPictureInPictureMode ?: false

        /**
         * 沉浸式全屏：藏起状态栏与导航栏，退出时恢复。
         *
         * Android WebView 不实现 `requestFullscreen()`（没有 WebChromeClient 的全屏回调），
         * 所以前端的全屏是「CSS 铺满 + 这里把系统栏藏掉」两半拼出来的。
         * `enabled` 用 Int 而不是 Boolean，是为了对齐 Rust 侧 `call_activity_static`
         * 固定的 `(I)Z` 签名（和 setOrientation 一致）。
         */
        @JvmStatic
        fun setImmersive(enabled: Int): Boolean {
            val activity = instance ?: return false
            val on = enabled != 0
            activity.runOnUiThread {
                val window = activity.window ?: return@runOnUiThread
                val controller = WindowInsetsControllerCompat(window, window.decorView)
                if (on) {
                    WindowCompat.setDecorFitsSystemWindows(window, false)
                    controller.systemBarsBehavior =
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    controller.hide(WindowInsetsCompat.Type.systemBars())
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars())
                    WindowCompat.setDecorFitsSystemWindows(window, true)
                }
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
