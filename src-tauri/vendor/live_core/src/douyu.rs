//! 斗鱼直播。
//!
//! 房间信息可以匿名拿，但**取流必须带签名**（无签名固定返回
//! `{"error":-9,"msg":"时间戳错误"}`）。签名来自 `homeH5Enc` 下发的混淆脚本，
//! 由 [`crate::douyu_sign`] 执行。

use crate::douyu_sign;
use crate::error::LiveError;
use crate::http::HttpSession;
use crate::model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
    QualityData, RoomExtra,
};
use crate::site::LiveSite;
use crate::util::{decode_entities, dig, hot_count, strip_tags, text, u32_of, u64_of};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const REFERER: &str = "https://www.douyu.com/";
const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- 纯解析

pub fn parse_search(value: &Value) -> Vec<LiveRoomItem> {
    dig(value, "data.relateShow")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let room_id = text(item, "rid")?;
            if room_id.is_empty() {
                return None;
            }
            Some(LiveRoomItem {
                platform: Platform::Douyu,
                room_id,
                title: strip_tags(&text(item, "roomName").unwrap_or_default()),
                user_name: text(item, "nickName").unwrap_or_default(),
                cover: text(item, "roomSrc").unwrap_or_default(),
                online: hot_count(&text(item, "hot").unwrap_or_default()),
            })
        })
        .collect()
}

/// `allpage` / `mixList` 的房间列表（斗鱼的 `rl` 数组）。
pub fn parse_rooms(value: &Value) -> Vec<LiveRoomItem> {
    let mut rooms = Vec::new();
    for item in dig(value, "data.rl")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if item.get("type").and_then(Value::as_i64).unwrap_or(0) != 1 {
            continue;
        }
        let Some(room_id) = text(item, "rid") else {
            continue;
        };
        rooms.push(LiveRoomItem {
            platform: Platform::Douyu,
            room_id,
            title: strip_tags(&text(item, "rn").unwrap_or_default()),
            user_name: strip_tags(&text(item, "nn").unwrap_or_default()),
            cover: text(item, "rs16").unwrap_or_default(),
            online: u64_of(item, "ol"),
        });
    }
    rooms
}

/// `cate/list` 的分类树。
pub fn parse_categories(value: &Value) -> Vec<LiveCategory> {
    let mut categories = Vec::new();
    let subs: Vec<Value> = dig(value, "data.cate2Info")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in dig(value, "data.cate1Info")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(id) = text(item, "cate1Id") else {
            continue;
        };
        let children = subs
            .iter()
            .filter(|sub| text(sub, "cate1Id").as_deref() == Some(id.as_str()))
            .map(|sub| LiveSubCategory {
                id: text(sub, "cate2Id").unwrap_or_default(),
                name: text(sub, "cate2Name").unwrap_or_default(),
                parent_id: id.clone(),
                pic: text(sub, "icon").unwrap_or_default(),
            })
            .collect();
        categories.push(LiveCategory {
            id,
            name: text(item, "cate1Name").unwrap_or_default(),
            children,
        });
    }
    categories
}

pub fn parse_detail(value: &Value, fallback_room_id: &str) -> Result<LiveRoomDetail, LiveError> {
    let room = dig(value, "room")
        .ok_or_else(|| LiveError::protocol("斗鱼 betard 缺少 room 字段"))?;
    if text(room, "room_id").is_none() {
        return Err(LiveError::protocol("斗鱼房间不存在或数据结构已变更"));
    }

    // videoLoop = 1 是录播循环，不算直播中。
    let replay = u32_of(room, "videoLoop") == 1;
    let live = u32_of(room, "show_status") == 1 && !replay;
    let rid = text(room, "room_id").unwrap_or_else(|| fallback_room_id.to_string());
    let area = text(room, "cate2Name")
        .or_else(|| text(room, "game_name"))
        .or_else(|| text(room, "cate_name"))
        .filter(|value| !value.trim().is_empty());

    Ok(LiveRoomDetail {
        platform: Platform::Douyu,
        room_id: rid.clone(),
        title: text(room, "room_name").unwrap_or_default(),
        user_name: text(room, "owner_name").unwrap_or_default(),
        avatar: text(room, "owner_avatar")
            .filter(|value| !value.trim().is_empty())
            .or_else(|| text(room, "avatar.big"))
            .unwrap_or_default(),
        cover: text(room, "room_pic").unwrap_or_default(),
        online: u64_of(room, "room_biz_all.hot"),
        // 斗鱼的热度不是人数，且没有稳定的开播时间字段，交给界面回退。
        viewers: 0,
        live_start_time: u64_of(room, "show_time"),
        live,
        area,
        intro: strip_tags(&text(room, "show_details").unwrap_or_default()),
        url: format!("https://www.douyu.com/{rid}"),
        extra: RoomExtra::Douyu { rid },
    })
}

/// 从 `getH5Play` 响应解析清晰度。
pub fn parse_qualities(value: &Value) -> Result<Vec<PlayQuality>, LiveError> {
    let data = dig(value, "data")
        .ok_or_else(|| LiveError::protocol("斗鱼 getH5Play 缺少 data"))?;

    let mut cdns: Vec<String> = dig(data, "cdnsWithName")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| text(item, "cdn"))
        .collect();
    // scdn 走边缘节点，稳定性差，排到最后。
    cdns.sort_by_key(|cdn| cdn.starts_with("scdn"));

    let qualities: Vec<PlayQuality> = dig(data, "multirates")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            Some(PlayQuality {
                name: text(item, "name")?,
                data: QualityData::Douyu {
                    rate: u32_of(item, "rate"),
                    cdns: cdns.clone(),
                },
            })
        })
        .collect();

    if qualities.is_empty() {
        return Err(LiveError::protocol("斗鱼没有返回可用清晰度"));
    }
    Ok(qualities)
}

/// 从 `getH5Play` 响应拼出可播放直链。
pub fn parse_play_url(value: &Value) -> Option<String> {
    let base = text(value, "data.rtmp_url")?;
    let live = text(value, "data.rtmp_live")?;
    if base.is_empty() || live.is_empty() {
        return None;
    }
    Some(format!("{base}/{}", decode_entities(&live)))
}

// ---------------------------------------------------------------- 站点实现

pub struct DouyuSite {
    device_id: String,
}

impl Default for DouyuSite {
    fn default() -> Self {
        Self::new()
    }
}

impl DouyuSite {
    pub fn new() -> Self {
        Self {
            device_id: douyu_sign::device_id(),
        }
    }

    fn headers(&self, rid: &str) -> Vec<(String, String)> {
        vec![
            ("referer".to_string(), format!("{REFERER}{rid}")),
            ("user-agent".to_string(), DESKTOP_UA.to_string()),
            (
                "cookie".to_string(),
                format!("dy_did={did}; acf_did={did}", did = self.device_id),
            ),
        ]
    }

    fn header_pairs(headers: &[(String, String)]) -> Vec<(&str, &str)> {
        headers
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    }

    /// 拉一次下发的签名脚本并执行，得到 `v=..&did=..&tt=..&sign=..`。
    ///
    /// 签名约 10 分钟后失效，所以取流前总要重拉重签。
    fn play_args(&self, http: &HttpSession, rid: &str) -> Result<String, LiveError> {
        let headers = self.headers(rid);
        let raw = http.get_text(
            "https://www.douyu.com/swf_api/homeH5Enc",
            &[("rids", rid)],
            &Self::header_pairs(&headers),
        )?;
        let value: Value = serde_json::from_str(&raw)?;
        let script = text(&value, &format!("data.room{rid}")).unwrap_or_default();
        if script.is_empty() {
            return Err(LiveError::protocol(format!(
                "斗鱼未下发房间 {rid} 的签名脚本"
            )));
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        douyu_sign::sign(&script, rid, &self.device_id, timestamp).map_err(|error| {
            // 签名引擎失败时不要把底层 TypeError 直接抛给用户，
            // 给一个能指导下一步动作的提示（房间页仍可正常打开）。
            LiveError::unsupported(format!(
                "斗鱼取流需要执行平台下发的签名脚本，本地引擎执行失败（{error}）。可先点「打开房间页面」在浏览器观看。"
            ))
        })
    }

    fn h5play(
        &self,
        http: &HttpSession,
        rid: &str,
        rate: Option<u32>,
        cdn: Option<&str>,
    ) -> Result<Value, LiveError> {
        let mut args = self.play_args(http, rid)?;
        args.push_str("&cdn=");
        if let Some(cdn) = cdn {
            args.push_str(cdn);
        }
        args.push_str(&format!(
            "&rate={}&iar=1&ive=1&hevc=0&fa=0",
            rate.map(|rate| rate as i64).unwrap_or(-1)
        ));

        let headers = self.headers(rid);
        let value = http.post_form_raw(
            &format!("https://www.douyu.com/lapi/live/getH5Play/{rid}"),
            &args,
            &Self::header_pairs(&headers),
        )?;
        let error = value.get("error").and_then(Value::as_i64).unwrap_or(0);
        if error != 0 {
            let message = value
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(LiveError::protocol(format!(
                "斗鱼取流失败 error={error} {message}"
            )));
        }
        Ok(value)
    }
}

impl LiveSite for DouyuSite {
    fn platform(&self) -> Platform {
        Platform::Douyu
    }

    fn search(&self, http: &HttpSession, keyword: &str) -> Result<Vec<LiveRoomItem>, LiveError> {
        let value = http.get_json(
            "https://www.douyu.com/japi/search/api/searchShow",
            &[("kw", keyword), ("page", "1"), ("pageSize", "20")],
            &[
                ("referer", "https://www.douyu.com/search/"),
                ("user-agent", DESKTOP_UA),
            ],
        )?;
        let error = value.get("error").and_then(Value::as_i64).unwrap_or(0);
        if error != 0 {
            return Err(LiveError::protocol(format!("斗鱼搜索失败 error={error}")));
        }
        Ok(parse_search(&value))
    }

    fn detail(&self, http: &HttpSession, room_id: &str) -> Result<LiveRoomDetail, LiveError> {
        let headers = self.headers(room_id);
        let value = http.get_json(
            &format!("https://www.douyu.com/betard/{room_id}"),
            &[],
            &Self::header_pairs(&headers),
        )?;
        parse_detail(&value, room_id)
    }

    fn qualities(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError> {
        let RoomExtra::Douyu { rid } = &detail.extra else {
            return Err(LiveError::protocol("斗鱼房间缺少取流上下文"));
        };
        let value = self.h5play(http, rid, None, None)?;
        parse_qualities(&value)
    }

    fn recommend(&self, http: &HttpSession, page: u32) -> Result<Vec<LiveRoomItem>, LiveError> {
        let value = http.get_json(
            &format!("https://www.douyu.com/japi/weblist/apinc/allpage/6/{page}"),
            &[],
            &[("user-agent", DESKTOP_UA)],
        )?;
        Ok(parse_rooms(&value))
    }

    fn categories(&self, http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError> {
        let value = http.get_json(
            "https://m.douyu.com/api/cate/list",
            &[],
            &[("user-agent", DESKTOP_UA)],
        )?;
        Ok(parse_categories(&value))
    }

    fn category_rooms(
        &self,
        http: &HttpSession,
        category: &LiveSubCategory,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        let value = http.get_json(
            &format!(
                "https://www.douyu.com/gapi/rkc/directory/mixList/2_{}/{page}",
                category.id
            ),
            &[],
            &[("user-agent", DESKTOP_UA)],
        )?;
        Ok(parse_rooms(&value))
    }

    fn play(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError> {
        let RoomExtra::Douyu { rid } = &detail.extra else {
            return Err(LiveError::protocol("斗鱼房间缺少取流上下文"));
        };
        let QualityData::Douyu { rate, cdns } = &quality.data else {
            return Err(LiveError::parse("清晰度句柄与平台不匹配"));
        };
        let cdns = if cdns.is_empty() {
            vec![String::new()]
        } else {
            cdns.clone()
        };

        let mut urls = Vec::new();
        let mut last_error = None;
        for cdn in &cdns {
            let cdn = if cdn.is_empty() {
                None
            } else {
                Some(cdn.as_str())
            };
            match self.h5play(http, rid, Some(*rate), cdn) {
                Ok(value) => {
                    if let Some(url) = parse_play_url(&value) {
                        urls.push(url);
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }

        if urls.is_empty() {
            return Err(last_error
                .unwrap_or_else(|| LiveError::protocol("斗鱼没有返回可播放的直链")));
        }
        Ok(PlayUrls::new(urls)
            .header("referer", REFERER)
            .header("user-agent", DESKTOP_UA))
    }
}
