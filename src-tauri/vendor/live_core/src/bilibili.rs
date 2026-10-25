//! 哔哩哔哩直播。
//!
//! 关键点（均已实测）：
//! - 房间信息接口必须带 `buvid3/buvid4` Cookie **且** 做 wbi 签名，否则稳定返回 `-352`。
//! - 取流接口 `getRoomPlayInfo` 反而无需签名，只要房间号。
//!
//! 所有 `parse_*` 都是纯函数：只吃 JSON，不碰网络，因此可以用 fixture 离线测试。

use crate::error::LiveError;
use crate::http::{HttpSession, check_code};
use crate::model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
    QualityData, RoomExtra,
};
use crate::site::LiveSite;
use crate::util::{absolute, dig, strip_tags, text, u32_of, u64_of};
use crate::wbi::WbiKeys;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const REFERER: &str = "https://live.bilibili.com/";
const ROOM_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- 纯解析

/// 解析 `search/type` 响应。
pub fn parse_search(value: &Value) -> Vec<LiveRoomItem> {
    dig(value, "data.result.live_room")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let room_id = text(item, "roomid")?;
            if room_id.is_empty() {
                return None;
            }
            Some(LiveRoomItem {
                platform: Platform::Bilibili,
                room_id,
                // 搜索结果的标题带 <em class="keyword"> 高亮标签。
                title: strip_tags(&text(item, "title").unwrap_or_default()),
                user_name: strip_tags(&text(item, "uname").unwrap_or_default()),
                cover: absolute(&text(item, "cover").unwrap_or_default()),
                online: u64_of(item, "online"),
            })
        })
        .collect()
}

/// 解析 `getInfoByRoom` 响应。
pub fn parse_detail(
    value: &Value,
    buvid3: String,
    buvid4: String,
    fallback_room_id: &str,
) -> Result<LiveRoomDetail, LiveError> {
    check_code(value, "getInfoByRoom")?;
    let data = dig(value, "data").ok_or_else(|| LiveError::protocol("getInfoByRoom 缺少 data"))?;
    if dig(data, "room_info").is_none() {
        return Err(LiveError::protocol("getInfoByRoom 缺少 room_info"));
    }
    let room_id = text(data, "room_info.room_id").unwrap_or_else(|| fallback_room_id.to_string());
    Ok(LiveRoomDetail {
        platform: Platform::Bilibili,
        title: text(data, "room_info.title").unwrap_or_default(),
        user_name: text(data, "anchor_info.base_info.uname").unwrap_or_default(),
        avatar: absolute(&text(data, "anchor_info.base_info.face").unwrap_or_default()),
        cover: absolute(&text(data, "room_info.cover").unwrap_or_default()),
        online: u64_of(data, "room_info.online"),
        live: u32_of(data, "room_info.live_status") == 1,
        area: text(data, "room_info.area_name").filter(|value| !value.is_empty()),
        intro: strip_tags(&text(data, "room_info.description").unwrap_or_default()),
        url: format!("https://live.bilibili.com/{room_id}"),
        extra: RoomExtra::Bilibili {
            buvid3,
            buvid4,
            token: String::new(),
            host: "broadcastlv.chat.bilibili.com".to_string(),
            room_id: room_id.clone(),
            cookie: String::new(),
            uid: 0,
        },
        room_id,
    })
}

/// 解析 `playurl_info.playurl`，得到可用清晰度（高码率在前）。
pub fn parse_qualities(playurl: &Value) -> Result<Vec<PlayQuality>, LiveError> {
    let mut descs: BTreeMap<u32, String> = BTreeMap::new();
    for item in array_of(playurl, "g_qn_desc") {
        if let Some(qn) = item.get("qn").and_then(Value::as_u64) {
            let desc = item
                .get("desc")
                .and_then(Value::as_str)
                .unwrap_or("未知")
                .to_string();
            descs.insert(qn as u32, desc);
        }
    }

    let mut accepted: BTreeSet<u32> = BTreeSet::new();
    for stream in array_of(playurl, "stream") {
        for format in array_of(stream, "format") {
            for codec in array_of(format, "codec") {
                for qn in array_of(codec, "accept_qn") {
                    if let Some(qn) = qn.as_u64() {
                        accepted.insert(qn as u32);
                    }
                }
            }
        }
    }
    if accepted.is_empty() {
        return Err(LiveError::protocol("B 站播放信息里没有可用的清晰度"));
    }

    Ok(accepted
        .iter()
        .rev()
        .map(|qn| PlayQuality {
            name: descs
                .get(qn)
                .cloned()
                .unwrap_or_else(|| format!("清晰度 {qn}")),
            data: QualityData::Bilibili { qn: *qn },
        })
        .collect())
}

/// 解析 `playurl_info.playurl`，拼出直链（非 mcdn 节点优先）。
pub fn parse_play_urls(playurl: &Value) -> Result<PlayUrls, LiveError> {
    let mut urls: Vec<String> = Vec::new();
    for stream in array_of(playurl, "stream") {
        for format in array_of(stream, "format") {
            for codec in array_of(format, "codec") {
                let base = codec
                    .get("base_url")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                for info in array_of(codec, "url_info") {
                    let host = info.get("host").and_then(Value::as_str).unwrap_or_default();
                    let extra = info.get("extra").and_then(Value::as_str).unwrap_or_default();
                    let url = format!("{host}{base}{extra}");
                    if url.starts_with("http") {
                        urls.push(url);
                    }
                }
            }
        }
    }
    if urls.is_empty() {
        return Err(LiveError::protocol("B 站没有返回可播放的直链"));
    }
    urls.sort_by_key(|url| url.contains("mcdn"));
    Ok(PlayUrls::new(urls)
        .header("referer", REFERER)
        .header("user-agent", ROOM_UA))
}

/// `getListByArea` / `getRoomList` 的房间列表。
pub fn parse_rooms(value: &Value, path: &str) -> Vec<LiveRoomItem> {
    let mut rooms = Vec::new();
    for item in dig(value, path)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(room_id) = text(item, "roomid") else {
            continue;
        };
        let cover = text(item, "cover")
            .filter(|cover| !cover.is_empty())
            .or_else(|| text(item, "user_cover"))
            .or_else(|| text(item, "system_cover"))
            .unwrap_or_default();
        rooms.push(LiveRoomItem {
            platform: Platform::Bilibili,
            room_id,
            title: strip_tags(&text(item, "title").unwrap_or_default()),
            user_name: strip_tags(&text(item, "uname").unwrap_or_default()),
            cover: absolute(&cover),
            online: u64_of(item, "online"),
        });
    }
    rooms
}

/// `Area/getList` 的分类树。
pub fn parse_categories(value: &Value) -> Vec<LiveCategory> {
    let mut categories = Vec::new();
    for item in dig(value, "data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(id) = text(item, "id") else {
            continue;
        };
        let mut children = Vec::new();
        for sub in dig(item, "list")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            children.push(LiveSubCategory {
                id: text(sub, "id").unwrap_or_default(),
                name: text(sub, "name").unwrap_or_default(),
                parent_id: id.clone(),
                pic: absolute(&text(sub, "pic").unwrap_or_default()),
            });
        }
        categories.push(LiveCategory {
            id,
            name: text(item, "name").unwrap_or_default(),
            children,
        });
    }
    categories
}

fn array_of<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

// ---------------------------------------------------------------- 站点实现

pub struct BilibiliSite {
    buvid: Mutex<Option<(String, String)>>,
    wbi: Mutex<Option<WbiKeys>>,
}

impl Default for BilibiliSite {
    fn default() -> Self {
        Self::new()
    }
}

impl BilibiliSite {
    pub fn new() -> Self {
        Self {
            buvid: Mutex::new(None),
            wbi: Mutex::new(None),
        }
    }

    /// 设备指纹。没有它，`getInfoByRoom` 在风控下必然 -352（已实测）。
    pub fn buvid(&self, http: &HttpSession) -> Result<(String, String), LiveError> {
        if let Some(cached) = self.buvid.lock().expect("buvid 锁").clone() {
            return Ok(cached);
        }
        let value = http.get_json(
            "https://api.bilibili.com/x/frontend/finger/spi",
            &[],
            &[("referer", REFERER), ("user-agent", ROOM_UA)],
        )?;
        let b3 = text(&value, "data.b_3").unwrap_or_default();
        let b4 = text(&value, "data.b_4").unwrap_or_default();
        if b3.is_empty() {
            return Err(LiveError::protocol("finger/spi 未返回 buvid3"));
        }
        let pair = (b3, b4);
        *self.buvid.lock().expect("buvid 锁") = Some(pair.clone());
        Ok(pair)
    }

    fn cookie_header(&self, http: &HttpSession) -> Result<String, LiveError> {
        let (b3, b4) = self.buvid(http)?;
        let mut cookie = format!("buvid3={b3};buvid4={b4};");
        if let Some(extra) = http.cookie() {
            cookie.push_str(extra);
        }
        Ok(cookie)
    }

    /// wbi 密钥（nav 未登录也返回，只是 code=-101）。
    pub fn wbi(&self, http: &HttpSession) -> Result<WbiKeys, LiveError> {
        if let Some(cached) = self.wbi.lock().expect("wbi 锁").clone() {
            return Ok(cached);
        }
        let cookie = self.cookie_header(http)?;
        let value = http.get_json(
            "https://api.bilibili.com/x/web-interface/nav",
            &[],
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        let keys = WbiKeys::from_nav(&value)?;
        *self.wbi.lock().expect("wbi 锁") = Some(keys.clone());
        Ok(keys)
    }

    fn signed_url(
        &self,
        http: &HttpSession,
        base: &str,
        params: &[(&str, &str)],
    ) -> Result<String, LiveError> {
        let keys = self.wbi(http)?;
        let mut map = BTreeMap::new();
        for (key, value) in params {
            map.insert((*key).to_string(), (*value).to_string());
        }
        let query = keys.sign(&map, now_secs());
        Ok(format!("{base}?{query}"))
    }

    /// 弹幕服务器地址与 token（需要 wbi 签名）。
    fn danmu_info(
        &self,
        http: &HttpSession,
        room_id: &str,
        cookie: &str,
    ) -> Result<(String, String), LiveError> {
        let url = self.signed_url(
            http,
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo",
            &[("id", room_id)],
        )?;
        let value = http.get_json_raw(
            &url,
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie),
            ],
        )?;
        let token = text(&value, "data.token").unwrap_or_default();
        if token.is_empty() {
            return Err(LiveError::protocol("getDanmuInfo 未返回 token"));
        }
        let host = dig(&value, "data.host_list.0.host")
            .and_then(Value::as_str)
            .unwrap_or("broadcastlv.chat.bilibili.com")
            .to_string();
        Ok((token, host))
    }

    /// 调 `getRoomPlayInfo`，返回 `data.playurl_info.playurl`。
    fn playurl(
        &self,
        http: &HttpSession,
        room_id: &str,
        extra: &[(&str, &str)],
    ) -> Result<Value, LiveError> {
        let cookie = self.cookie_header(http)?;
        let mut params: Vec<(&str, &str)> =
            vec![("room_id", room_id), ("protocol", "0,1"), ("platform", "web")];
        params.extend_from_slice(extra);
        let value = http.get_json(
            "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo",
            &params,
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        check_code(&value, "getRoomPlayInfo")?;
        dig(&value, "data.playurl_info.playurl")
            .cloned()
            .ok_or_else(|| {
                LiveError::unsupported("房间当前没有可用的播放地址（可能未开播或仅限录播）")
            })
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

impl LiveSite for BilibiliSite {
    fn platform(&self) -> Platform {
        Platform::Bilibili
    }

    fn search(&self, http: &HttpSession, keyword: &str) -> Result<Vec<LiveRoomItem>, LiveError> {
        let cookie = self.cookie_header(http)?;
        let value = http.get_json(
            "https://api.bilibili.com/x/web-interface/search/type",
            &[
                ("context", ""),
                ("search_type", "live"),
                ("cover_type", "user_cover"),
                ("order", ""),
                ("keyword", keyword),
                ("page", "1"),
            ],
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        check_code(&value, "search/type")?;
        Ok(parse_search(&value))
    }

    fn detail(&self, http: &HttpSession, room_id: &str) -> Result<LiveRoomDetail, LiveError> {
        let cookie = self.cookie_header(http)?;
        let (buvid3, buvid4) = self.buvid(http)?;
        let url = self.signed_url(
            http,
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom",
            &[("room_id", room_id)],
        )?;
        let value = http.get_json_raw(
            &url,
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        let mut detail = parse_detail(&value, buvid3, buvid4, room_id)?;
        if let RoomExtra::Bilibili {
            cookie: slot_cookie,
            uid: slot_uid,
            ..
        } = &mut detail.extra
        {
            *slot_cookie = cookie.clone();
            *slot_uid = cookie
                .split(';')
                .find_map(|part| part.trim().strip_prefix("DedeUserID="))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
        }
        // 弹幕 token 拿不到不影响进房，只是没有弹幕。
        if let Ok((token, host)) = self.danmu_info(http, &detail.room_id, &cookie)
            && let RoomExtra::Bilibili {
                token: slot_token,
                host: slot_host,
                ..
            } = &mut detail.extra
        {
            *slot_token = token;
            *slot_host = host;
        }
        Ok(detail)
    }

    fn qualities(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError> {
        let playurl = self.playurl(
            http,
            &detail.room_id,
            &[("format", "0,1,2"), ("codec", "0,1")],
        )?;
        parse_qualities(&playurl)
    }

    fn recommend(&self, http: &HttpSession, page: u32) -> Result<Vec<LiveRoomItem>, LiveError> {
        let cookie = self.cookie_header(http)?;
        let page = page.to_string();
        let url = self.signed_url(
            http,
            "https://api.live.bilibili.com/xlive/web-interface/v1/second/getListByArea",
            &[
                ("platform", "web"),
                ("sort", "online"),
                ("page_size", "30"),
                ("page", page.as_str()),
            ],
        )?;
        let value = http.get_json_raw(
            &url,
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        check_code(&value, "getListByArea")?;
        Ok(parse_rooms(&value, "data.list"))
    }

    fn categories(&self, http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError> {
        let cookie = self.cookie_header(http)?;
        let value = http.get_json(
            "https://api.live.bilibili.com/room/v1/Area/getList",
            &[("need_entrance", "1"), ("parent_id", "0")],
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        check_code(&value, "Area/getList")?;
        Ok(parse_categories(&value))
    }

    fn category_rooms(
        &self,
        http: &HttpSession,
        category: &LiveSubCategory,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        let cookie = self.cookie_header(http)?;
        let page = page.to_string();
        let value = http.get_json(
            "https://api.live.bilibili.com/room/v1/Area/getRoomList",
            &[
                ("platform", "web"),
                ("parent_area_id", category.parent_id.as_str()),
                ("area_id", category.id.as_str()),
                ("page", page.as_str()),
                ("page_size", "30"),
            ],
            &[
                ("referer", REFERER),
                ("user-agent", ROOM_UA),
                ("cookie", cookie.as_str()),
            ],
        )?;
        check_code(&value, "Area/getRoomList")?;
        Ok(parse_rooms(&value, "data"))
    }

    fn play(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError> {
        let QualityData::Bilibili { qn } = quality.data else {
            return Err(LiveError::parse("清晰度句柄与平台不匹配"));
        };
        let qn = qn.to_string();
        let playurl = self.playurl(
            http,
            &detail.room_id,
            &[("format", "0,2"), ("codec", "0"), ("qn", qn.as_str())],
        )?;
        parse_play_urls(&playurl)
    }
}
