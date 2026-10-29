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
    QualityData, RoomExtra,
};
use crate::site::LiveSite;
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REFERER: &str = "https://live.douyin.com";

/// 清晰度的展示名与顺序。抖音用 `FULL_HD1` 这类键描述档位。
const QUALITY_ORDER: [(&str, &str, u32); 4] = [
    ("FULL_HD1", "原画", 4),
    ("HD1", "蓝光", 3),
    ("SD1", "超清", 2),
    ("SD2", "高清", 1),
];

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

    /// 推荐流的一页。
    ///
    /// 抖音这个接口**没有真正的分页游标**：`count` 写多少都只回 6 条，
    /// `offset` 也被忽略。能做的是带 `max_time`（上一批里最早的开播时间戳减一），
    /// 让服务端把「更早开播」的直播间排上来。返回的第二个值是下一次要用的游标。
    fn feed_page(
        http: &HttpSession,
        cursor: Option<u64>,
    ) -> Result<(Vec<LiveRoomItem>, Option<u64>), LiveError> {
        let cookie = Self::cookie(http)?;
        let headers = Self::request_headers(&cookie, REFERER);
        let borrowed: Vec<(&str, &str)> = headers
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let max_time = cursor.map(|value| value.to_string()).unwrap_or_default();
        let value = http.get_json(
            "https://live.douyin.com/webcast/feed/",
            &[
                ("aid", "6383"),
                ("app_name", "douyin_web"),
                ("live_id", "1"),
                ("device_platform", "web"),
                ("language", "zh-CN"),
                ("enter_from", "web_live"),
                ("count", "20"),
                ("offset", "0"),
                ("max_time", max_time.as_str()),
                ("channel", "web_live_default"),
                ("screen_mode", "0"),
                ("server_type", "toutiao_live"),
                ("version_code", "180800"),
            ],
            &borrowed,
        )?;
        let list = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| LiveError::protocol("抖音推荐流返回格式异常"))?;
        let mut items = Vec::new();
        let mut oldest: Option<u64> = None;
        for entry in list {
            let room = entry.get("data").unwrap_or(&Value::Null);
            if room.get("status").and_then(Value::as_i64) != Some(2) {
                continue;
            }
            let owner = room.get("owner").cloned().unwrap_or(Value::Null);
            // 推荐流不带 web_rid，只能用 room_id 进房（reflow 接口接受它）。
            let room_id = text_of(room, "id_str");
            if room_id.is_empty() {
                continue;
            }
            if let Some(created) = room.get("create_time").and_then(Value::as_u64)
                && created > 0
            {
                oldest = Some(oldest.map_or(created, |now: u64| now.min(created)));
            }
            items.push(LiveRoomItem {
                platform: Platform::Douyin,
                room_id,
                title: text_of(room, "title"),
                user_name: text_of(&owner, "nickname"),
                cover: url_of(room, "cover"),
                online: room.get("user_count").and_then(Value::as_u64).unwrap_or(0),
            });
        }
        Ok((items, oldest.map(|value| value.saturating_sub(1))))
    }
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

    fn search(&self, _http: &HttpSession, _keyword: &str) -> Result<Vec<LiveRoomItem>, LiveError> {
        Err(LiveError::unsupported(
            "抖音搜索需要平台签名，当前版本暂不支持，请直接粘贴直播间链接或房间号",
        ))
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

    fn recommend(&self, http: &HttpSession, page: u32) -> Result<Vec<LiveRoomItem>, LiveError> {
        // 游标是「上一批最老的开播时间」，放在进程内共享；首页刷新（page=1）时重置。
        static CURSOR: OnceLock<Mutex<Option<u64>>> = OnceLock::new();
        let cursor = CURSOR.get_or_init(|| Mutex::new(None));
        if page <= 1
            && let Ok(mut guard) = cursor.lock()
        {
            *guard = None;
        }
        // 一次只给 6 条，而首页一屏要十几张卡，所以在后端连拉几页、
        // 去重后一起返回。最多 4 次（≈1.5 秒），拿不到新内容就提前停。
        const TARGET: usize = 12;
        let mut items: Vec<LiveRoomItem> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for _ in 0..4 {
            let current = cursor.lock().ok().and_then(|guard| *guard);
            let (batch, next) = Self::feed_page(http, current)?;
            for room in batch {
                if seen.insert(room.room_id.clone()) {
                    items.push(room);
                }
            }
            if let Ok(mut guard) = cursor.lock() {
                *guard = next;
            }
            // 没有新游标说明这一批全是没有开播时间的房间，再拉也是同一批。
            if items.len() >= TARGET || next.is_none() || next == current {
                break;
            }
        }
        Ok(items)
    }

    fn categories(&self, _http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError> {
        Err(LiveError::unsupported(
            "抖音的分区接口需要签名，当前版本暂不支持分类浏览",
        ))
    }

    fn category_rooms(
        &self,
        _http: &HttpSession,
        _category: &LiveSubCategory,
        _page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        Err(LiveError::unsupported("抖音暂不支持按分区浏览"))
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
        if let Some(url) = stream_url
            .get("flv_pull_url")
            .and_then(|map| map.get(key))
            .and_then(Value::as_str)
        {
            flv.push(url.to_string());
        }
        if let Some(url) = stream_url
            .get("hls_pull_url_map")
            .and_then(|map| map.get(key))
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
