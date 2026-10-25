//! 联网体检：默认不跑（平台改版、风控、房间下播都会让它失败）。
//!
//! ```bash
//! cargo test -p live_core --test network -- --ignored --nocapture
//! ```
//!
//! 它的价值不是「必须永远绿」，而是在平台改版时第一时间告诉你哪一环断了。

use live_core::{LiveCore, LiveRoomItem, Platform};

fn core() -> LiveCore {
    LiveCore::new()
}

/// 三站搜索都要能返回结构化结果。
#[test]
#[ignore]
fn 三站搜索都能返回结果() {
    let core = core();
    for platform in Platform::ALL {
        let started = std::time::Instant::now();
        let items = core
            .search(platform, "英雄联盟")
            .unwrap_or_else(|error| panic!("{} 搜索失败：{error}", platform.name()));
        println!(
            "{} 搜索到 {} 条，耗时 {:?}",
            platform.name(),
            items.len(),
            started.elapsed()
        );
        assert!(
            !items.is_empty(),
            "{} 搜索返回空列表，可能接口结构变了",
            platform.name()
        );
        let first = &items[0];
        assert!(!first.room_id.is_empty());
        assert!(!first.title.is_empty());
    }
}

/// 三站房间头都要能读出来。
#[test]
#[ignore]
fn 三站房间头可读() {
    let core = core();
    for (platform, room_id) in [
        (Platform::Bilibili, "21452505"),
        (Platform::Huya, "998"),
        (Platform::Douyu, "9999"),
    ] {
        let detail = core
            .detail(platform, room_id)
            .unwrap_or_else(|error| panic!("{} 房间 {room_id} 读取失败：{error}", platform.name()));
        println!(
            "{} #{} {} | 主播 {} | 在播 {} | 人气 {}",
            platform.name(),
            detail.room_id,
            detail.title,
            detail.user_name,
            detail.live,
            detail.online
        );
        assert!(!detail.title.is_empty(), "{} 标题为空", platform.name());
        assert!(
            detail.url.starts_with("https://"),
            "{} 房间地址不对：{}",
            platform.name(),
            detail.url
        );
    }
}

/// B 站与虎牙：从搜索结果里挑一个正在直播的房间，走完「清晰度 → 直链」，必须成功。
#[test]
#[ignore]
fn b站与虎牙取流链路() {
    let core = core();
    for platform in [Platform::Bilibili, Platform::Huya] {
        let items = core.search(platform, "英雄联盟").expect("搜索");
        let mut done = false;

        for item in items.iter().take(8) {
            let LiveRoomItem { room_id, .. } = item;
            let Ok(detail) = core.detail(platform, room_id) else {
                continue;
            };
            if !detail.live {
                continue;
            }
            let qualities = core
                .qualities(&detail)
                .unwrap_or_else(|error| panic!("{} 取清晰度失败：{error}", platform.name()));
            assert!(!qualities.is_empty(), "{} 清晰度为空", platform.name());

            let quality = &qualities[0];
            let urls = core
                .play(&detail, quality)
                .unwrap_or_else(|error| panic!("{} 取流失败：{error}", platform.name()));
            println!(
                "{} #{} 清晰度 {} → {} 条直链，首条：{}",
                platform.name(),
                detail.room_id,
                quality.name,
                urls.urls.len(),
                urls.urls[0].chars().take(110).collect::<String>()
            );
            assert!(!urls.urls.is_empty());
            done = true;
            break;
        }

        assert!(done, "{} 没有找到正在直播的房间，无法校验取流", platform.name());
    }
}

/// 斗鱼：房间头必须能读；取流依赖平台下发的混淆签名脚本，
/// 目前本地 JS 引擎跑不通，因此这里只要求「成功或有明确降级提示」。
#[test]
#[ignore]
fn 斗鱼取流或给出降级提示() {
    let core = core();
    let items = core.search(Platform::Douyu, "英雄联盟").expect("搜索");
    for item in items.iter().take(8) {
        let Ok(detail) = core.detail(Platform::Douyu, &item.room_id) else {
            continue;
        };
        if !detail.live {
            continue;
        }
        match core.qualities(&detail) {
            Ok(qualities) => {
                assert!(!qualities.is_empty());
                match core.play(&detail, &qualities[0]) {
                    Ok(urls) => {
                        println!("斗鱼取流成功：{} 条直链", urls.urls.len());
                        assert!(!urls.urls.is_empty());
                    }
                    Err(error) => {
                        println!("斗鱼取流降级（预期内）：{error}");
                        assert!(
                            matches!(error, live_core::LiveError::Unsupported(_)),
                            "降级提示应当是 Unsupported，实际：{error:?}"
                        );
                    }
                }
            }
            Err(error) => {
                println!("斗鱼取清晰度降级（预期内）：{error}");
                assert!(
                    matches!(error, live_core::LiveError::Unsupported(_)),
                    "降级提示应当是 Unsupported，实际：{error:?}"
                );
            }
        }
        return;
    }
    println!("斗鱼没有找到正在直播的房间，跳过");
}
