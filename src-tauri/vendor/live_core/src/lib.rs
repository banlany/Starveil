//! 聚合直播协议层。
//!
//! 本 crate 不依赖任何 UI 框架：它只把三个直播平台各自的私有接口收敛成
//! [`LiveSite`](site::LiveSite) 一个抽象，供 GUI / CLI / TUI 复用。

pub mod bilibili;
pub mod danmaku;
pub mod douyin;
mod douyin_im;
pub mod douyu;
pub mod douyu_sign;
pub mod error;
pub mod http;
pub mod huya;
pub(crate) mod huya_token;
pub mod kuaishou;
pub mod model;
pub mod site;
pub mod url_parser;

mod util;
mod wbi;

pub use danmaku::{DanmakuMessage, DanmakuSession, DanmakuStatus};
pub use error::LiveError;
pub use http::HttpSession;
pub use model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
    QualityData, QuerySign,
};
pub use site::{LiveCore, LiveSite};

/// 日志出口：主程序启动时注册，把这里的运行信息接到它自己的日志文件里。
/// 没注册时退回标准错误，方便单独跑本 crate 的测试。
static LOG_SINK: std::sync::OnceLock<Box<dyn Fn(&str) + Send + Sync>> = std::sync::OnceLock::new();

/// 注册日志出口，重复调用只有第一次生效。
pub fn set_log_sink(sink: impl Fn(&str) + Send + Sync + 'static) {
    let _ = LOG_SINK.set(Box::new(sink));
}

/// 记录一条运行信息（协议层的异常路径、重连等），不承载业务数据。
pub(crate) fn log(message: impl AsRef<str>) {
    match LOG_SINK.get() {
        Some(sink) => sink(message.as_ref()),
        None => eprintln!("[live_core] {}", message.as_ref()),
    }
}
