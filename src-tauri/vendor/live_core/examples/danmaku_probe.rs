//! 弹幕链路探针：不进 UI，直接连弹幕服务器并打印收到的消息。
//!
//! ```bash
//! cargo run -p live_core --example danmaku_probe -- bilibili 1756754520
//! cargo run -p live_core --example danmaku_probe -- douyu 9999
//! ```

use live_core::{DanmakuSession, LiveCore, Platform};
use std::time::{Duration, Instant};

fn main() {
    let platform = std::env::args().nth(1).unwrap_or_else(|| "bilibili".into());
    let room = std::env::args().nth(2).unwrap_or_else(|| "1756754520".into());
    let seconds: u64 = std::env::args()
        .nth(3)
        .and_then(|value| value.parse().ok())
        .unwrap_or(20);
    let platform = Platform::from_id(&platform).expect("平台 id");

    let core = LiveCore::new();
    let detail = match core.detail(platform, &room) {
        Ok(detail) => detail,
        Err(error) => {
            println!("取房间失败：{error}");
            return;
        }
    };
    println!(
        "房间 {} [{}] 在播={}",
        detail.room_id, detail.title, detail.live
    );

    let session = match DanmakuSession::start(platform, &detail.extra) {
        Ok(session) => session,
        Err(error) => {
            println!("启动弹幕失败：{error}");
            return;
        }
    };

    let started = Instant::now();
    let mut total = 0usize;
    let mut with_emoji = 0usize;
    let mut big = 0usize;
    // 「大表情的 key 不等于整条正文」＝ 后端把一条普通弹幕误判成了大表情，
    // 前端会拿整段文字去换一张两行高的图，表现为弹幕突然变成一个巨大的表情块。
    let mut suspicious = 0usize;
    while started.elapsed() < Duration::from_secs(seconds) {
        for message in session.drain() {
            total += 1;
            let text = message.text.clone();
            let Some(list) = message.emoticons.as_ref() else {
                continue;
            };
            with_emoji += 1;
            for emoticon in list {
                if emoticon.big {
                    big += 1;
                    if emoticon.key.trim() != text.trim() {
                        suspicious += 1;
                        println!(
                            "⚠ 大表情 key 与正文不符  key={:?} text={:?} {}x{}",
                            emoticon.key, text, emoticon.width, emoticon.height
                        );
                    } else {
                        println!(
                            "大表情 key={:?} {}x{} {}",
                            emoticon.key,
                            emoticon.width,
                            emoticon.height,
                            emoticon.url
                        );
                    }
                } else {
                    println!(
                        "小表情 key={:?} {}x{}  整条={:?}",
                        emoticon.key, emoticon.width, emoticon.height, text
                    );
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!(
        "{seconds} 秒共 {total} 条，带表情 {with_emoji} 条（大表情 {big} 个，可疑 {suspicious} 个）"
    );
}
