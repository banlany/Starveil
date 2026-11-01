import groovy.json.JsonSlurper
import java.util.Properties

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

// ── release 签名 ────────────────────────────────────────────────────────────
//
// 以前这里没配 signingConfigs，CI 每次跑都现造一个 debug keystore 去签——
// runner 是干净环境，`~/.android/debug.keystore` 每次都是新的密钥对，
// 于是每个版本的签名都不同。安卓覆盖安装要求「包名 + 签名都相同」，
// 结果是用户每次升级都得先卸载（数据一起没了），报错还只说「应用未安装」。
//
// 现在固定用 keystore/starveil-release.jks（36500 天有效期，够用一辈子）：
//   本地 → keystore.properties 指路（两份都不入库）
//   CI   → Secrets 里的 base64 jks 解成文件，用 STARVEIL_* 环境变量指路
// 两样都没有时 release 仍出 unsigned（本地 `cargo tauri android build` 不因此报错），
// 但 CI 那边会直接失败：签不出固定指纹的包就别发。
val keystoreProps = Properties()
run {
    val propsFile = rootProject.file("keystore.properties")
    if (propsFile.exists()) propsFile.inputStream().use { keystoreProps.load(it) }
}

// 环境变量优先（CI），其次 keystore.properties（本地）。
fun signingValue(propKey: String, envKey: String): String? =
    System.getenv(envKey)?.takeIf { it.isNotBlank() }
        ?: keystoreProps.getProperty(propKey)?.takeIf { it.isNotBlank() }

val releaseKeystore: File? = signingValue("storeFile", "STARVEIL_KEYSTORE_FILE")?.let { raw ->
    val f = File(raw)
    // 相对路径按 gen/android 解析，和 keystore.properties 里写的一致。
    if (f.isAbsolute) f else rootProject.file(raw)
}

val hasReleaseKeystore: Boolean = releaseKeystore?.exists() == true

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
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = releaseKeystore!!
                storePassword = signingValue("storePassword", "STARVEIL_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "STARVEIL_KEY_ALIAS")
                keyPassword = signingValue("keyPassword", "STARVEIL_KEY_PASSWORD")
                // minSdk 24 只认 v2 就够，v1 顺手开着，防个别老 ROM 的校验器。
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
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
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "release 没有配置签名（缺 keystore.properties / STARVEIL_* 环境变量），" +
                        "产物会是 unsigned，装不上；CI 里这属于致命错误。"
                )
            }
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