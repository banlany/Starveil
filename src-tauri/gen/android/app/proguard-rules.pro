# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# release 开了 minify，而屏幕方向/小窗/系统栏/剪贴板/开链接都是 Rust 侧用
# `call_static_method` 按方法名调 MainActivity 的静态方法（见 src-tauri/src/lib.rs
# 的 call_activity_static）。R8 只认得 manifest 里声明的类名，方法名会被改名或裁掉，
# 结果就是 release 包里这些功能全部失效。这里把 MainActivity 的方法名整类保住。
-keepclassmembers class com.banlany.starveil.MainActivity {
    public static <methods>;
}