//! 取到抖音/快手的 FLV 直链后，用 reqwest 自己拉一次，看状态码与前几个字节。
//!
//! ```bash
//! cargo run --example flv_fetch -- douyin 52287020735
//! cargo run --example flv_fetch -- kuaishou 3xrtyiaanrmtd5c
//! ```
//!
//! 用于区分「上游直链不可用」和「本地代理逻辑有问题」：
//! 播放器报 HttpStatusCodeInvalid 说明它拿到的不是 200，而这里能看到上游真实状态。

use live_core::{LiveCore, Platform};
use std::io::Read;
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let platform = args.next().unwrap_or_else(|| "douyin".to_string());
    let room_id = args
        .next()
        .unwrap_or_else(|| "52287020735".to_string());
    let platform = if platform == "kuaishou" {
        Platform::Kuaishou
    } else if platform == "bilibili" {
        Platform::Bilibili
    } else if platform == "huya" {
        Platform::Huya
    } else {
        Platform::Douyin
    };

    let core = LiveCore::new();
    let detail = match core.detail(platform, &room_id) {
        Ok(detail) => detail,
        Err(error) => {
            println!("详情失败：{error}");
            return;
        }
    };
    let qualities = match core.qualities(&detail) {
        Ok(qualities) => qualities,
        Err(error) => {
            println!("清晰度失败：{error}");
            return;
        }
    };
    let Some(quality) = qualities.first() else {
        println!("没有清晰度");
        return;
    };
    let play = match core.play(&detail, quality) {
        Ok(play) => play,
        Err(error) => {
            println!("取流失败：{error}");
            return;
        }
    };
    println!("FLV {} / HLS {}", play.urls.len(), play.hls_urls.len());

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("client");
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &play.headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(value),
        ) {
            headers.insert(name, value);
        }
    }
    println!("请求头 {:?}", headers.keys().collect::<Vec<_>>());

    let mut targets: Vec<&String> = play.urls.iter().collect();
    targets.extend(play.hls_urls.iter());
    for url in targets.into_iter().take(4) {
        println!("\n== {}", url.chars().take(120).collect::<String>());
        let room_referer = match platform {
            Platform::Douyin => format!("https://live.douyin.com/{room_id}"),
            Platform::Kuaishou => format!("https://live.kuaishou.com/u/{room_id}"),
            Platform::Bilibili => format!("https://live.bilibili.com/{room_id}"),
            Platform::Huya => format!("https://www.huya.com/{room_id}"),
            _ => String::new(),
        };
        for (label, extra) in [
            ("接口给的头", Some(headers.clone())),
            ("房间页 Referer", Some({
                let mut map = headers.clone();
                map.insert(
                    reqwest::header::REFERER,
                    reqwest::header::HeaderValue::from_str(&room_referer).expect("referer"),
                );
                map
            })),
            // WebView 里 hls.js 发不了自定义头，Referer 只能是页面自身的来源。
            ("WebView 默认 Referer", Some({
                let mut map = reqwest::header::HeaderMap::new();
                map.insert(
                    reqwest::header::REFERER,
                    reqwest::header::HeaderValue::from_str("http://tauri.localhost/").expect("referer"),
                );
                map
            })),
            ("完全裸请求", None),
        ] {
            match client.get(url).headers(extra.unwrap_or_default()).send() {
                Ok(mut response) => {
                    let status = response.status();
                    let mut head = [0u8; 16];
                    let count = response.read(&mut head).unwrap_or(0);
                    println!(
                        "  {label}: {} 类型 {:?} 前 {count} 字节 {:02x?}",
                        status,
                        response.headers().get("content-type"),
                        &head[..count.min(8)]
                    );
                }
                Err(error) => println!("  {label}: 请求失败 {error}"),
            }
        }
    }
}
