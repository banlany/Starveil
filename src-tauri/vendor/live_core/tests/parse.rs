//! 离线解析测试：只吃 fixture，不联网，因此在任何网络环境下都能跑。
//!
//! fixture 是从真实响应裁剪出来的（保留结构、缩短数组），
//! 平台改版后先更新 fixture，再改解析代码。

use live_core::bilibili;
use live_core::douyu;
use live_core::huya;
use live_core::model::{Platform, RoomExtra};
use serde_json::Value;

fn json(raw: &str) -> Value {
    serde_json::from_str(raw).expect("fixture 必须是合法 JSON")
}

// ------------------------------------------------------------ 哔哩哔哩

#[test]
fn b站搜索逐条映射并剥掉高亮标签() {
    let value = json(include_str!("fixtures/bili_search.json"));
    let items = bilibili::parse_search(&value);

    assert_eq!(items.len(), 3);
    let first = &items[0];
    assert_eq!(first.platform, Platform::Bilibili);
    assert_eq!(first.room_id, "24530995");
    assert!(!first.title.is_empty());
    assert!(
        !first.title.contains('<'),
        "标题里的 <em> 标签必须被剥掉：{}",
        first.title
    );
    assert!(first.cover.starts_with("https:"), "封面要补全协议：{}", first.cover);
    assert!(first.online > 0);
}

#[test]
fn b站房间信息字段完整() {
    let value = json(include_str!("fixtures/bili_info_by_room.json"));
    let detail = bilibili::parse_detail(&value, "b3".into(), "b4".into(), "21452505")
        .expect("应当解析成功");

    assert_eq!(detail.platform, Platform::Bilibili);
    assert_eq!(detail.room_id, "21452505");
    assert_eq!(detail.user_name, "七海Nana7mi");
    assert!(!detail.title.is_empty());
    assert!(detail.live, "fixture 抓的是开播中的房间");
    assert!(!detail.intro.contains('<'), "简介里的 HTML 要被剥掉");
    assert_eq!(detail.url, "https://live.bilibili.com/21452505");
    assert_eq!(detail.viewers, 12745, "watched_show.num 是「看过」人数");
    assert_eq!(detail.guard_count, 36, "guard_info.count 是大航海人数");
    assert_eq!(detail.live_start_time, 1756156800, "live_start_time 是本场开播时间");
    match detail.extra {
        RoomExtra::Bilibili {
            buvid3, buvid4, ..
        } => {
            assert_eq!(buvid3, "b3");
            assert_eq!(buvid4, "b4");
        }
        other => panic!("取流上下文类型不对：{other:?}"),
    }
}

#[test]
fn b站风控码要归类为可重试错误() {
    let value = json(r#"{"code":-352,"message":"-352","ttl":1}"#);
    let error = bilibili::parse_detail(&value, String::new(), String::new(), "1")
        .expect_err("应当失败");
    assert!(
        matches!(error, live_core::LiveError::RiskControl(_)),
        "实际：{error:?}"
    );
    assert!(error.retryable());
}

#[test]
fn b站清晰度按码率降序且只保留可用档位() {
    let value = json(include_str!("fixtures/bili_play_info.json"));
    let playurl = value
        .pointer("/data/playurl_info/playurl")
        .expect("fixture 结构");

    let qualities = bilibili::parse_qualities(playurl).expect("应当解析出清晰度");
    // fixture 的 accept_qn 是 [10000, 250]
    assert_eq!(qualities.len(), 2);
    assert_eq!(qualities[0].name, "原画");
    assert_eq!(qualities[1].name, "超清");
}

#[test]
fn b站直链拼接完整且优先非mcdn() {
    let value = json(include_str!("fixtures/bili_play_info.json"));
    let playurl = value
        .pointer("/data/playurl_info/playurl")
        .expect("fixture 结构");

    let result = bilibili::parse_play_urls(playurl).expect("应当解析出直链");
    assert!(!result.urls.is_empty());
    for url in &result.urls {
        assert!(url.starts_with("https://"), "直链必须以 https 开头：{url}");
        assert!(url.contains(".m3u8") || url.contains(".flv"), "无法识别的流：{url}");
    }
    assert_eq!(
        result
            .headers
            .iter()
            .find(|(key, _)| key == "referer")
            .map(|(_, value)| value.as_str()),
        Some("https://live.bilibili.com/")
    );
}

// ------------------------------------------------------------ 虎牙

#[test]
fn 虎牙页面能提取全局初始化对象() {
    let html = include_str!("fixtures/huya_room.html");
    let root = huya::extract_global_init(html).expect("应当能从页面里取出 JSON");

    assert!(root.pointer("/roomInfo/tLiveInfo").is_some());
    assert_eq!(huya::presenter_uid(html), Some(294_636_272));
}

#[test]
fn 虎牙房间信息与取流上下文() {
    let html = include_str!("fixtures/huya_room.html");
    let root = huya::extract_global_init(html).expect("JSON");
    let detail = huya::parse_detail(&root, html, "998").expect("应当解析成功");

    assert_eq!(detail.platform, Platform::Huya);
    assert!(detail.live, "fixture 是开播中的房间");
    assert!(!detail.title.is_empty());
    assert_eq!(detail.user_name, "狂鸟丶楚河-90327");
    assert!(detail.url.starts_with("https://www.huya.com/"));

    let RoomExtra::Huya {
        lines,
        bitrates,
        presenter_uid,
        ..
    } = detail.extra
    else {
        panic!("取流上下文类型不对");
    };
    assert_eq!(lines.len(), 3, "fixture 有三条线路");
    assert_eq!(presenter_uid, 294_636_272);
    assert!(bitrates.iter().all(|item| !item.name.contains("HDR")));
    assert!(bitrates.iter().any(|item| item.name.contains("蓝光")));

    let qualities = huya::parse_qualities(&bitrates, !lines.is_empty()).expect("清晰度");
    assert!(qualities.len() >= 3);
}

#[test]
fn 虎牙未开播时清晰度给出可读错误() {
    let error = huya::parse_qualities(&[], false).expect_err("没有线路应当报错");
    assert!(matches!(error, live_core::LiveError::Unsupported(_)));
}

// ------------------------------------------------------------ 斗鱼

#[test]
fn 斗鱼房间信息与录播判定() {
    let value = json(include_str!("fixtures/douyu_betard.json"));
    let detail = douyu::parse_detail(&value, "9999").expect("应当解析成功");

    assert_eq!(detail.platform, Platform::Douyu);
    assert_eq!(detail.room_id, "9999");
    assert_eq!(detail.title, "陪伴每一天！");
    assert!(detail.live);
    assert_eq!(detail.online, 3_703_714);
    match detail.extra {
        RoomExtra::Douyu { rid } => assert_eq!(rid, "9999"),
        other => panic!("取流上下文类型不对：{other:?}"),
    }
}

#[test]
fn 斗鱼录播房间不算直播中() {
    let value = json(r#"{"room":{"room_id":"1","room_name":"回放","show_status":1,"videoLoop":1}}"#);
    let detail = douyu::parse_detail(&value, "1").expect("应当解析成功");
    assert!(!detail.live, "videoLoop=1 是录播循环，不应算直播中");
}

#[test]
fn 斗鱼搜索热度按万换算() {
    let value = json(include_str!("fixtures/douyu_search.json"));
    let items = douyu::parse_search(&value);

    assert_eq!(items.len(), 3);
    assert_eq!(items[0].room_id, "252140");
    assert_eq!(items[0].online, 3_799_000, "379.9万 应换算成 3799000");
    assert!(items.iter().all(|item| item.platform == Platform::Douyu));
}

#[test]
fn 斗鱼清晰度从multirates解析并给scdn降权() {
    let value = json(
        r#"{"error":0,"data":{
            "multirates":[{"name":"蓝光4M","rate":4},{"name":"超清","rate":0}],
            "cdnsWithName":[{"cdn":"scdn1","name":"边缘"},{"cdn":"ws2","name":"主线路"}]
        }}"#,
    );
    let qualities = douyu::parse_qualities(&value).expect("清晰度");
    assert_eq!(qualities.len(), 2);
    assert_eq!(qualities[0].name, "蓝光4M");

    let live_core::model::QualityData::Douyu { cdns, rate } = &qualities[0].data else {
        panic!("清晰度句柄类型不对");
    };
    assert_eq!(*rate, 4);
    assert_eq!(cdns, &vec!["ws2".to_string(), "scdn1".to_string()]);
}

#[test]
fn 斗鱼直链由rtmp两段拼成() {
    let value = json(
        r#"{"error":0,"data":{"rtmp_url":"https://hd.douyucdn.cn/live","rtmp_live":"abc.flv?wsAuth=x&amp;token=y"}}"#,
    );
    let url = douyu::parse_play_url(&value).expect("直链");
    assert_eq!(url, "https://hd.douyucdn.cn/live/abc.flv?wsAuth=x&token=y");
}
