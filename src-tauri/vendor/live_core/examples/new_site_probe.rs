//! 抖音 / 快手取流诊断：打印详情、清晰度与直链。
//!
//! ```bash
//! cargo run -p live_core --example new_site_probe -- douyin 7701555509979188010
//! cargo run -p live_core --example new_site_probe -- kuaishou 3xrtyiaanrmtd5c
//! ```

use live_core::{LiveCore, Platform};

fn main() {
    let mut args = std::env::args().skip(1);
    let platform = args.next().unwrap_or_else(|| "douyin".to_string());
    let room_id = args
        .next()
        .unwrap_or_else(|| "7701555509979188010".to_string());
    let platform = if platform == "kuaishou" {
        Platform::Kuaishou
    } else {
        Platform::Douyin
    };

    let core = LiveCore::new();
    match core.detail(platform, &room_id) {
        Ok(detail) => {
            println!("平台 {} 房间 {}", detail.platform.name(), detail.room_id);
            println!("  标题 {}", detail.title);
            println!("  主播 {}", detail.user_name);
            println!("  在播 {} 人气 {}", detail.live, detail.online);
            println!("  封面 {}", detail.cover.chars().take(80).collect::<String>());
            println!("  头像 {}", detail.avatar.chars().take(80).collect::<String>());

            match core.qualities(&detail) {
                Ok(qualities) => {
                    println!("  清晰度 {}", qualities.len());
                    for quality in qualities.iter().take(4) {
                        println!("    - {}", quality.name);
                    }
                    if let Some(quality) = qualities.first() {
                        match core.play(&detail, quality) {
                            Ok(play) => {
                                println!("  FLV {} 条 / HLS {} 条", play.urls.len(), play.hls_urls.len());
                                for url in play.urls.iter().take(2) {
                                    println!("    {}", url.chars().take(110).collect::<String>());
                                }
                            }
                            Err(error) => println!("  取流失败：{error}"),
                        }
                    }
                }
                Err(error) => println!("  清晰度失败：{error}"),
            }
        }
        Err(error) => println!("详情失败：{error}"),
    }

    match core.recommend(platform, 1) {
        Ok(items) => {
            println!("推荐 {} 条", items.len());
            for item in items.iter().take(3) {
                println!(
                    "  - {} | {} | 人气 {}",
                    item.user_name, item.title, item.online
                );
            }
        }
        Err(error) => println!("推荐失败：{error}"),
    }

    if platform == Platform::Kuaishou {
        match core.categories(platform) {
            Ok(list) => {
                println!(
                    "分类 {} 组：{}",
                    list.len(),
                    list.iter()
                        .map(|category| format!("{}({})", category.name, category.children.len()))
                        .collect::<Vec<_>>()
                        .join(" ")
                );
                if let Some(sub) = list.iter().find_map(|category| category.children.first()) {
                    match core.category_rooms(platform, sub, 1) {
                        Ok(items) => println!("分区 {} 房间 {} 条", sub.name, items.len()),
                        Err(error) => println!("分区失败：{error}"),
                    }
                }
            }
            Err(error) => println!("分类失败：{error}"),
        }
        match core.search(platform, "英雄联盟") {
            Ok(items) => println!("搜索 {} 条", items.len()),
            Err(error) => println!("搜索失败：{error}"),
        }
    }
}
