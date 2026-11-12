//! 抖音取流诊断：打印 `stream_url` 的全部结构，重点看有没有比 `flv_pull_url` 更高的档位。
//!
//! ```bash
//! cargo run -p live_core --example douyin_stream_probe -- 7701555509979188010
//! ```

use live_core::{LiveCore, Platform};

fn main() {
    let rid = std::env::args().nth(1).expect("需要房间号");
    let core = LiveCore::new();
    let detail = core
        .detail(Platform::Douyin, &rid)
        .expect("取房间详情失败");
    println!("主播: {} 标题: {} 开播: {}", detail.user_name, detail.title, detail.live);

    let qualities = core.qualities(&detail).expect("取清晰度失败");
    println!(
        "清晰度: {:?}",
        qualities.iter().map(|item| item.name.as_str()).collect::<Vec<_>>()
    );

    let live_core::model::RoomExtra::Douyin { stream_url, .. } = &detail.extra else {
        println!("不是抖音房间");
        return;
    };
    if let Some(map) = stream_url.get("flv_pull_url").and_then(|value| value.as_object()) {
        println!("flv_pull_url 档位: {:?}", map.keys().collect::<Vec<_>>());
        for (key, value) in map {
            let url = value.as_str().unwrap_or_default();
            println!("  {key}: {}", url.split('?').next().unwrap_or(url));
        }
    }
    if let Some(map) = stream_url
        .get("hls_pull_url_map")
        .and_then(|value| value.as_object())
    {
        println!("hls_pull_url_map 档位: {:?}", map.keys().collect::<Vec<_>>());
        for (key, value) in map {
            let url = value.as_str().unwrap_or_default();
            println!("  {key}: {}", url.split('?').next().unwrap_or(url));
        }
    }
    println!(
        "stream_url 顶层字段: {:?}",
        stream_url
            .as_object()
            .map(|map| map.keys().collect::<Vec<_>>())
            .unwrap_or_default()
    );
    if let Some(sdk) = stream_url.get("live_core_sdk_data") {
        let pull = sdk.get("pull_data").cloned().unwrap_or_default();
        if let Some(options) = pull.get("options") {
            println!("default_quality: {}", options.get("default_quality").map(|v| v.to_string()).unwrap_or_default());
            if let Some(list) = options.get("qualities").and_then(|value| value.as_array()) {
                for item in list {
                    println!(
                        "  sdk_key={} name={} res={} fps={} level={} bitrate={} codec={}",
                        item.get("sdk_key").and_then(|v| v.as_str()).unwrap_or("-"),
                        item.get("name").and_then(|v| v.as_str()).unwrap_or("-"),
                        item.get("resolution").and_then(|v| v.as_str()).unwrap_or("-"),
                        item.get("fps").and_then(|v| v.as_i64()).unwrap_or(0),
                        item.get("level").and_then(|v| v.as_i64()).unwrap_or(0),
                        item.get("v_bit_rate").and_then(|v| v.as_i64()).unwrap_or(0),
                        item.get("v_codec").and_then(|v| v.as_str()).unwrap_or("-"),
                    );
                }
            }
        }
        if let Some(text) = pull.get("stream_data").and_then(|value| value.as_str()) {
            println!("stream_data 长度 {}", text.len());
            match serde_json::from_str::<serde_json::Value>(text) {
                Ok(value) => {
                    let data = value.get("data").cloned().unwrap_or_default();
                    for (quality, entry) in data.as_object().into_iter().flatten() {
                        let main = entry.get("main").cloned().unwrap_or_default();
                        let flv = main.get("flv").and_then(|v| v.as_str()).unwrap_or("");
                        let hls = main.get("hls").and_then(|v| v.as_str()).unwrap_or("");
                        println!(
                            "  [{quality}] flv={} hls={}",
                            flv.split('?').next().unwrap_or(""),
                            hls.split('?').next().unwrap_or("")
                        );
                    }
                }
                Err(error) => println!("  stream_data 解析失败: {error}"),
            }
        } else {
            println!("  没有 stream_data；pull_data 字段: {:?}", pull.as_object().map(|map| map.keys().collect::<Vec<_>>()));
        }
    } else {
        println!("没有 live_core_sdk_data");
    }
}
