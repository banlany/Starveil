//! 快手直播。
//!
//! 来源：`dart_simple_live/simple_live_core/lib/src/kuaishou_site.dart`（GPL-3.0，
//! 上游 xiaoyaocz/dart_simple_live），快手协议的完整支持还参考了
//! `xuanxuan123xuan/simple-live-kuaishou`；许可与素材声明见根目录 `THANKS.md`。
//!
//! 快手网页版的接口相对宽松：首页推荐、分类、分区、搜索都是普通 JSON 接口，
//! 不需要签名；房间详情页则把整份数据塞在 `window.__INITIAL_STATE__` 里，
//! 连播放地址（`liveStream.playUrls`）都一起给了，所以取流也不必再请求一次。

use crate::error::LiveError;
use crate::http::HttpSession;
use crate::model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
    QualityData, RoomExtra,
};
use crate::site::LiveSite;
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REFERER: &str = "https://live.kuaishou.com";
const API: &str = "https://live.kuaishou.com/live_api";

/// 一级分类是写死的：快手的 `category/data` 只按 type 返回二级分类。
const ROOT_CATEGORIES: [(&str, &str); 8] = [
    ("1", "热门"),
    ("2", "网游"),
    ("3", "单机"),
    ("4", "手游"),
    ("5", "棋牌"),
    ("6", "娱乐"),
    ("7", "综合"),
    ("8", "文化"),
];

pub struct KuaishouSite;

impl KuaishouSite {
    pub fn new() -> Self {
        Self
    }

    fn headers(referer: &str) -> Vec<(&'static str, String)> {
        vec![
            ("user-agent", UA.to_string()),
            ("referer", referer.to_string()),
            ("accept", "application/json, text/plain, */*".to_string()),
        ]
    }

    fn json(
        http: &HttpSession,
        url: &str,
        query: &[(&str, &str)],
        referer: &str,
    ) -> Result<Value, LiveError> {
        let owned = Self::headers(referer);
        let borrowed: Vec<(&str, &str)> = owned
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        http.get_json(url, query, &borrowed)
    }
}

impl Default for KuaishouSite {
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

fn number_of(value: &Value, key: &str) -> u64 {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn is_live_flag(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64() == Some(1),
        Some(Value::String(text)) => text == "1" || text.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// 快手封面经常省略扩展名，缺了要补 `.jpg` 才显示得出来。
fn normalize_image(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() || url.contains(".jpg") || url.contains(".png") || url.contains(".webp") {
        return url.to_string();
    }
    if url.rsplit('/').next().is_some_and(|name| name.contains('.')) {
        return url.to_string();
    }
    format!("{url}.jpg")
}

/// 从 HTML 里切出 `window.__INITIAL_STATE__=` 后面那一个 JSON 对象。
///
/// 不能用正则截到分号：快手的对象里含大量字符串与嵌套，必须按括号配对，
/// 同时跳过字符串内部的括号（否则 `"title":"a{b}"` 会把深度算错）。
fn extract_state(html: &str) -> Option<Value> {
    const MARK: &str = "window.__INITIAL_STATE__=";
    let start = html.find(MARK)? + MARK.len();
    let body = &html[start..];
    let begin = body.find('{')?;
    let chars: Vec<char> = body[begin..].chars().collect();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in chars.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *ch == '\\' {
                escaped = true;
            } else if *ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    let raw: String = chars[..=index].iter().collect();
                    // 快手的 SSR 数据里会内联 `undefined`，不是合法 JSON。
                    let fixed = raw.replace("undefined", "null");
                    return serde_json::from_str(&fixed).ok();
                }
            }
            _ => {}
        }
    }
    None
}

/// 把 `playUrls` 里所有码率抽出来。结构可能是数组，也可能是按编码分组的对象，
/// 所以不写死路径，递归找 `representation` 列表。
fn collect_representations(node: &Value, out: &mut Vec<(String, i64, String)>) {
    match node {
        Value::Object(map) => {
            if let Some(list) = map.get("representation").and_then(Value::as_array) {
                for item in list {
                    let url = text_of(item, "url");
                    if url.is_empty() {
                        continue;
                    }
                    let name = {
                        let name = text_of(item, "name");
                        if name.is_empty() {
                            text_of(item, "qualityType")
                        } else {
                            name
                        }
                    };
                    let level = item.get("level").and_then(Value::as_i64).unwrap_or(0);
                    out.push((name, level, url));
                }
            }
            for value in map.values() {
                collect_representations(value, out);
            }
        }
        Value::Array(list) => {
            for value in list {
                collect_representations(value, out);
            }
        }
        _ => {}
    }
}

/// 按清晰度名归并：同一档位可能有多条线路（不同 CDN），都保留。
fn group_qualities(play_urls: &Value) -> Vec<(String, i64, Vec<String>)> {
    let mut flat = Vec::new();
    collect_representations(play_urls, &mut flat);
    let mut groups: Vec<(String, i64, Vec<String>)> = Vec::new();
    for (name, level, url) in flat {
        match groups.iter_mut().find(|(existing, _, _)| *existing == name) {
            Some((_, _, urls)) => {
                if !urls.contains(&url) {
                    urls.push(url);
                }
            }
            None => {
                let label = if name.is_empty() {
                    format!("线路 {}", groups.len() + 1)
                } else {
                    name
                };
                groups.push((label, level, vec![url]));
            }
        }
    }
    groups.sort_by(|left, right| right.1.cmp(&left.1));
    groups
}

impl LiveSite for KuaishouSite {
    fn platform(&self) -> Platform {
        Platform::Kuaishou
    }

    fn search(&self, http: &HttpSession, keyword: &str) -> Result<Vec<LiveRoomItem>, LiveError> {
        let referer = format!("{REFERER}/search?keyword={keyword}");
        let value = Self::json(
            http,
            &format!("{API}/search/liveStream"),
            &[("keyword", keyword), ("page", "1"), ("ussid", "")],
            &referer,
        )?;
        let data = value.get("data").unwrap_or(&Value::Null);
        let result = data.get("result").and_then(Value::as_i64).unwrap_or(0);
        if result != 0 {
            let message = text_of(data, "error_msg");
            return Err(LiveError::protocol(if message.is_empty() {
                "快手搜索暂时不可用（接口返回异常）".to_string()
            } else {
                format!("快手搜索暂时不可用：{message}")
            }));
        }
        let mut items = Vec::new();
        for entry in data.get("list").and_then(Value::as_array).into_iter().flatten() {
            if let Some(item) = room_item(entry) {
                items.push(item);
            }
        }
        Ok(items)
    }

    fn detail(&self, http: &HttpSession, room_id: &str) -> Result<LiveRoomDetail, LiveError> {
        let room_id = room_id.trim();
        let url = format!("{REFERER}/u/{room_id}");
        let owned = Self::headers(&url);
        let borrowed: Vec<(&str, &str)> = owned
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();
        let html = http.get_text(&url, &[], &borrowed)?;
        let state = extract_state(&html).ok_or_else(|| {
            LiveError::protocol("快手房间页没有内嵌数据（页面结构可能已变化，或触发了风控）")
        })?;
        let liveroom = state
            .get("liveroom")
            .ok_or_else(|| LiveError::protocol("快手房间页缺少 liveroom 数据"))?;
        let play_list = liveroom
            .get("playList")
            .and_then(Value::as_array)
            .ok_or_else(|| LiveError::protocol("快手房间页缺少 playList"))?;

        // playList 可能一次给出多个房间（同页推荐），优先挑作者 ID 匹配的那条。
        let matched = play_list
            .iter()
            .filter(|entry| entry.is_object())
            .find(|entry| {
                entry
                    .get("author")
                    .is_some_and(|author| text_of(author, "id") == room_id)
            });
        let first = matched
            .or_else(|| play_list.iter().find(|entry| entry.is_object()))
            .ok_or_else(|| LiveError::protocol("快手没有返回房间信息"))?;

        let author = first.get("author").cloned().unwrap_or(Value::Null);
        let live_stream = first.get("liveStream").cloned().unwrap_or(Value::Null);
        let game = first.get("gameInfo").cloned().unwrap_or(Value::Null);
        let stream_id = text_of(&live_stream, "id");
        let living = is_live_flag(first.get("isLiving"))
            || is_live_flag(first.get("living"))
            || !stream_id.is_empty();
        let title = {
            let mut title = text_of(first, "caption");
            if title.is_empty() {
                title = text_of(&live_stream, "caption");
            }
            if title.is_empty() {
                title = text_of(&game, "name");
            }
            if title.is_empty() {
                title = text_of(&author, "name");
            }
            title
        };
        let author_id = {
            let value = text_of(&author, "id");
            if value.is_empty() {
                room_id.to_string()
            } else {
                value
            }
        };

        Ok(LiveRoomDetail {
            platform: Platform::Kuaishou,
            room_id: author_id.clone(),
            title,
            user_name: text_of(&author, "name"),
            avatar: normalize_image(&text_of(&author, "avatar")),
            cover: normalize_image(&text_of(&live_stream, "poster")),
            online: if living {
                number_of(&game, "watchingCount")
            } else {
                0
            },
            viewers: 0,
            guard_count: 0,
            live_start_time: 0,
            live: living,
            area: {
                let name = text_of(&game, "name");
                if name.is_empty() { None } else { Some(name) }
            },
            intro: text_of(&author, "description"),
            url: url.clone(),
            extra: RoomExtra::Kuaishou {
                author_id,
                stream_id,
                play_urls: live_stream
                    .get("playUrls")
                    .cloned()
                    .or_else(|| first.get("playUrls").cloned())
                    .unwrap_or(Value::Null),
            },
        })
    }

    fn qualities(
        &self,
        _http: &HttpSession,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError> {
        let RoomExtra::Kuaishou { play_urls, .. } = &detail.extra else {
            return Err(LiveError::protocol("快手房间缺少取流上下文"));
        };
        let groups = group_qualities(play_urls);
        if groups.is_empty() {
            return Err(LiveError::protocol(if detail.live {
                "快手没有返回播放地址（可能正在切换 CDN，稍后重试）"
            } else {
                "主播不在播，没有可用的清晰度"
            }));
        }
        Ok(groups
            .into_iter()
            .map(|(name, _, urls)| PlayQuality {
                name,
                data: QualityData::Kuaishou { urls },
            })
            .collect())
    }

    fn recommend(&self, http: &HttpSession, page: u32) -> Result<Vec<LiveRoomItem>, LiveError> {
        // 快手网页首页分「首屏」和「换一批」两套接口：
        // - `home/list` 是首屏，固定返回 4 个 label 分组、每组 12 个房间，
        //   **没有分页参数**，`?page=2` 也是同一份数据；
        // - `home/more?labelId=N` 才是「换一批」，每次调用返回一批新的热门房间。
        // 之前用 page>1 直接返回空，界面上「加载更多」就成了死按钮。
        if page > 1 {
            // labelId 2~5 对应首屏那四个分组（热推 / 端游 / 手游 / 主机），
            // 按页轮换，避免每次「加载更多」都只翻同一个分组。
            let label = 2 + (page.saturating_sub(2) % 4);
            let label_id = label.to_string();
            let value = Self::json(
                http,
                &format!("{API}/home/more"),
                &[("labelId", label_id.as_str())],
                REFERER,
            )?;
            let Some(list) = value
                .get("data")
                .and_then(|data| data.get("list"))
                .and_then(Value::as_array)
            else {
                return Ok(Vec::new());
            };
            let items: Vec<LiveRoomItem> = list.iter().filter_map(room_item).collect();
            return Ok(sort_by_online(items));
        }
        let value = Self::json(http, &format!("{API}/home/list"), &[], REFERER)?;
        let groups = value
            .get("data")
            .and_then(|data| data.get("list"))
            .and_then(Value::as_array)
            .ok_or_else(|| LiveError::protocol("快手推荐接口返回格式异常"))?;
        let mut items = Vec::new();
        for group in groups {
            for block in group
                .get("gameLiveInfo")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                for entry in block
                    .get("liveInfo")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(item) = room_item(entry) {
                        items.push(item);
                    }
                }
            }
        }
        Ok(sort_by_online(items))
    }

    fn categories(&self, http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError> {
        let mut categories = Vec::new();
        for (id, name) in ROOT_CATEGORIES {
            let mut children = Vec::new();
            // 热门没有二级分类，跳过请求。
            if id != "1" {
                let value = Self::json(
                    http,
                    &format!("{API}/category/data"),
                    &[("type", id), ("page", "1"), ("size", "100")],
                    REFERER,
                )?;
                for entry in value
                    .get("data")
                    .and_then(|data| data.get("list"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    children.push(LiveSubCategory {
                        id: text_of(entry, "id"),
                        name: text_of(entry, "name"),
                        parent_id: id.to_string(),
                        pic: normalize_image(&text_of(entry, "poster")),
                    });
                }
            }
            if !children.is_empty() || id == "1" {
                categories.push(LiveCategory {
                    id: id.to_string(),
                    name: name.to_string(),
                    children,
                });
            }
        }
        Ok(categories)
    }

    fn category_rooms(
        &self,
        http: &HttpSession,
        category: &LiveSubCategory,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        // 游戏分区的 id 是短数字，非游戏分区是长串；两个接口分开。
        let api = if category.id.len() < 7 {
            format!("{API}/gameboard/list")
        } else {
            format!("{API}/non-gameboard/list")
        };
        let page_text = page.to_string();
        let value = Self::json(
            http,
            &api,
            &[
                ("filterType", "0"),
                ("pageSize", "20"),
                ("gameId", category.id.as_str()),
                ("page", page_text.as_str()),
            ],
            REFERER,
        )?;
        let mut items = Vec::new();
        for entry in value
            .get("data")
            .and_then(|data| data.get("list"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let author = entry.get("author").cloned().unwrap_or(Value::Null);
            let room_id = text_of(&author, "id");
            if room_id.is_empty() {
                continue;
            }
            items.push(LiveRoomItem {
                platform: Platform::Kuaishou,
                room_id,
                title: text_of(entry, "caption"),
                user_name: text_of(&author, "name"),
                cover: normalize_image(&text_of(entry, "poster")),
                online: number_of(entry, "watchingCount"),
            });
        }
        Ok(items)
    }

    fn play(
        &self,
        _http: &HttpSession,
        _detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError> {
        let QualityData::Kuaishou { urls } = &quality.data else {
            return Err(LiveError::parse("清晰度与平台不匹配"));
        };
        let mut flv = Vec::new();
        let mut hls = Vec::new();
        for url in urls {
            if url.to_ascii_lowercase().contains(".m3u8") {
                hls.push(url.clone());
            } else {
                flv.push(url.clone());
            }
        }
        if flv.is_empty() && hls.is_empty() {
            return Err(LiveError::protocol("快手没有返回这个清晰度的播放地址"));
        }
        // 同抖音：HLS 需要 Referer，WebView 里补不上，只在没有 FLV 时兜底。
        let hls = if flv.is_empty() { hls } else { Vec::new() };
        Ok(PlayUrls::new(flv)
            .with_hls(hls)
            .header("referer", REFERER)
            .header("user-agent", UA))
    }
}

/// 首页推荐与搜索里的条目结构基本一致，统一成一个提取函数。
/// 有人气数据时按人气降序，否则保持接口给的顺序。
fn sort_by_online(mut items: Vec<LiveRoomItem>) -> Vec<LiveRoomItem> {
    if items.iter().any(|item| item.online > 0) {
        items.sort_by(|left, right| right.online.cmp(&left.online));
    }
    items
}

fn room_item(entry: &Value) -> Option<LiveRoomItem> {
    let author = entry.get("author")?;
    let room_id = text_of(author, "id");
    if room_id.is_empty() {
        return None;
    }
    let stream = entry.get("liveStream").cloned().unwrap_or(Value::Null);
    let game = entry.get("gameInfo").cloned().unwrap_or(Value::Null);
    let title = {
        let mut title = text_of(entry, "caption");
        if title.is_empty() {
            title = text_of(&stream, "caption");
        }
        if title.is_empty() {
            title = text_of(&game, "name");
        }
        title
    };
    // 首页卡片用游戏封面，房间页用直播截图；两处都要兼容。
    let cover = {
        let game_cover = text_of(&game, "poster");
        if game_cover.is_empty() {
            normalize_image(&text_of(&stream, "poster"))
        } else {
            normalize_image(&game_cover)
        }
    };
    Some(LiveRoomItem {
        platform: Platform::Kuaishou,
        room_id,
        title,
        user_name: text_of(author, "name"),
        cover,
        online: number_of(entry, "watchingCount"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 切出内嵌状态并处理字符串里的括号() {
        let html = r#"<script>window.__INITIAL_STATE__={"a":{"b":"x}y"},"c":[1,2]};</script>"#;
        let value = extract_state(html).expect("应当解析成功");
        assert_eq!(value["a"]["b"], "x}y");
        assert_eq!(value["c"][1], 2);
    }

    #[test]
    fn 内嵌状态里的undefined当成null() {
        let html = r#"window.__INITIAL_STATE__={"a":undefined,"b":1}"#;
        let value = extract_state(html).expect("应当解析成功");
        assert!(value["a"].is_null());
        assert_eq!(value["b"], 1);
    }

    #[test]
    fn 缺少标记时返回None() {
        assert!(extract_state("<html></html>").is_none());
    }

    #[test]
    fn 按清晰度归并并保序() {
        let play_urls = serde_json::json!([{
            "adaptationSet": {"representation": [
                {"name": "蓝光", "level": 50, "url": "https://a/1.flv"},
                {"name": "蓝光", "level": 50, "url": "https://a/2.flv"},
                {"name": "标清", "level": 10, "url": "https://a/3.flv"}
            ]}
        }]);
        let groups = group_qualities(&play_urls);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "蓝光");
        assert_eq!(groups[0].2.len(), 2);
        assert_eq!(groups[1].0, "标清");
    }

    #[test]
    fn 封面缺扩展名时补jpg() {
        assert_eq!(normalize_image("https://a/b/c"), "https://a/b/c.jpg");
        assert_eq!(normalize_image("https://a/b/c.webp"), "https://a/b/c.webp");
        assert_eq!(normalize_image(""), "");
    }
}
