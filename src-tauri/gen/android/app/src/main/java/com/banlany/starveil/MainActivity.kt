package com.banlany.starveil

import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView

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

    companion object {
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

        /** 是否正在系统小窗里。前端靠它决定什么时候退出「只留视频」的布局。 */
        @JvmStatic
        fun isInPip(): Boolean = instance?.isInPictureInPictureMode ?: false

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
