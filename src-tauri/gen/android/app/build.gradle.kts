import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

// 版本号只认 `tauri.conf.json`。
//
// 以前是从 `app/tauri.properties` 读的，那文件是 CLI 生成物（在 app/.gitignore 里），
// 实测并不会跟着 `tauri.conf.json` 刷新——0.6.1 就漏了它，APK 装到手机上还写着 0.6.0，
// 而构建全程不报错。现在直接解析 conf，改版本只改一处。
val appVersion: String = run {
    val conf = file("../../../tauri.conf.json")
    val parsed = if (conf.exists()) JsonSlurper().parse(conf) as? Map<*, *> else null
    (parsed?.get("version") as? String)?.takeIf { it.isNotBlank() } ?: "0.0.1"
}

// versionCode = major*10000000 + minor*100000 + patch*1000（缺位当 0），
// 0.6.1 → 61000。位宽留够，minor/patch 各到 99 都不会撞车，
// 也就不会出现「新版本号反而更小、系统不给升级」这种坑。
val appVersionCode: Int = appVersion
    .split(".")
    .map { part -> part.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
    .let { (it.getOrNull(0) ?: 0) * 10_000_000 + (it.getOrNull(1) ?: 0) * 100_000 + (it.getOrNull(2) ?: 0) * 1_000 }

android {
    compileSdk = 34
    namespace = "com.banlany.starveil"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.banlany.starveil"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersion
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.6.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.8.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")