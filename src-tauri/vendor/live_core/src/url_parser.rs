//! 直播间链接解析。

use crate::model::Platform;

/// 解析结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedUrl {
    pub platform: Platform,
    pub room_id: String,
    /// 短链（b23.tv / v.douyin.com 之类）无法直接取出房间号，需要先跟随跳转。
    pub is_short_link: bool,
    pub raw: String,
}

/// 解析直播间链接；无法识别时返回 `None`。
pub fn parse(input: &str) -> Option<ParsedUrl> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let normalized = if raw.contains("://") {
        raw.to_string()
    } else if raw.contains('/') || raw.contains('.') {
        format!("https://{raw}")
    } else {
        return None;
    };

    let without_scheme = normalized
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(&normalized);
    let (authority, path) = match without_scheme.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => (without_scheme, ""),
    };
    let authority = authority
        .split(['?', '#'])
        .next()
        .unwrap_or(authority)
        .to_ascii_lowercase();
    let host = authority
        .strip_prefix("www.")
        .or_else(|| authority.strip_prefix("m."))
        .unwrap_or(&authority);
    let host = host.split(':').next().unwrap_or(host).to_string();

    let first_segment = path
        .split(['/', '?', '#'])
        .find(|segment| !segment.is_empty())
        .unwrap_or("")
        .to_string();

    let (platform, short) = match host.as_str() {
        "live.bilibili.com" | "bilibili.com" => (Platform::Bilibili, false),
        "b23.tv" => (Platform::Bilibili, true),
        "douyu.com" => (Platform::Douyu, false),
        "huya.com" => (Platform::Huya, false),
        _ => return None,
    };

    if short {
        return Some(ParsedUrl {
            platform,
            room_id: String::new(),
            is_short_link: true,
            raw: raw.to_string(),
        });
    }

    // B 站还有 /blanc/12345、/p/... 这类前缀，取最后一段纯房间号。
    let room_id = if platform == Platform::Bilibili {
        path.split(['/', '?', '#'])
            .filter(|segment| is_room_id(segment))
            .next_back()
            .unwrap_or("")
            .to_string()
    } else {
        first_segment
    };

    if !is_room_id(&room_id) {
        return Some(ParsedUrl {
            platform,
            room_id: String::new(),
            is_short_link: true,
            raw: raw.to_string(),
        });
    }

    Some(ParsedUrl {
        platform,
        room_id,
        is_short_link: false,
        raw: raw.to_string(),
    })
}

fn is_room_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析三站房间链接() {
        let bili = parse("https://live.bilibili.com/21452505").unwrap();
        assert_eq!(bili.platform, Platform::Bilibili);
        assert_eq!(bili.room_id, "21452505");

        let douyu = parse("https://www.douyu.com/9999").unwrap();
        assert_eq!(douyu.platform, Platform::Douyu);
        assert_eq!(douyu.room_id, "9999");

        let huya = parse("https://www.huya.com/998?foo=1").unwrap();
        assert_eq!(huya.platform, Platform::Huya);
        assert_eq!(huya.room_id, "998");
    }

    #[test]
    fn 省略协议头也能解析() {
        let parsed = parse("live.bilibili.com/6").unwrap();
        assert_eq!(parsed.platform, Platform::Bilibili);
        assert_eq!(parsed.room_id, "6");
    }

    #[test]
    fn 短链被标记出来() {
        let parsed = parse("https://b23.tv/abcDEF").unwrap();
        assert!(parsed.is_short_link);
        assert_eq!(parsed.platform, Platform::Bilibili);
    }

    #[test]
    fn 非直播站点返回空() {
        assert!(parse("https://example.com/123").is_none());
        assert!(parse("hello").is_none());
        assert!(parse("").is_none());
    }

    #[test]
    fn 裸房间号不算链接() {
        assert!(parse("21452505").is_none());
    }
}
