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
        "房间 {} [{}] 在播={} 上下文={:?}",
        detail.room_id, detail.title, detail.live, detail.extra
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
    while started.elapsed() < Duration::from_secs(15) {
        for message in session.drain() {
            total += 1;
            if total <= 20 {
                println!(
                    "{:>4}s {}{}",
                    started.elapsed().as_secs(),
                    if message.system { "[系统] " } else { "" },
                    if message.system {
                        message.text
                    } else {
                        format!("{}：{}", message.user, message.text)
                    }
                );
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("15 秒共收到 {total} 条");
}
