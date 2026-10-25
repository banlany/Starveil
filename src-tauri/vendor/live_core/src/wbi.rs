//! B 站 wbi 签名。
//!
//! 算法：`mixin_key = 打乱后的 (img_key + sub_key)[0..32]`，
//! 参数按 key 排序拼成 query 后 `w_rid = md5(query + mixin_key)`。

use crate::error::LiveError;
use crate::util::md5_hex;
use serde_json::Value;
use std::collections::BTreeMap;

/// 与 Dart 版 `mixinKeyEncTab` 完全一致的置换表。
const MIXIN_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// 从 `nav` 接口的 `data.wbi_img` 派生出的混淆密钥。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WbiKeys {
    mixin_key: String,
}

impl WbiKeys {
    /// 解析 `https://api.bilibili.com/x/web-interface/nav` 的响应。
    /// 未登录时 `code = -101`，但 `data.wbi_img` 仍然有效。
    pub fn from_nav(nav: &Value) -> Result<Self, LiveError> {
        let img = nav
            .pointer("/data/wbi_img/img_url")
            .and_then(Value::as_str)
            .ok_or_else(|| LiveError::protocol("nav 响应缺少 data.wbi_img.img_url"))?;
        let sub = nav
            .pointer("/data/wbi_img/sub_url")
            .and_then(Value::as_str)
            .ok_or_else(|| LiveError::protocol("nav 响应缺少 data.wbi_img.sub_url"))?;
        Ok(Self::from_urls(img, sub))
    }

    pub fn from_urls(img_url: &str, sub_url: &str) -> Self {
        let img_key = file_stem(img_url);
        let sub_key = file_stem(sub_url);
        let origin = format!("{img_key}{sub_key}");
        let mixin_key = MIXIN_TAB
            .iter()
            .map(|index| origin.as_bytes().get(*index).copied().unwrap_or(b'0'))
            .map(char::from)
            .take(32)
            .collect::<String>();
        Self { mixin_key }
    }

    pub fn mixin_key(&self) -> &str {
        &self.mixin_key
    }

    /// 给参数签名，返回可直接拼到 URL 后面的完整查询串（含 `wts` 与 `w_rid`）。
    pub fn sign(&self, params: &BTreeMap<String, String>, timestamp: u64) -> String {
        let mut params = params.clone();
        params.insert("wts".to_string(), timestamp.to_string());

        let mut serializer = form_urlencoded::Serializer::new(String::new());
        for (key, value) in &params {
            // B 站要求剔除这五个字符，否则签名校验不过。
            let cleaned: String = value
                .chars()
                .filter(|ch| !matches!(ch, '!' | '\'' | '(' | ')' | '*'))
                .collect();
            serializer.append_pair(key, &cleaned);
        }
        let query = serializer.finish();
        let w_rid = md5_hex(&format!("{query}{}", self.mixin_key));
        format!("{query}&w_rid={w_rid}")
    }
}

fn file_stem(url: &str) -> String {
    let last = url.rsplit('/').next().unwrap_or(url);
    last.split('.').next().unwrap_or(last).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 置换表产出32位密钥() {
        let keys = WbiKeys::from_urls(
            "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
        );
        assert_eq!(keys.mixin_key().len(), 32);
    }

    #[test]
    fn 签名串包含时间戳与w_rid() {
        let keys = WbiKeys::from_urls(
            "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
            "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
        );
        let mut params = BTreeMap::new();
        params.insert("room_id".to_string(), "21452505".to_string());
        let query = keys.sign(&params, 1_700_000_000);
        assert!(query.starts_with("room_id=21452505&wts=1700000000"));
        assert!(query.contains("&w_rid="));
        assert_eq!(query.split("&w_rid=").nth(1).unwrap().len(), 32);
    }

    #[test]
    fn 值里的特殊字符被剔除() {
        let keys = WbiKeys::from_urls("a.png", "b.png");
        let mut params = BTreeMap::new();
        params.insert("kw".to_string(), "a!b'c(d)e*f".to_string());
        let query = keys.sign(&params, 1);
        assert!(query.starts_with("kw=abcdef"));
    }
}
