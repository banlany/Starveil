//! 聚合直播协议层。
//!
//! 本 crate 不依赖任何 UI 框架：它只把三个直播平台各自的私有接口收敛成
//! [`LiveSite`](site::LiveSite) 一个抽象，供 GUI / CLI / TUI 复用。

pub mod bilibili;
pub mod danmaku;
pub mod douyu;
pub mod douyu_sign;
pub mod error;
pub mod http;
pub mod huya;
mod huya_token;
pub mod model;
pub mod site;
pub mod url_parser;

mod util;
mod wbi;

pub use danmaku::{DanmakuMessage, DanmakuSession};
pub use error::LiveError;
pub use http::HttpSession;
pub use model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
    QualityData,
};
pub use site::{LiveCore, LiveSite};
