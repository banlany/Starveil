# 致谢与第三方许可

星幕直播（Starveil）本身以 **GPL-3.0** 发布（见 [LICENSE](LICENSE)）。
本项目能跑起来，靠的是下面这些上游项目、开源库与素材，特此致谢并保留其原始声明。

> 说明：本文件只做署名与许可声明，不改变任何上游代码自身的许可。
> 若你是某个项目的作者并希望调整署名方式，请开 issue。

---

## 一、协议层来源（重点）

直播平台的取流与弹幕都是各站私有接口，本项目**没有从零逆向**，而是移植自下列项目。
移植过来的代码保留 GPL-3.0 授权，并在对应源文件头部标注了来源。

| 项目 | 作者 | 许可 | 本项目用到什么 |
|------|------|------|----------------|
| [dart_simple_live](https://github.com/xiaoyaocz/dart_simple_live) | xiaoyaocz | GPL-3.0 | 界面与交互的参照物；`simple_live_core` 的协议思路 |
| [simple_live_core](https://github.com/xiaoyaocz/dart_simple_live/tree/main/simple_live_core) | xiaoyaocz | GPL-3.0 | B 站 / 斗鱼 / 虎牙取流与弹幕协议，`live_core` 的主要参照 |
| [AllLive](https://github.com/AllLive/AllLive) | AllLive | — | 早期「多平台聚合」的思路参考 |
| [simple-live-kuaishou](https://github.com/xuanxuan123xuan/simple-live-kuaishou) | xuanxuan123xuan | — | 快手完整支持（取流 + 弹幕）的来源 |

### 抖音 `a_bogus` 签名脚本

抖音取流依赖 `a_bogus` 参数，其签名逻辑以混淆 JavaScript 形式在页面下发。
本项目直接沿用 dart 版 `simple_live_core` 内置的 `douyin_sign.dart` 脚本内容
（`lib/src/scripts/douyin_sign.dart`），在 WebView 内执行后回填参数。

> **该脚本的原始作者声明为「仅供学习交流，禁止用于商业用途与违法用途」。**
> 本项目同样只用于个人学习与技术研究，不提供任何商业化服务。
> 脚本的著作权归原作者所有，本项目仅作技术研究用途的转发，不代表对其授权范围的扩展。
> 如果你是该脚本的作者并希望移除，请联系我们，我们会立刻删除相关代码。

### 抖音游戏分类素材

抖音「游戏」二级分类的封面素材来自 dart 版的 `DouyinGameArtwork`
（`lib/src/common/douyin_game_artwork.dart`），其来源包括 App Store、Steam、
爱给网、FLATICON、iconfont 等。

> **这些素材仅限非商业使用**，其版权归原始权利人所有，不并入本项目的 GPL-3.0 授权。
> 下游 fork 请保留来源说明，并自行确认使用场景是否合规。

---

## 二、开源库（随程序分发）

| 库 | 许可 | 用途 | 位置 |
|----|------|------|------|
| [Tauri](https://github.com/tauri-apps/tauri) 2 | MIT / Apache-2.0 | 桌面外壳、IPC、窗口管理 | `src-tauri/` |
| [mpegts.js](https://github.com/xqq/mpegts.js) 4.2.8 | Apache-2.0 | FLV 解封装 + MSE 播放 | `web/vendor/mpegts.js` |
| [hls.js](https://github.com/video-dev/hls.js) 1.x | Apache-2.0 | HLS（m3u8）播放 | `web/vendor/hls.js` |
| [fly-barrage](https://github.com/kojika17/fly-barrage) | MIT | 弹幕渲染（虚拟轨道 + Canvas） | `web/vendor/fly-barrage.js` |
| [CryptoJS](https://github.com/brix/crypto-js) | MIT | 斗鱼签名脚本执行环境 | `web/vendor/cryptojs.js` |
| [qrcode](https://github.com/soldair/node-qrcode) | MIT | B 站扫码登录二维码 | `web/vendor/qrcode.js` |
| [reqwest](https://github.com/seanmonstar/reqwest) | MIT / Apache-2.0 | HTTP 客户端 | `live_core` |
| [tungstenite](https://github.com/snapview/tungstenite-rs) | MIT / Apache-2.0 | 弹幕 WebSocket | `live_core` |
| [rustls](https://github.com/rustls/rustls) | Apache-2.0 / ISC / MIT | TLS（移动端跨平台） | `live_core` |
| [serde](https://github.com/serde-rs/serde) / [serde_json](https://github.com/serde-rs/json) | MIT / Apache-2.0 | 序列化 | 全局 |
| [brotli](https://github.com/dropbox/rust-brotli) / [flate2](https://github.com/rust-lang/flate2-rs) | MIT / Apache-2.0 | B 站弹幕压缩包解压 | `live_core` |
| [base64](https://github.com/marshallpierce/rust-base64) / [md5](https://github.com/stainless-steel/md5) | MIT / Apache-2.0 | 签名计算 | `live_core` |

完整的传递依赖清单见 `src-tauri/Cargo.lock`，各库许可可在 crates.io 对应页查得。

---

## 三、素材与商标

- 应用图标、Logo、界面配色与排版为本人绘制 / 自行设计。
- 「哔哩哔哩」「斗鱼」「虎牙」「抖音」「快手」等名称与图标是各公司的商标，
  本项目仅用于指示所对接的平台，与各公司无任何隶属或合作关系。
- 直播间封面、主播头像等图片均直接引用各平台 CDN 地址，**不做存储与转存**。

---

## 四、免责声明

本项目仅用于个人学习与技术研究：

- 不提供、不存储、不转播任何直播内容；
- 不绕过平台的付费 / 会员 / 地区限制；
- 所有直播流、弹幕、图片的版权归各平台及主播所有。

请遵守所在地区法律法规与各平台服务条款。因使用本项目产生的任何纠纷或损失，
开发者不承担责任。如果你不希望自己的直播间被展示，请通过平台渠道联系下架。
