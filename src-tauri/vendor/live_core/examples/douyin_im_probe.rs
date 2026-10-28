//! 抖音弹幕端到端探针：走真实的 `DanmakuSession`，打印状态与收到的弹幕。
//!
//! 用法：
//!   cargo run --example douyin_im_probe -- [web_rid] --signature <sig> [--user <uid>]

use live_core::model::RoomExtra;
use live_core::{DanmakuSession, LiveCore, Platform};

fn main() {
    let mut args = std::env::args().skip(1);
    let mut web_rid: Option<String> = None;
    let mut signature = String::new();
    let mut user_id = String::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--signature" => signature = args.next().unwrap_or_default(),
            "--user" => user_id = args.next().unwrap_or_default(),
            other => web_rid = Some(other.to_string()),
        }
    }
    let core = LiveCore::new();
    let detail = match web_rid.as_deref() {
        Some(rid) => core.detail(Platform::Douyin, rid).expect("detail 失败"),
        None => {
            let rooms = core.recommend(Platform::Douyin, 1).expect("recommend 失败");
            let first = rooms.first().expect("推荐列表为空");
            println!("使用推荐房间 {} / {}", first.room_id, first.user_name);
            core.detail(Platform::Douyin, &first.room_id)
                .expect("detail 失败")
        }
    };
    println!(
        "web_rid={} live={} title={}",
        detail.room_id, detail.live, detail.title
    );

    let mut extra = detail.extra.clone();
    let room_id = match &extra {
        RoomExtra::Douyin { room_id, .. } => room_id.clone(),
        _ => panic!("不是抖音房间"),
    };
    let user_id = if user_id.is_empty() {
        "7000000000000000000".to_string()
    } else {
        user_id
    };
    // 和 WebView 侧 DouyinSign.getDefaultSignatureParams 完全一致（顺序也一致）。
    let stub_text = format!(
        "live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.3.0,room_id={room_id},\
         sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id={user_id},device_platform=web,\
         device_type=,ac=,identity=audience"
    );
    let stub = format!("{:x}", md5::compute(stub_text.as_bytes()));
    println!("room_id(内部)={room_id}");
    println!("msStub={stub}");
    if signature.is_empty() {
        println!("没有提供 --signature，先用它生成签名再重跑（node tools/probe/sign_from_stub.js {stub}）");
        return;
    }

    match &mut extra {
        RoomExtra::Douyin {
            signature: slot_sig,
            user_id: slot_uid,
            cookie,
            ..
        } => {
            println!("cookie 是否带 ttwid={}", cookie.contains("ttwid="));
            *slot_sig = signature.clone();
            *slot_uid = user_id.clone();
        }
        _ => panic!("不是抖音房间"),
    }

    let session = DanmakuSession::start(Platform::Douyin, &extra).expect("启动弹幕失败");
    let started = std::time::Instant::now();
    let mut chats = 0;
    while started.elapsed() < std::time::Duration::from_secs(20) {
        for status in session.drain_status() {
            println!("[status] {} {}", status.state, status.reason);
        }
        for message in session.drain() {
            if message.system {
                println!("[system] {}", message.text);
            } else {
                chats += 1;
                println!("[chat {chats}] {}：{}", message.user, message.text);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    println!("结束，共收到 {chats} 条聊天弹幕");
}
