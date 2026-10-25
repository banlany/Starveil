//! 虎牙直播。
//!
//! 两个坑（都已实测）：
//! 1. 房间数据藏在移动页 `window.HNF_GLOBAL_INIT = {...}`，必须做括号扫描；
//!    用非贪婪正则会在第一个 `}` 处截断。
//! 2. 页面给出的 `sFlvAntiCode` 直接拼进 URL 会 403，必须用新的 `seqid` 重算 `wsSecret`。

use crate::error::LiveError;
use crate::http::HttpSession;
use crate::model::{
    HuyaBitrate, HuyaLine, LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform,
    PlayQuality, PlayUrls, QualityData, RoomExtra,
};
use crate::site::LiveSite;
use crate::util::{absolute, dig, md5_hex, text, u32_of, u64_of};
use base64::Engine as _;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const MOBILE_UA: &str =
    "Mozilla/5.0 (Linux; Android 10; SM-G9730) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Dart `Uri.encodeComponent` 的行为：只保留 unreserved。
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

// ---------------------------------------------------------------- 纯解析

/// 解析搜索接口响应。
pub fn parse_search(value: &Value) -> Vec<LiveRoomItem> {
    dig(value, "response.3.docs")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let room_id = text(item, "room_id")?;
            if room_id.is_empty() {
                return None;
            }
            let title = text(item, "game_introduction")
                .filter(|value| !value.trim().is_empty())
                .or_else(|| text(item, "game_roomName"))
                .unwrap_or_default();
            Some(LiveRoomItem {
                platform: Platform::Huya,
                room_id,
                title,
                user_name: text(item, "game_nick").unwrap_or_default(),
                cover: absolute(&text(item, "game_screenshot").unwrap_or_default()),
                online: u64_of(item, "game_total_count"),
            })
        })
        .collect()
}

/// `getLiveListByPage` 的房间列表。
pub fn parse_rooms(value: &Value) -> Vec<LiveRoomItem> {
    let mut rooms = Vec::new();
    for item in dig(value, "data.datas")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let Some(room_id) = text(item, "profileRoom") else {
            continue;
        };
        let title = text(item, "introduction")
            .filter(|title| !title.trim().is_empty())
            .or_else(|| text(item, "roomName"))
            .unwrap_or_default();
        rooms.push(LiveRoomItem {
            platform: Platform::Huya,
            room_id,
            title,
            user_name: text(item, "nick").unwrap_or_default(),
            cover: absolute(&text(item, "screenshot").unwrap_or_default()),
            online: u64_of(item, "totalCount"),
        });
    }
    rooms
}

/// 解析 `window.HNF_GLOBAL_INIT` 对象。
pub fn parse_detail(
    root: &Value,
    html: &str,
    fallback_room_id: &str,
) -> Result<LiveRoomDetail, LiveError> {
    let live_info = dig(root, "roomInfo.tLiveInfo")
        .ok_or_else(|| LiveError::protocol("虎牙页面缺少 roomInfo.tLiveInfo"))?;
    let profile = dig(root, "roomInfo.tProfileInfo")
        .ok_or_else(|| LiveError::protocol("虎牙页面缺少 roomInfo.tProfileInfo"))?;

    let title = text(live_info, "sIntroduction")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| text(live_info, "sRoomName"))
        .unwrap_or_default();

    let presenter_uid = presenter_uid(html).unwrap_or(0);

    let mut lines = Vec::new();
    for item in dig(live_info, "tLiveStreamInfo.vStreamInfo.value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let flv_url = text(item, "sFlvUrl").unwrap_or_default();
        let stream_name = text(item, "sStreamName").unwrap_or_default();
        if flv_url.is_empty() || stream_name.is_empty() {
            continue;
        }
        lines.push(HuyaLine {
            flv_url,
            stream_name,
            cdn: text(item, "sCdnType").unwrap_or_default(),
            anti_code: text(item, "sFlvAntiCode").unwrap_or_default(),
        });
    }

    let mut bitrates = Vec::new();
    for item in dig(live_info, "tLiveStreamInfo.vBitRateInfo.value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let name = text(item, "sDisplayName").unwrap_or_default();
        if name.is_empty() || name.contains("HDR") {
            continue;
        }
        bitrates.push(HuyaBitrate {
            name,
            bitrate: u32_of(item, "iBitRate"),
        });
    }

    let room_id = text(live_info, "lProfileRoom")
        .filter(|value| !value.is_empty() && value != "0")
        .unwrap_or_else(|| fallback_room_id.to_string());

    Ok(LiveRoomDetail {
        platform: Platform::Huya,
        room_id: room_id.clone(),
        title,
        user_name: text(profile, "sNick").unwrap_or_default(),
        avatar: absolute(
            &text(profile, "sAvatar180")
                .or_else(|| text(profile, "sAvatar"))
                .unwrap_or_default(),
        ),
        cover: absolute(&text(live_info, "sScreenshot").unwrap_or_default()),
        online: u64_of(live_info, "lTotalCount"),
        live: u32_of(root, "roomInfo.eLiveStatus") == 2,
        area: text(live_info, "sGameFullName").filter(|value| !value.trim().is_empty()),
        intro: text(live_info, "sIntroduction").unwrap_or_default(),
        url: format!("https://www.huya.com/{room_id}"),
        extra: RoomExtra::Huya {
            lines,
            bitrates,
            presenter_uid,
            yyid: u64_of(live_info, "lYyid"),
        },
    })
}

/// 由码率表生成清晰度；表为空时退回「原画 / 高清」两档。
pub fn parse_qualities(bitrates: &[HuyaBitrate], has_lines: bool) -> Result<Vec<PlayQuality>, LiveError> {
    if !has_lines {
        return Err(LiveError::unsupported("该房间未开播或没有可用线路"));
    }
    let bitrates = if bitrates.is_empty() {
        vec![
            HuyaBitrate {
                name: "原画".to_string(),
                bitrate: 0,
            },
            HuyaBitrate {
                name: "高清".to_string(),
                bitrate: 2000,
            },
        ]
    } else {
        bitrates.to_vec()
    };
    Ok(bitrates
        .into_iter()
        .map(|item| PlayQuality {
            name: item.name,
            data: QualityData::Huya {
                bitrate: item.bitrate,
            },
        })
        .collect())
}

// ---------------------------------------------------------------- 站点实现

pub struct HuyaSite;

impl Default for HuyaSite {
    fn default() -> Self {
        Self::new()
    }
}

impl HuyaSite {
    pub fn new() -> Self {
        Self
    }
}

impl LiveSite for HuyaSite {
    fn platform(&self) -> Platform {
        Platform::Huya
    }

    fn search(&self, http: &HttpSession, keyword: &str) -> Result<Vec<LiveRoomItem>, LiveError> {
        let value = http.get_json(
            "https://search.cdn.huya.com/",
            &[
                ("m", "Search"),
                ("do", "getSearchContent"),
                ("q", keyword),
                ("uid", "0"),
                ("v", "4"),
                ("typ", "-5"),
                ("livestate", "0"),
                ("rows", "30"),
                ("start", "0"),
            ],
            &[("user-agent", DESKTOP_UA)],
        )?;
        Ok(parse_search(&value))
    }

    fn detail(&self, http: &HttpSession, room_id: &str) -> Result<LiveRoomDetail, LiveError> {
        let html = http.get_text(
            &format!("https://m.huya.com/{room_id}"),
            &[],
            &[("user-agent", MOBILE_UA)],
        )?;
        let root = extract_global_init(&html)?;
        parse_detail(&root, &html, room_id)
    }

    fn qualities(
        &self,
        _http: &HttpSession,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError> {
        let RoomExtra::Huya { lines, bitrates, .. } = &detail.extra else {
            return Err(LiveError::protocol("虎牙房间缺少取流上下文"));
        };
        parse_qualities(bitrates, !lines.is_empty())
    }

    fn recommend(&self, http: &HttpSession, page: u32) -> Result<Vec<LiveRoomItem>, LiveError> {
        let value = http.get_json(
            "https://www.huya.com/cache.php",
            &[
                ("m", "LiveList"),
                ("do", "getLiveListByPage"),
                ("tagAll", "0"),
                ("page", &page.to_string()),
            ],
            &[("user-agent", DESKTOP_UA)],
        )?;
        Ok(parse_rooms(&value))
    }

    fn categories(&self, http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError> {
        // 虎牙没有一次性返回分类树的接口：一级是固定的四个业务线，二级按业务线单独拉。
        let mut categories = Vec::new();
        for (id, name) in [("1", "网游"), ("2", "单机"), ("8", "娱乐"), ("3", "手游")] {
            let value = http.get_json(
                "https://live.cdn.huya.com/liveconfig/game/bussLive",
                &[("bussType", id)],
                &[("user-agent", DESKTOP_UA)],
            )?;
            let mut children = Vec::new();
            for item in dig(&value, "data")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let gid = match item.get("gid") {
                    Some(Value::Object(_)) => text(item, "gid.value")
                        .and_then(|value| value.split(',').next().map(str::to_string))
                        .unwrap_or_default(),
                    _ => text(item, "gid").unwrap_or_default(),
                };
                if gid.is_empty() {
                    continue;
                }
                children.push(LiveSubCategory {
                    pic: format!("https://huyaimg.msstatic.com/cdnimage/game/{gid}-MS.jpg"),
                    name: text(item, "gameFullName").unwrap_or_default(),
                    parent_id: id.to_string(),
                    id: gid,
                });
            }
            categories.push(LiveCategory {
                id: id.to_string(),
                name: name.to_string(),
                children,
            });
        }
        Ok(categories)
    }

    fn category_rooms(
        &self,
        http: &HttpSession,
        category: &LiveSubCategory,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        let value = http.get_json(
            "https://www.huya.com/cache.php",
            &[
                ("m", "LiveList"),
                ("do", "getLiveListByPage"),
                ("tagAll", "0"),
                ("gameId", category.id.as_str()),
                ("page", &page.to_string()),
            ],
            &[("user-agent", DESKTOP_UA)],
        )?;
        Ok(parse_rooms(&value))
    }

    fn play(
        &self,
        _http: &HttpSession,
        detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError> {
        let RoomExtra::Huya {
            lines,
            presenter_uid,
            ..
        } = &detail.extra
        else {
            return Err(LiveError::protocol("虎牙房间缺少取流上下文"));
        };
        let QualityData::Huya { bitrate } = quality.data else {
            return Err(LiveError::parse("清晰度句柄与平台不匹配"));
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default();

        let mut token_cache: BTreeMap<String, String> = BTreeMap::new();
        let mut urls: Vec<String> = lines
            .iter()
            .filter_map(|line| {
                // Dart 版每次取流都会向 getCdnTokenInfoEx 换新 token；
                // 页面里的 anti-code 只能撑几秒，必须优先用新 token。
                let token = token_cache
                    .entry(line.stream_name.clone())
                    .or_insert_with(|| {
                        crate::huya_token::fetch_token(&line.stream_name)
                            .unwrap_or_else(|_| line.anti_code.clone())
                    })
                    .clone();
                let mut fresh = line.clone();
                fresh.anti_code = token;
                build_play_url(&fresh, *presenter_uid, bitrate, now_ms)
            })
            .collect();
        // 页面默认把 AL 线路排在第一位，但 AL 在国内网络下最容易抖。
        // 优先 TX/HS，最后再回退 AL，减少“刚进房就断流”的概率。
        urls.sort_by_key(|url| {
            if url.contains("tx.flv") || url.contains("hs.flv") {
                0
            } else if url.contains("al.flv") {
                2
            } else {
                1
            }
        });
        if urls.is_empty() {
            return Err(LiveError::protocol("虎牙没有可用的播放地址"));
        }
        Ok(PlayUrls::new(urls).header("user-agent", DESKTOP_UA))
    }
}

/// 从页面里找主播 uid（anticode 的 `seqid` 需要它）。
pub fn presenter_uid(html: &str) -> Option<u64> {
    static CHANNEL: OnceLock<Regex> = OnceLock::new();
    static SUB: OnceLock<Regex> = OnceLock::new();
    let channel = CHANNEL.get_or_init(|| Regex::new(r#""lChannelId"\s*:\s*(\d+)"#).expect("正则"));
    let sub = SUB.get_or_init(|| Regex::new(r#""lSubChannelId"\s*:\s*(\d+)"#).expect("正则"));
    channel
        .captures(html)
        .or_else(|| sub.captures(html))
        .and_then(|captures| captures.get(1))
        .and_then(|matched| matched.as_str().parse().ok())
        .filter(|uid: &u64| *uid > 0)
}

/// 重算 anticode 并拼出 flv 地址。
pub fn build_play_url(
    line: &HuyaLine,
    presenter_uid: u64,
    bitrate: u32,
    now_ms: u64,
) -> Option<String> {
    let params: BTreeMap<String, String> = form_urlencoded::parse(line.anti_code.as_bytes())
        .into_owned()
        .collect();
    let fm = params.get("fm")?.clone();
    let ws_time = params.get("wsTime")?.clone();
    let ctype = params
        .get("ctype")
        .cloned()
        .unwrap_or_else(|| "huya_pc_exe".to_string());
    let platform_id: u64 = params
        .get("t")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let fs = params
        .get("fs")
        .cloned()
        .unwrap_or_else(|| "bgct".to_string());
    let is_wap = platform_id == 103;

    // form_urlencoded 已把 fm 解码过一次。
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(fm.as_bytes())
        .ok()?;
    let decoded = String::from_utf8_lossy(&decoded);
    let prefix = decoded.split('_').next()?.to_string();

    let seq_id = presenter_uid.wrapping_add(now_ms);
    let secret_hash = md5_hex(&format!("{seq_id}|{ctype}|{platform_id}"));
    let calc_uid = if is_wap {
        presenter_uid
    } else {
        rotl64(presenter_uid)
    };
    let secret = md5_hex(&format!(
        "{prefix}_{calc_uid}_{}_{secret_hash}_{ws_time}",
        line.stream_name
    ));

    let ws_time_num = u64::from_str_radix(&ws_time, 16).unwrap_or(0);
    let ct = (ws_time_num as f64 + rand::random::<f64>()) * 1000.0;
    let uuid = (((ct % 1e10) + rand::random::<f64>()) * 1e3 % 4_294_967_295.0) as u64;

    let fm_encoded = utf8_percent_encode(&fm, COMPONENT).to_string();

    let mut query = format!(
        "wsSecret={secret}&wsTime={ws_time}&seqid={seq_id}&ctype={ctype}&ver=1&fs={fs}&fm={fm_encoded}&t={platform_id}"
    );
    if is_wap {
        query.push_str(&format!("&uid={presenter_uid}&uuid={uuid}"));
    } else {
        query.push_str(&format!("&u={calc_uid}"));
    }

    let mut url = format!(
        "{}/{}.flv?{query}&codec=264",
        line.flv_url, line.stream_name
    );
    if bitrate > 0 {
        url.push_str(&format!("&ratio={bitrate}"));
    }
    Some(url)
}

/// 32 位低位循环左移 8 位（与 Dart 版 `rotl64` 一致）。
fn rotl64(value: u64) -> u64 {
    let low = value & 0xFFFF_FFFF;
    let rotated = ((low << 8) | (low >> 24)) & 0xFFFF_FFFF;
    (value & !0xFFFF_FFFF) | rotated
}

/// 扫描 `window.HNF_GLOBAL_INIT` 右侧的对象，返回整个 JSON。
pub fn extract_global_init(html: &str) -> Result<Value, LiveError> {
    let marker = "window.HNF_GLOBAL_INIT";
    let start = html
        .find(marker)
        .ok_or_else(|| LiveError::protocol("虎牙页面缺少 HNF_GLOBAL_INIT"))?;
    let brace = html[start..]
        .find('{')
        .map(|offset| start + offset)
        .ok_or_else(|| LiveError::protocol("HNF_GLOBAL_INIT 后没有对象"))?;
    let end = scan_object(html, brace)
        .ok_or_else(|| LiveError::protocol("HNF_GLOBAL_INIT 对象没有闭合"))?;
    serde_json::from_str(&html[brace..end])
        .map_err(|error| LiveError::protocol(format!("HNF_GLOBAL_INIT 不是合法 JSON：{error}")))
}

/// 从 `{` 起做括号配平，跳过字符串内的花括号，返回对象结束位置（不含）。
fn scan_object(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut index = start;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else {
            match byte {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(index + 1);
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 括号扫描跳过字符串里的花括号() {
        let text = r#"window.HNF_GLOBAL_INIT = {"a":"}{","b":{"c":1}};var x=1;"#;
        let start = text.find('{').unwrap();
        let end = scan_object(text, start).unwrap();
        let value: Value = serde_json::from_str(&text[start..end]).unwrap();
        assert_eq!(value["a"], "}{");
        assert_eq!(value["b"]["c"], 1);
    }

    #[test]
    fn 低位循环左移() {
        assert_eq!(rotl64(0x0000_0001), 0x0000_0100);
        assert_eq!(rotl64(0x0000_0000_FFFF_FFFF), 0x0000_0000_FFFF_FFFF);
    }

    #[test]
    fn anticode_结果包含必需字段() {
        let line = HuyaLine {
            flv_url: "http://al.flv.huya.com/src".to_string(),
            stream_name: "294636272-294636272-1".to_string(),
            cdn: "AL".to_string(),
            anti_code: "wsSecret=abc&wsTime=6ade1c89&fm=RFdxOEJjSjNoNkRKdDZUWV8kMF8kMV8kMl8kMw%3D%3D&ctype=tars_mobile&fs=bgct&t=103".to_string(),
        };
        let url = build_play_url(&line, 294636272, 0, 1_700_000_000_000).unwrap();
        assert!(url.starts_with("http://al.flv.huya.com/src/294636272-294636272-1.flv?"));
        for key in [
            "wsSecret=",
            "wsTime=",
            "seqid=",
            "ctype=",
            "ver=1",
            "fs=bgct",
            "uid=",
            "uuid=",
            "codec=264",
        ] {
            assert!(url.contains(key), "缺少 {key}：{url}");
        }
        assert!(!url.contains("ratio="), "原画不该带 ratio");
    }

    #[test]
    fn 原画之外的档位带ratio() {
        let line = HuyaLine {
            flv_url: "http://tx.flv.huya.com/src".to_string(),
            stream_name: "1-1-1".to_string(),
            cdn: "TX".to_string(),
            anti_code: "wsTime=6ade1c89&fm=RFdxOEJjSjNoNkRKdDZUWV8kMF8kMV8kMl8kMw%3D%3D&ctype=tars_mobile&fs=bgct&t=103".to_string(),
        };
        let url = build_play_url(&line, 1, 8000, 1).unwrap();
        assert!(url.contains("&ratio=8000"));
    }
}
