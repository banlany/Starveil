//! 小工具：JSON 取值、HTML 清洗、数字解析。

use serde_json::Value;
use std::sync::OnceLock;

/// 按 `a.b.c` 路径取 JSON 节点。
pub(crate) fn dig<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut node = root;
    for key in path.split('.') {
        if key.is_empty() {
            continue;
        }
        match node {
            Value::Object(map) => node = map.get(key)?,
            Value::Array(list) => {
                let index: usize = key.parse().ok()?;
                node = list.get(index)?;
            }
            _ => return None,
        }
    }
    Some(node)
}

/// 按路径取字符串；数字会自动转成字符串（平台经常把房间号当数字返回）。
pub(crate) fn text(root: &Value, path: &str) -> Option<String> {
    match dig(root, path)? {
        Value::String(v) => Some(v.clone()),
        Value::Number(v) => Some(v.to_string()),
        Value::Bool(v) => Some(v.to_string()),
        _ => None,
    }
}


pub(crate) fn u64_of(root: &Value, path: &str) -> u64 {
    match dig(root, path) {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| number.as_f64().map(|value| value.max(0.0) as u64))
            .unwrap_or(0),
        Some(Value::String(value)) => value.trim().parse().unwrap_or(0),
        Some(Value::Bool(value)) => u64::from(*value),
        _ => 0,
    }
}

pub(crate) fn u32_of(root: &Value, path: &str) -> u32 {
    u64_of(root, path).min(u32::MAX as u64) as u32
}

/// 斗鱼搜索的 `hot` 字段形如 `12.3万`，需要换算。
pub(crate) fn hot_count(raw: &str) -> u64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let (number, scale) = match trimmed.strip_suffix('万') {
        Some(rest) => (rest, 10_000.0),
        None => (trimmed, 1.0),
    };
    match number.parse::<f64>() {
        Ok(value) if value >= 0.0 => (value * scale).round() as u64,
        _ => 0,
    }
}

fn tag_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"<[^>]*>").expect("合法的标签正则"))
}

/// 去掉 HTML 标签（B 站与虎牙的简介常带 `<div>` / `<br>`）。
pub(crate) fn strip_tags(input: &str) -> String {
    let without_tags = tag_regex().replace_all(input, " ");
    let unescaped = decode_entities(&without_tags);
    unescaped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 只处理协议层常见的几个实体，不引入完整 HTML5 实体表。
pub(crate) fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find(';').filter(|end| *end <= 10);
        match end {
            Some(end) => {
                let entity = &tail[1..end];
                let decoded = match entity {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => entity
                        .strip_prefix("#x")
                        .or_else(|| entity.strip_prefix("#X"))
                        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                        .or_else(|| {
                            entity
                                .strip_prefix('#')
                                .and_then(|dec| dec.parse::<u32>().ok())
                        })
                        .and_then(char::from_u32),
                };
                match decoded {
                    Some(ch) => {
                        out.push(ch);
                        rest = &tail[end + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = &tail[1..];
                    }
                }
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// 补齐协议相对地址：B 站会给 `//i0.hdslb.com/...`。
pub(crate) fn absolute(url: &str) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    if url.starts_with("//") {
        format!("https:{url}")
    } else {
        url.to_string()
    }
}

pub(crate) fn md5_hex(input: &str) -> String {
    format!("{:x}", md5::compute(input.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按路径取嵌套字段() {
        let value: Value = serde_json::json!({
            "data": { "room": { "title": "标题", "id": 123 } }
        });
        assert_eq!(text(&value, "data.room.title").as_deref(), Some("标题"));
        assert_eq!(text(&value, "data.room.id").as_deref(), Some("123"));
        assert_eq!(text(&value, "data.missing.title"), None);
    }

    #[test]
    fn 数组下标也能取() {
        let value: Value = serde_json::json!({ "list": [{ "a": 1 }, { "a": 2 }] });
        assert_eq!(u64_of(&value, "list.1.a"), 2);
    }

    #[test]
    fn 热度带万要换算() {
        assert_eq!(hot_count("12.3万"), 123_000);
        assert_eq!(hot_count("520"), 520);
        assert_eq!(hot_count(""), 0);
        assert_eq!(hot_count("炸了"), 0);
    }

    #[test]
    fn 去标签并还原实体() {
        assert_eq!(strip_tags("<div>你好<br/>世界</div>"), "你好 世界");
        assert_eq!(decode_entities("a&amp;b&#39;c"), "a&b'c");
    }
}
