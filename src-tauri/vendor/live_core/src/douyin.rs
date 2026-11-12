//! 抖音直播。
//!
//! 来源：`dart_simple_live/simple_live_core/lib/src/douyin_site.dart`（GPL-3.0，
//! 上游 xiaoyaocz/dart_simple_live）与 `danmaku/douyin_danmaku.dart`，本文件是
//! 按 Rust 重写而非逐行翻译；许可与素材声明见根目录 `THANKS.md`。
//!
//! 抖音的取流接口（`webcast/room/web/enter` 与 `webcast/room/reflow/info`）
//! 在只带匿名 `ttwid` 的情况下就能返回完整数据，不需要 `a_bogus` 签名；
//! 因此这里不移植那套 600 KB 的 webmssdk，只做「拿 Cookie → 请求 → 解析」。
//!
//! 弹幕（`webcast/im/push/v2`）另说：它的 WebSocket 必须带 webmssdk 生成的
//! `signature`，只能在 JS 引擎里算。本 crate 不内嵌 JS 引擎，签名由 WebView
//! 侧算好后随 `start_danmaku` 注入 `RoomExtra::Douyin.signature`，
//! 连接与解码见 `douyin_im`。

use crate::error::LiveError;
use crate::http::HttpSession;
use crate::model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
    QualityData, QuerySign, RoomExtra,
};
use crate::site::LiveSite;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REFERER: &str = "https://live.douyin.com";

/// 清晰度的展示名与顺序。抖音用 `FULL_HD1` 这类键描述档位。
///
/// 注意这套键**只在没有 SDK 档位表时兜底**：`FULL_HD1` 实际是 1080P，
/// `HD1` 是 720P，四档里根本没有「原画」（2K/4K 或 60 帧的源）。
/// 真正完整的阶梯在 `live_core_sdk_data` 里（见 `sdk_qualities`）。
const QUALITY_ORDER: [(&str, &str, u32); 4] = [
    ("FULL_HD1", "原画", 4),
    ("HD1", "蓝光", 3),
    ("SD1", "超清", 2),
    ("SD2", "高清", 1),
];

/// 旧档位键 → SDK 档位键。SDK 表取不到地址时按这个降级。
fn legacy_key(sdk_key: &str) -> Option<&'static str> {
    match sdk_key {
        "origin" | "uhd" => Some("FULL_HD1"),
        "hd" => Some("HD1"),
        "ld" => Some("SD1"),
        "sd" => Some("SD2"),
        _ => None,
    }
}

pub struct DouyinSite;

impl DouyinSite {
    pub fn new() -> Self {
        Self
    }

    /// 请求用的 Cookie：登录态优先，缺 `ttwid` 时补一个匿名的。
    ///
    /// 抖音的房间/取流接口只认 `ttwid`，登录 Cookie 里未必带它
    /// （用户可能是从别的入口登进来），所以两种情况都保证 ttwid 在里面。
    fn cookie(http: &HttpSession) -> Result<String, LiveError> {
        let Some(login) = http.cookie().map(str::trim).filter(|text| !text.is_empty()) else {
            return Self::anonymous_cookie(http);
        };
        if login.to_ascii_lowercase().contains("ttwid=") {
            return Ok(login.to_string());
        }
        match Self::anonymous_cookie(http) {
            Ok(anon) => Ok(format!("{login}; {anon}")),
            // 拿不到匿名 ttwid 时至少带上登录 Cookie，别让登录态白丢。
            Err(_) => Ok(login.to_string()),
        }
    }

    /// 匿名 `ttwid`。抖音要求浏览器先落一个 ttwid 才认后续请求，
    /// 这里拿一次缓存 10 分钟（进程内共享，避免每开一个房间都打页面）。
    fn anonymous_cookie(http: &HttpSession) -> Result<String, LiveError> {
        static CACHE: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        if let Ok(guard) = cache.lock()
            && let Some((value, at)) = guard.as_ref()
            && at.elapsed() < Duration::from_secs(600)
        {
            return Ok(value.clone());
        }
        let headers = http.head_headers(REFERER, &[("referer", REFERER), ("user-agent", UA)])?;
        let mut cookie = String::new();
        for value in headers.get_all("set-cookie") {
            let Ok(text) = value.to_str() else { continue };
            let pair = text.split(';').next().unwrap_or("").trim();
            if pair.starts_with("ttwid=") || pair.starts_with("__ac_nonce=") || pair.starts_with("msToken=")
            {
                cookie.push_str(pair);
                cookie.push(';');
            }
        }
        if cookie.trim().is_empty() {
            return Err(LiveError::protocol("抖音没有下发匿名 Cookie（ttwid），请稍后重试"));
        }
        if let Ok(mut guard) = cache.lock() {
            *guard = Some((cookie.clone(), Instant::now()));
        }
        Ok(cookie)
    }

    fn request_headers(cookie: &str, referer: &str) -> Vec<(&'static str, String)> {
        vec![
            ("user-agent", UA.to_string()),
            ("referer", referer.to_string()),
            ("cookie", cookie.to_string()),
            ("accept", "application/json, text/plain, */*".to_string()),
        ]
    }

    /// 拉一页分区房间（首页推荐与分类房间共用）。
    ///
    /// 没签名时直接给出能照做的提示：抖音在这种请求上会回 HTTP 200 + 空
    /// body，如果只说「解析失败」，用户完全不知道该去哪儿处理。
    fn partition_rooms(
        http: &HttpSession,
        partition: &str,
        partition_type: &str,
        page: u32,
        sign: &QuerySign,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        if sign.is_empty() {
            return Err(LiveError::unsupported(
                "抖音列表需要请求签名，但这一页没能算出 a_bogus。请退出再进一次页面；\
                 仍然不行的话重启应用（签名脚本可能没加载成功）",
            ));
        }
        let cookie = Self::cookie(http)?;
        let headers = vec![
            ("user-agent", UA),
            ("referer", REFERER),
            ("cookie", cookie.as_str()),
            ("accept", "application/json, text/plain, */*"),
        ];
        let offset = page.saturating_sub(1) * PAGE_SIZE;
        // 查询串必须和交给签名脚本的那一份逐字符一致，所以统一由 `partition_query` 拼。
        let query = partition_query(partition, partition_type, offset, &sign.ms_token);
        let url = format!(
            "{REFERER}/webcast/web/partition/detail/room/v2/?{query}&a_bogus={}",
            urlencode(sign.a_bogus.trim())
        );
        let value = http.get_json_raw(&url, &headers)?;
        parse_partition_rooms(&value)
    }

    /// 通过 web_rid（网页房间号）进房。
    fn enter(http: &HttpSession, web_rid: &str) -> Result<Value, LiveError> {
        let cookie = Self::cookie(http)?;
        let referer = format!("{REFERER}/{web_rid}");
        let headers = Self::request_headers(&cookie, &referer);
        let borrowed: Vec<(&str, &str)> = headers
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let value = http.get_json(
            "https://live.douyin.com/webcast/room/web/enter/",
            &[
                ("aid", "6383"),
                ("app_name", "douyin_web"),
                ("live_id", "1"),
                ("device_platform", "web"),
                ("language", "zh-CN"),
                ("browser_language", "zh-CN"),
                ("browser_platform", "Win32"),
                ("browser_name", "Chrome"),
                ("browser_version", "125.0.0.0"),
                ("web_rid", web_rid),
                ("msToken", ""),
            ],
            &borrowed,
        )?;
        let room = value
            .get("data")
            .and_then(|data| data.get("data"))
            .and_then(Value::as_array)
            .and_then(|rooms| rooms.first())
            .ok_or_else(|| {
                LiveError::protocol("抖音没有返回房间数据，可能是房间不存在、未开播或被风控限制")
            })?;
        Ok(room.clone())
    }

    /// 通过一次性 room_id（19 位）进房；reflow 接口对已下播的房间也能返回主播信息。
    fn reflow(http: &HttpSession, room_id: &str) -> Result<Value, LiveError> {
        let cookie = Self::cookie(http)?;
        let headers = Self::request_headers(&cookie, REFERER);
        let borrowed: Vec<(&str, &str)> = headers
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let value = http.get_json(
            "https://webcast.amemv.com/webcast/room/reflow/info/",
            &[
                ("type_id", "0"),
                ("live_id", "1"),
                ("room_id", room_id),
                ("sec_user_id", ""),
                ("version_code", "99.99.99"),
                ("app_id", "6383"),
            ],
            &borrowed,
        )?;
        value
            .get("data")
            .and_then(|data| data.get("room"))
            .filter(|room| room.is_object())
            .cloned()
            .ok_or_else(|| LiveError::protocol("抖音没有返回房间数据（reflow 响应为空）"))
    }

    /// 重新取一份 `stream_url`（带新签名）。有网页房间号就走 enter，
    /// 只有 19 位一次性 room_id 时才走 reflow；拿不到或没地址都返回 None，
    /// 调用方自己决定要不要退回缓存。
    fn fresh_stream(http: &HttpSession, room_id: &str, web_rid: &str) -> Option<Value> {
        let room = if web_rid.is_empty() {
            Self::reflow(http, room_id).ok()?
        } else {
            Self::enter(http, web_rid).ok()?
        };
        let stream = room.get("stream_url").filter(|value| value.is_object())?;
        let has_url = ["flv_pull_url", "hls_pull_url_map"].iter().any(|field| {
            stream
                .get(*field)
                .and_then(Value::as_object)
                .is_some_and(|map| !map.is_empty())
        });
        has_url.then(|| stream.clone())
    }

    /// 网页房间号一般是 11~12 位；19 位那种是一次性 room_id。
    fn looks_like_room_id(value: &str) -> bool {
        value.len() > 16 && value.chars().all(|ch| ch.is_ascii_digit())
    }

    /// 只在测试里用来校验 `QUALITY_ORDER` 的档位权重是递减的。
    #[cfg(test)]
    fn quality_key(name: &str) -> u32 {
        QUALITY_ORDER
            .iter()
            .find(|(key, _, _)| *key == name)
            .map(|(_, _, weight)| *weight)
            .unwrap_or(0)
    }

    fn quality_label(name: &str) -> String {
        QUALITY_ORDER
            .iter()
            .find(|(key, _, _)| *key == name)
            .map(|(_, label, _)| label.to_string())
            .unwrap_or_else(|| name.to_string())
    }
}

// ------------------------------------------------------- SDK 档位表（真正的清晰度阶梯）

/// `stream_url.live_core_sdk_data.pull_data`。
///
/// 抖音把完整的档位表放在这里：`options.qualities[]` 是「名字 + 分辨率 + 帧率 + 码率」，
/// `stream_data`（一个 JSON 字符串）才是每个档位对应的直链。
/// 旧的 `flv_pull_url` 只有四档、且最高只到 1080P，2K / 高帧率只在 SDK 表里。
fn sdk_pull_data(stream_url: &Value) -> Option<Value> {
    let sdk = stream_url.get("live_core_sdk_data")?;
    // 这个字段在不同接口里有时是对象，有时是被转义成字符串的 JSON。
    let sdk = match sdk {
        Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
        other => other.clone(),
    };
    sdk.get("pull_data").cloned()
}

/// `pull_data.stream_data` → `{sdk_key: (flv, hls)}`。
fn sdk_stream_map(pull: &Value) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    let Some(text) = pull.get("stream_data").and_then(Value::as_str) else {
        return map;
    };
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return map;
    };
    let Some(data) = value.get("data").and_then(Value::as_object) else {
        return map;
    };
    for (key, entry) in data {
        let main = entry.get("main").unwrap_or(entry);
        let flv = main
            .get("flv")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let hls = main
            .get("hls")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if flv.is_empty() && hls.is_empty() {
            continue;
        }
        map.insert(key.clone(), (flv, hls));
    }
    map
}

/// 档位显示名：`蓝光 1080P60`、`超清 720P60`、`高清 720P30`；原画没有分辨率信息就只叫「原画」。
fn sdk_label(item: &Value) -> String {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("原画");
    let resolution = item
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fps = item.get("fps").and_then(Value::as_i64).unwrap_or(0);
    // `resolution` 形如 `1920x1080`，只取高度；抖音 60 帧常报 59，按 60 显示。
    let height = resolution
        .split(['x', 'X'])
        .nth(1)
        .filter(|value| !value.is_empty());
    let fps = if fps >= 59 { 60 } else { fps };
    match (height, fps > 0) {
        (Some(height), true) => format!("{name} {height}P{fps}"),
        (Some(height), false) => format!("{name} {height}P"),
        _ => name.to_string(),
    }
}

/// 从 SDK 档位表生成清晰度列表（高 → 低），没有直链的档位不列。
fn sdk_qualities(stream_url: &Value) -> Vec<PlayQuality> {
    let Some(pull) = sdk_pull_data(stream_url) else {
        return Vec::new();
    };
    let Some(list) = pull
        .pointer("/options/qualities")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let streams = sdk_stream_map(&pull);
    let mut items: Vec<(i64, PlayQuality)> = list
        .iter()
        .filter_map(|item| {
            let key = item.get("sdk_key").and_then(Value::as_str)?.to_string();
            // 表里会出现没有地址的档位（房间没推这一路），列出来点了也播不了。
            if !streams.contains_key(&key) {
                return None;
            }
            let level = item.get("level").and_then(Value::as_i64).unwrap_or(0);
            Some((
                level,
                PlayQuality {
                    name: sdk_label(item),
                    data: QualityData::Douyin { key },
                },
            ))
        })
        .collect();
    items.sort_by(|left, right| right.0.cmp(&left.0));
    items.into_iter().map(|(_, quality)| quality).collect()
}

/// 按 sdk_key 从 `stream_data` 里取直链。
fn sdk_urls(stream_url: &Value, key: &str) -> Option<(String, String)> {
    let pull = sdk_pull_data(stream_url)?;
    sdk_stream_map(&pull).remove(key)
}

/// 每页条数。分区接口按 15 一页给，翻页靠 `offset`。
pub const PAGE_SIZE: u32 = 15;

/// 分区房间接口的查询串（首页推荐与「分类 → 房间」共用这一套）。
///
/// 抖音这套接口要验 `a_bogus`，而签名是对**查询串**算的：同一串既交给 WebView
/// 去签，也要原样发出去，所以拼串只在这里做一次。字段顺序不是随便排的——
/// 改动后必须重新跑一遍 `a_bogus` 联调，别只改 Rust 忘了 JS 那一侧。
pub fn partition_query(
    partition: &str,
    partition_type: &str,
    offset: u32,
    ms_token: &str,
) -> String {
    format!(
        "aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN\
         &enter_from=link_share&cookie_enabled=true&screen_width=1980&screen_height=1080\
         &browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome\
         &browser_version=125.0.0.0&browser_online=true&count={PAGE_SIZE}&offset={offset}\
         &partition={partition}&partition_type={partition_type}&req_from=2&msToken={ms_token}"
    )
}

/// 首页「推荐」用的分区：`720` 是抖音网页版的推荐流（`partition_type=1`）。
const RECOMMEND_PARTITION: (&str, &str) = ("720", "1");

/// 把 `data.data[]` 里的房间转成列表项。
///
/// 分区接口每项形如 `{ web_rid, room: { title, owner, cover, room_view_stats } }`；
/// `web_rid` 是主播的固定房间号（11~12 位），比一次性 room_id 更适合当外键。
fn parse_partition_rooms(value: &Value) -> Result<Vec<LiveRoomItem>, LiveError> {
    let rooms = value
        .get("data")
        .and_then(|data| data.get("data"))
        .and_then(Value::as_array)
        .ok_or_else(|| LiveError::protocol("抖音分区接口返回格式异常（可能触发了风控）"))?;
    let mut items = Vec::with_capacity(rooms.len());
    for entry in rooms {
        let room = entry.get("room").unwrap_or(&Value::Null);
        let owner = room.get("owner").cloned().unwrap_or(Value::Null);
        let web_rid = text_of(entry, "web_rid");
        let room_id = if web_rid.is_empty() {
            text_of(room, "id_str")
        } else {
            web_rid
        };
        if room_id.is_empty() {
            continue;
        }
        // 在线人数在 `room_view_stats.display_value`；偶尔是字符串，两种都认。
        let online = room
            .get("room_view_stats")
            .and_then(|stats| stats.get("display_value"))
            .map(|value| match value {
                Value::Number(number) => number.as_u64().unwrap_or(0),
                Value::String(text) => text.parse().unwrap_or(0),
                _ => 0,
            })
            .unwrap_or(0);
        items.push(LiveRoomItem {
            platform: Platform::Douyin,
            room_id,
            title: text_of(room, "title"),
            user_name: text_of(&owner, "nickname"),
            avatar: url_of(&owner, "avatar_thumb"),
            cover: url_of(room, "cover"),
            online,
        });
    }
    Ok(items)
}

impl Default for DouyinSite {
    fn default() -> Self {
        Self::new()
    }
}

fn text_of(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// 等价于 JS 的 `encodeURIComponent`。
///
/// 查询串里的值（关键词、a_bogus）在签名/发送时必须和浏览器同一套转义规则：
/// a_bogus 里会出现 `=`、`+`、`/`，原样塞进 URL 会被服务端解析成另一个值。
fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 搜索结果的每项是 `{ lives: { rawdata: "<房间 JSON 字符串>" } }`，
/// rawdata 偶尔直接是对象，两种都认。
fn parse_search_rooms(value: &Value) -> Result<Vec<LiveRoomItem>, LiveError> {
    if value.get("status_code").and_then(Value::as_i64).unwrap_or(0) != 0 {
        let code = value.get("status_code").and_then(Value::as_i64).unwrap_or(0);
        return Err(LiveError::protocol(format!("抖音搜索返回异常 status_code={code}")));
    }
    let data = value.get("data").and_then(Value::as_array);
    let mut items = Vec::new();
    for entry in data.into_iter().flatten() {
        let raw = entry.get("lives").and_then(|live| live.get("rawdata"));
        let room = match raw {
            Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok(),
            Some(node) if node.is_object() => Some(node.clone()),
            _ => None,
        };
        let Some(room) = room else { continue };
        let owner = room.get("owner").cloned().unwrap_or(Value::Null);
        let room_id = text_of(&owner, "web_rid");
        if room_id.is_empty() {
            continue;
        }
        let online = room
            .get("stats")
            .and_then(|stats| stats.get("total_user"))
            .or_else(|| {
                room.get("room_view_stats")
                    .and_then(|stats| stats.get("display_value"))
            })
            .map(|value| match value {
                Value::Number(number) => number.as_u64().unwrap_or(0),
                Value::String(text) => text.parse().unwrap_or(0),
                _ => 0,
            })
            .unwrap_or(0);
        items.push(LiveRoomItem {
            platform: Platform::Douyin,
            room_id,
            title: text_of(&room, "title"),
            user_name: text_of(&owner, "nickname"),
            avatar: url_of(&owner, "avatar_thumb"),
            cover: url_of(&room, "cover"),
            online,
        });
    }
    Ok(items)
}

/// 覆盖图/头像这类字段是 `{ url_list: [...] }`。
fn url_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|node| node.get("url_list"))
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

impl LiveSite for DouyinSite {
    fn platform(&self) -> Platform {
        Platform::Douyin
    }

    fn search(
        &self,
        http: &HttpSession,
        keyword: &str,
        _sign: &QuerySign,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        // 搜索走的是 `www.douyin.com` 的 web 接口，实测不验 `a_bogus`
        // （dart 版那行 `getAbogusUrl` 也是注释掉的），但**要求登录态**：
        // 匿名请求一律回 `status_code: 2483`。
        let cookie = Self::cookie(http)?;
        let keyword = keyword.trim();
        let referer = format!("https://www.douyin.com/search/{}?type=live", urlencode(keyword));
        let offset = 0u32.to_string();
        let count = 10u32.to_string();
        let value = http.get_json(
            "https://www.douyin.com/aweme/v1/web/live/search/",
            &[
                ("device_platform", "webapp"),
                ("aid", "6383"),
                ("channel", "channel_pc_web"),
                ("search_channel", "aweme_live"),
                ("keyword", keyword),
                ("search_source", "switch_tab"),
                ("query_correct_type", "1"),
                ("is_filter_search", "0"),
                ("from_group_id", ""),
                ("offset", offset.as_str()),
                ("count", count.as_str()),
                ("pc_client_type", "1"),
                ("version_code", "170400"),
                ("version_name", "17.4.0"),
                ("cookie_enabled", "true"),
                ("screen_width", "1980"),
                ("screen_height", "1080"),
                ("browser_language", "zh-CN"),
                ("browser_platform", "Win32"),
                ("browser_name", "Chrome"),
                ("browser_version", "125.0.0.0"),
                ("browser_online", "true"),
                ("engine_name", "Blink"),
                ("engine_version", "125.0.0.0"),
                ("os_name", "Windows"),
                ("os_version", "10"),
                ("cpu_core_num", "12"),
                ("device_memory", "8"),
                ("platform", "PC"),
                ("downlink", "10"),
                ("effective_type", "4g"),
                ("round_trip_time", "100"),
                ("webid", "7382872326016435738"),
            ],
            &[
                ("user-agent", UA),
                ("accept", "application/json, text/plain, */*"),
                ("accept-language", "zh-CN,zh;q=0.9,en;q=0.8"),
                ("cookie", cookie.as_str()),
                ("referer", referer.as_str()),
                ("sec-fetch-dest", "empty"),
                ("sec-fetch-mode", "cors"),
                ("sec-fetch-site", "same-origin"),
            ],
        )?;
        // 2483 = 需要登录。匿名搜索就是这个码，直说原因，别让用户以为是网络问题。
        if value.get("status_code").and_then(Value::as_i64) == Some(2483) {
            return Err(LiveError::protocol(
                "抖音搜索需要登录：请在「设置 → 账号登录」里登录抖音后再搜",
            ));
        }
        parse_search_rooms(&value)
    }

    fn detail(&self, http: &HttpSession, room_id: &str) -> Result<LiveRoomDetail, LiveError> {
        let room_id = room_id.trim();
        let (room, fallback_web_rid) = if Self::looks_like_room_id(room_id) {
            (Self::reflow(http, room_id)?, String::new())
        } else {
            (Self::enter(http, room_id)?, room_id.to_string())
        };

        let owner = room.get("owner").cloned().unwrap_or(Value::Null);
        let web_rid = {
            let value = text_of(&owner, "web_rid");
            if value.is_empty() {
                fallback_web_rid
            } else {
                value
            }
        };
        let inner_id = text_of(&room, "id_str");
        let status = room.get("status").and_then(Value::as_i64).unwrap_or(0);
        let live = status == 2;
        let title = text_of(&room, "title");
        let user_name = text_of(&owner, "nickname");
        if user_name.is_empty() && title.is_empty() {
            return Err(LiveError::protocol("抖音返回的房间数据不完整（没有主播或标题）"));
        }

        let online = room
            .get("user_count")
            .and_then(Value::as_u64)
            .or_else(|| {
                room.get("room_view_stats")
                    .and_then(|stats| stats.get("display_value"))
                    .and_then(Value::as_u64)
            })
            .unwrap_or(0);

        Ok(LiveRoomDetail {
            platform: Platform::Douyin,
            // 对外统一用 web_rid：它是主播的固定房间号，room_id 每次开播都会变。
            room_id: if web_rid.is_empty() {
                room_id.to_string()
            } else {
                web_rid.clone()
            },
            title,
            user_name,
            avatar: url_of(&owner, "avatar_thumb"),
            cover: if live { url_of(&room, "cover") } else { String::new() },
            online: if live { online } else { 0 },
            viewers: 0,
            guard_count: 0,
            live_start_time: room
                .get("create_time")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            live,
            area: None,
            intro: text_of(&owner, "signature"),
            url: if web_rid.is_empty() {
                String::new()
            } else {
                format!("{REFERER}/{web_rid}")
            },
            extra: RoomExtra::Douyin {
                room_id: inner_id,
                web_rid,
                // `stream_url` 里是带签名的 FLV/HLS 地址，原样留给 qualities/play 用。
                stream_url: room.get("stream_url").cloned().unwrap_or(Value::Null),
                // 弹幕 WebSocket 要带同一份 Cookie（ttwid 是硬要求），
                // 这里顺手存下来，省得弹幕线程再去请求一次首页。
                cookie: Self::cookie(http).unwrap_or_default(),
                // 签名与 user_unique_id 由 WebView 算好后经 `start_danmaku` 注入。
                signature: String::new(),
                user_id: String::new(),
            },
        })
    }

    fn qualities(
        &self,
        _http: &HttpSession,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError> {
        let RoomExtra::Douyin { stream_url, .. } = &detail.extra else {
            return Err(LiveError::protocol("抖音房间缺少取流上下文"));
        };
        // 先看 SDK 档位表：它是抖音真正的阶梯（含 1080P60 与「原画」）。
        let sdk = sdk_qualities(stream_url);
        if !sdk.is_empty() {
            return Ok(sdk);
        }
        let flv = stream_url.get("flv_pull_url").and_then(Value::as_object);
        let hls = stream_url.get("hls_pull_url_map").and_then(Value::as_object);
        let mut names: Vec<String> = Vec::new();
        // 档位顺序直接取 `QUALITY_ORDER`，避免这里和常量各写一份、改一处漏一处。
        for (key, _, _) in QUALITY_ORDER {
            let has = flv.is_some_and(|map| map.contains_key(key))
                || hls.is_some_and(|map| map.contains_key(key));
            if has {
                names.push(key.to_string());
            }
        }
        if names.is_empty() {
            return Err(LiveError::protocol(if detail.live {
                "抖音没有返回播放地址（可能刚开播，稍后重试）"
            } else {
                "主播不在播，没有可用的清晰度"
            }));
        }
        Ok(names
            .into_iter()
            .map(|key| PlayQuality {
                name: Self::quality_label(&key),
                data: QualityData::Douyin { key },
            })
            .collect())
    }

    fn recommend(
        &self,
        http: &HttpSession,
        page: u32,
        sign: &QuerySign,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        let (partition, partition_type) = RECOMMEND_PARTITION;
        Self::partition_rooms(http, partition, partition_type, page, sign)
    }

    /// 分区树。
    ///
    /// 抖音没有免签名的分区接口（`/webcast/web/partition/detail/*` 一律被风控挡回来），
    /// 但首页 HTML 里内嵌了整棵树：`"categoryData":[{"partition":{...},"sub_partition":[...]}]`。
    /// 直接把它抠出来解析，省得为这一个功能去移植 `a_bogus` 签名。
    fn categories(&self, http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError> {
        let cookie = Self::cookie(http)?;
        let headers = Self::request_headers(&cookie, REFERER);
        let borrowed: Vec<(&str, &str)> = headers
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let html = http.get_text(REFERER, &[], &borrowed)?;
        parse_home_categories(&html)
            .ok_or_else(|| LiveError::parse("抖音首页里没有找到分类数据（页面结构可能变了）"))
    }

    fn category_rooms(
        &self,
        http: &HttpSession,
        category: &LiveSubCategory,
        page: u32,
        sign: &QuerySign,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        // 分类 id 存的是 `"{id_str},{type}"`（见 `parse_home_categories`）：
        // 抖音的分区接口要 `partition` 和 `partition_type` 两个参数，缺一不可。
        let (partition, partition_type) = category
            .id
            .split_once(',')
            .map(|(id, kind)| (id.trim(), kind.trim()))
            .unwrap_or((category.id.trim(), "1"));
        Self::partition_rooms(http, partition, partition_type, page, sign)
    }

    fn play(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError> {
        let RoomExtra::Douyin {
            room_id,
            web_rid,
            stream_url,
            ..
        } = &detail.extra
        else {
            return Err(LiveError::protocol("抖音房间缺少取流上下文"));
        };
        let QualityData::Douyin { key } = &quality.data else {
            return Err(LiveError::parse("清晰度与平台不匹配"));
        };
        // 进房时拿到的直链签名只够用一小会儿，抖音 CDN 对过期/并发重复使用的
        // 签名直接回 403（播放器报 HttpStatusCodeInvalid）。所以每次取流都重新
        // 请求一次进房接口换成新签名；失败就退回进房时缓存的那份。
        let fresh = Self::fresh_stream(http, room_id, web_rid)
            .filter(|value| value.is_object())
            .unwrap_or_else(|| stream_url.clone());
        let stream_url = &fresh;
        let mut flv = Vec::new();
        let mut hls = Vec::new();
        // 1) SDK 档位表优先：`origin`（原画）只有这里有，旧结构最高只到 1080P。
        if let Some((sdk_flv, sdk_hls)) = sdk_urls(stream_url, key) {
            if !sdk_flv.is_empty() {
                flv.push(sdk_flv);
            }
            if !sdk_hls.is_empty() {
                hls.push(sdk_hls);
            }
        }
        // 2) 旧结构：key 是 `FULL_HD1` 那种旧档位，或 SDK 表里这一档没给地址时兜底。
        let legacy = legacy_key(key).unwrap_or(key);
        if flv.is_empty()
            && let Some(url) = stream_url
                .get("flv_pull_url")
                .and_then(|map| map.get(legacy))
                .and_then(Value::as_str)
        {
            flv.push(url.to_string());
        }
        if hls.is_empty()
            && let Some(url) = stream_url
                .get("hls_pull_url_map")
                .and_then(|map| map.get(legacy))
                .and_then(Value::as_str)
        {
            hls.push(url.to_string());
        }
        // 兜底：某一个档位缺 key 时退回完整列表，至少让用户能播。
        if flv.is_empty()
            && let Some(map) = stream_url.get("flv_pull_url").and_then(Value::as_object)
        {
            for value in map.values() {
                if let Some(url) = value.as_str() {
                    flv.push(url.to_string());
                }
            }
        }
        if flv.is_empty() && hls.is_empty() {
            return Err(LiveError::protocol("抖音没有返回这个清晰度的播放地址"));
        }
        // 抖音的 m3u8 与分片都不校验 Referer（实测裸请求 200），所以 HLS 可以
        // 放心作为额外的兜底线路列在 FLV 后面：FLV 那条约到 403 时用户还有得换。
        Ok(PlayUrls::new(flv)
            .with_hls(hls)
            .header("referer", REFERER)
            .header("user-agent", UA))
    }
}

/// 分区节点的 `"{id_str},{type}"` 键。缺字段时退回 `"{id_str},1"`。
fn partition_key(node: &Value) -> String {
    let id = text_of(node, "id_str");
    if id.is_empty() {
        return String::new();
    }
    let kind = node
        .get("type")
        .and_then(Value::as_i64)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "1".to_string());
    format!("{id},{kind}")
}

/// 从抖音首页 HTML 里抠出内嵌的分区树。
///
/// 首页的分类数据长这样（是 JS 字符串里的 JSON，引号被转义成 `\"`）：
/// `"categoryData":[{"partition":{"id_str":"101","type":4,"title":"聊天"},"sub_partition":[...]}]`
///
/// 这里先按括号匹配取出数组原文（跳过字符串内部，标题里的 `[` 才不会数错），
/// 再把 `\"` 还原成 `"`，最后当普通 JSON 解析。
fn parse_home_categories(html: &str) -> Option<Vec<LiveCategory>> {
    let key = html.find("categoryData")?;
    let rest = &html[key..];
    let start = rest.find('[')?;
    // 分类树最多几十 KB，截一段足够。必须先还原 JS 字符串那一层转义（`\"` → `"`），
    // 再按普通 JSON 规则做括号匹配——否则每个引号前面都带反斜杠，
    // 字符串永远不会闭合，整段匹配不出来。
    let window: String = rest[start..].chars().take(200_000).collect();
    let json = window.replace("\\\"", "\"");

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut end = None;
    for (index, ch) in json.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(index + 1);
                    break;
                }
            }
            _ => {}
        }
    }

    let value: Value = serde_json::from_str(&json[..end?]).ok()?;

    let mut categories = Vec::new();
    for item in value.as_array()? {
        let Some(node) = item.get("partition") else { continue };
        let id = text_of(node, "id_str");
        let name = text_of(node, "title");
        if id.is_empty() || name.is_empty() {
            continue;
        }
        // 分区 id 记成 `"{id_str},{type}"`：拉房间列表时抖音要同时传
        // `partition` 和 `partition_type`，只存 id_str 会让一级/二级分区
        // 用错类型（1 = 二级、4 = 一级），列表要么空要么是别的分区。
        let parent_key = partition_key(node);
        let mut children = Vec::new();
        collect_subs(item, &parent_key, &mut children);
        // 抖音首页 SSR 只给「游戏」带了二级分区，聊天 / 音乐 / 二次元 这些的
        // `sub_partition` 全是空数组（二级分区是前端再请求接口拿的）。
        // 照搬的话这些节只剩一个标题、底下没有任何可点的入口。所以把分区自己
        // 插到子分类最前面：点它就是这个分区的全部房间——`partition_type=4`
        // 直接请求有效，分页也正常（实测 offset 0/15/30 各回 15 条不重复）。
        // dart 版也是这么做的（`subs.insert(0, ...)`），顺带解释了「第一个入口」。
        children.insert(
            0,
            LiveSubCategory {
                id: parent_key.clone(),
                name: name.clone(),
                parent_id: parent_key.clone(),
                // 抖音的分区没有图标，前端会自动退回首字占位。
                pic: String::new(),
            },
        );
        categories.push(LiveCategory {
            id: parent_key,
            name,
            children,
        });
    }
    if categories.is_empty() {
        None
    } else {
        Some(categories)
    }
}

/// 把 `sub_partition` 递归摊平成一个列表（抖音目前最多两层，但字段是嵌套的，
/// 层级再深也不会丢入口）。摊平后的顺序就是接口给的顺序，不重排。
fn collect_subs(item: &Value, parent_key: &str, out: &mut Vec<LiveSubCategory>) {
    let Some(subs) = item.get("sub_partition").and_then(Value::as_array) else {
        return;
    };
    for sub in subs {
        let Some(node) = sub.get("partition") else { continue };
        let child_name = text_of(node, "title");
        let child_key = partition_key(node);
        if child_key.is_empty() || child_name.is_empty() {
            continue;
        }
        out.push(LiveSubCategory {
            id: child_key.clone(),
            name: child_name,
            parent_id: parent_key.to_string(),
            pic: String::new(),
        });
        collect_subs(sub, &child_key, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 分区查询串字段顺序固定() {
        // a_bogus 是对这个串做的哈希：字段顺序、空格、缺字段都会让签名失效。
        // 这里把首尾和中间的关键字段钉住，改参数时至少要意识到会影响签名。
        let query = partition_query("720", "1", 15, "TOKEN");
        assert!(query.starts_with("aid=6383&app_name=douyin_web&live_id=1"));
        assert!(query.ends_with("&partition=720&partition_type=1&req_from=2&msToken=TOKEN"));
        assert!(query.contains("&count=15&offset=15&partition="));
        assert!(!query.contains(' '), "续行不能留下空格：{query}");
        assert!(!query.contains('\n'));
    }

    #[test]
    fn 分区键带上类型() {
        let value = serde_json::json!({"id_str":"1011032","type":1});
        assert_eq!(partition_key(&value), "1011032,1");
        // 缺 type 时按二级分区兜底，至少还能请求。
        let value = serde_json::json!({"id_str":"720"});
        assert_eq!(partition_key(&value), "720,1");
        assert_eq!(partition_key(&serde_json::json!({})), "");
    }

    #[test]
    fn 解析搜索结果的原始串() {
        let value = serde_json::json!({
            "status_code": 0,
            "data": [{
                "lives": {
                    "rawdata": "{\"title\":\"标题\",\"owner\":{\"web_rid\":\"123456\",\"nickname\":\"主播\"},\"cover\":{\"url_list\":[\"https://a/1.jpg\"]},\"stats\":{\"total_user\":88}}"
                }
            }]
        });
        let items = parse_search_rooms(&value).expect("应当解析出房间");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].room_id, "123456");
        assert_eq!(items[0].user_name, "主播");
        assert_eq!(items[0].online, 88);
    }

    #[test]
    fn 搜索结果需要登录时给出明确错误() {
        let value = serde_json::json!({"status_code": 2483});
        let error = parse_search_rooms(&value).unwrap_err();
        assert!(error.to_string().contains("2483"));
    }

    #[test]
    fn 识别一次性房间号() {
        assert!(DouyinSite::looks_like_room_id("7701555509979188010"));
        assert!(!DouyinSite::looks_like_room_id("524557724459"));
    }

    #[test]
    fn 清晰度顺序正确() {
        assert!(DouyinSite::quality_key("FULL_HD1") > DouyinSite::quality_key("HD1"));
        assert!(DouyinSite::quality_key("HD1") > DouyinSite::quality_key("SD1"));
        assert_eq!(DouyinSite::quality_label("FULL_HD1"), "原画");
        assert_eq!(DouyinSite::quality_label("未知档位"), "未知档位");
    }

    #[test]
    fn sdk档位表按等级降序并只保留有地址的档() {
        // 结构照着真实响应裁剪：options.qualities 是档位阶梯，stream_data 是它的直链。
        let stream_url = serde_json::json!({
            "flv_pull_url": {"FULL_HD1": "http://x/_uhd.flv", "HD1": "http://x/_hd.flv"},
            "live_core_sdk_data": {
                "pull_data": {
                    "options": {
                        "qualities": [
                            {"sdk_key": "ld", "name": "标清", "resolution": "960x540", "fps": 25, "level": 1},
                            {"sdk_key": "sd", "name": "高清", "resolution": "1280x720", "fps": 30, "level": 2},
                            {"sdk_key": "hd", "name": "超清", "resolution": "1280x720", "fps": 59, "level": 3},
                            {"sdk_key": "uhd", "name": "蓝光", "resolution": "1920x1080", "fps": 59, "level": 4},
                            {"sdk_key": "origin", "name": "原画", "resolution": "", "fps": 59, "level": 5},
                            {"sdk_key": "ao", "name": "仅音频", "resolution": "", "fps": 0, "level": 0}
                        ]
                    },
                    "stream_data": "{\"data\":{\"origin\":{\"main\":{\"flv\":\"http://x/_or4.flv\",\"hls\":\"http://x/_or4.m3u8\"}},\"uhd\":{\"main\":{\"flv\":\"http://x/_uhd.flv\"}},\"hd\":{\"main\":{\"flv\":\"http://x/_hd.flv\"}},\"sd\":{\"main\":{\"flv\":\"http://x/_sd.flv\"}},\"ld\":{\"main\":{\"flv\":\"http://x/_ld.flv\"}}}}"
                }
            }
        });

        let qualities = sdk_qualities(&stream_url);
        let names: Vec<&str> = qualities.iter().map(|item| item.name.as_str()).collect();
        // 高帧率按 60 显示；原画没有分辨率就不硬加；没有直链的「仅音频」不列。
        assert_eq!(
            names,
            vec!["原画", "蓝光 1080P60", "超清 720P60", "高清 720P30", "标清 540P25"]
        );
        let keys: Vec<&str> = qualities
            .iter()
            .map(|item| match &item.data {
                QualityData::Douyin { key } => key.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(keys, vec!["origin", "uhd", "hd", "sd", "ld"]);
        // 原画必须落在 `_or4` 上——旧结构里根本没有这一路。
        assert_eq!(
            sdk_urls(&stream_url, "origin").map(|(flv, hls)| (flv, hls)),
            Some(("http://x/_or4.flv".to_string(), "http://x/_or4.m3u8".to_string()))
        );
        assert_eq!(sdk_urls(&stream_url, "ao"), None);
    }

    #[test]
    fn 没有sdk档位表时退回旧四档() {
        let stream_url = serde_json::json!({
            "flv_pull_url": {"FULL_HD1": "http://x/_uhd.flv", "HD1": "http://x/_hd.flv"},
            "hls_pull_url_map": {}
        });
        assert!(sdk_qualities(&stream_url).is_empty());
        // 旧档位键仍然要能映射到 SDK 键，否则 play() 的兜底分支取不到地址。
        assert_eq!(legacy_key("origin"), Some("FULL_HD1"));
        assert_eq!(legacy_key("hd"), Some("HD1"));
        assert_eq!(legacy_key("FULL_HD1"), None);
    }

    #[test]
    fn 封面与头像取第一张() {
        let value = serde_json::json!({"cover": {"url_list": ["https://a/1.webp", "https://a/2.webp"]}});
        assert_eq!(url_of(&value, "cover"), "https://a/1.webp");
        assert_eq!(url_of(&value, "missing"), "");
    }

    #[test]
    fn 数字字段也能取文本() {
        let value = serde_json::json!({"id": 123});
        assert_eq!(text_of(&value, "id"), "123");
    }

    #[test]
    fn 解析首页内嵌的分类树() {
        // 首页里的分类数据是 JS 字符串里的 JSON（引号被转义成 \"），
        // 这里放一段和真实页面同构的片段。
        let html = r#"<script>self.__pace_f.push([1,"{\"categoryData\":[{\"partition\":{\"id_str\":\"101\",\"type\":4,\"title\":\"聊天\"},\"sub_partition\":[]},{\"partition\":{\"id_str\":\"103\",\"type\":4,\"title\":\"游戏\"},\"sub_partition\":[{\"partition\":{\"id_str\":\"1011032\",\"type\":1,\"title\":\"三角洲行动\"}}]}]}"])</script>"#;
        let tree = parse_home_categories(html).expect("应当解析出分类");
        assert_eq!(tree.len(), 2);
        // 聊天在真实首页里 `sub_partition` 是空数组：必须靠「分区自己」兜底，
        // 否则整节只有标题、没有任何可点的入口。
        assert_eq!(tree[0].name, "聊天");
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].id, "101,4");
        assert_eq!(tree[0].children[0].name, "聊天");
        assert_eq!(tree[1].name, "游戏");
        assert_eq!(tree[1].id, "103,4");
        assert_eq!(tree[1].children.len(), 2);
        // 分区自己排第一，点它就是这个分区的全部房间（对齐 dart 版的 insert(0)）。
        assert_eq!(tree[1].children[0].id, "103,4");
        assert_eq!(tree[1].children[0].name, "游戏");
        // 分区键带上 type：拉房间列表时要同时传 partition 和 partition_type。
        assert_eq!(tree[1].children[1].id, "1011032,1");
        assert_eq!(tree[1].children[1].parent_id, "103,4");
        assert_eq!(tree[1].children[1].name, "三角洲行动");
    }
}
