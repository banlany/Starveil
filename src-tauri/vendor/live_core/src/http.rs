//! HTTP 会话：统一超时、UA、Cookie 与错误归类。

use crate::error::LiveError;
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::time::Duration;

/// 桌面 Chrome UA。三个平台对移动/桌面 UA 的返回差异很大，
/// 默认值只在站点没有显式指定时使用。
pub const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// 一次抓取会话。`Clone` 只是共享同一个连接池。
#[derive(Clone)]
pub struct HttpSession {
    client: Client,
    cookie: Option<String>,
}

impl Default for HttpSession {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpSession {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(DEFAULT_UA)
            .build()
            .expect("HTTP 客户端初始化失败");
        Self {
            client,
            cookie: None,
        }
    }

    /// 手动指定 Cookie（登录态或固定 buvid）。
    pub fn with_cookie(mut self, cookie: impl Into<String>) -> Self {
        let cookie = cookie.into();
        self.cookie = if cookie.trim().is_empty() {
            None
        } else {
            Some(cookie)
        };
        self
    }

    pub fn cookie(&self) -> Option<&str> {
        self.cookie.as_deref()
    }

    fn headers(&self, extra: &[(&str, &str)]) -> Result<HeaderMap, LiveError> {
        let mut map = HeaderMap::new();
        for (key, value) in extra {
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| LiveError::parse(format!("非法请求头名：{key}")))?;
            let value = HeaderValue::from_str(value)
                .map_err(|_| LiveError::parse(format!("非法请求头值：{value}")))?;
            map.insert(name, value);
        }
        if !map.contains_key("cookie")
            && let Some(cookie) = &self.cookie
        {
            let value = HeaderValue::from_str(cookie)
                .map_err(|_| LiveError::parse("Cookie 含非法字符"))?;
            map.insert("cookie", value);
        }
        Ok(map)
    }

    fn send(&self, request: RequestBuilder) -> Result<Response, LiveError> {
        let response = request.send()?;
        let status = response.status();
        if status.as_u16() == 403 || status.as_u16() == 412 {
            return Err(LiveError::RiskControl(format!("HTTP {}", status.as_u16())));
        }
        if status.is_server_error() {
            return Err(LiveError::Network(format!("服务端返回 HTTP {}", status.as_u16())));
        }
        Ok(response)
    }

    fn decode(response: Response, url: &str) -> Result<Value, LiveError> {
        // reqwest 没有启用 gzip feature 时不会自动解压；虎牙会无视
        // Accept-Encoding 直接返回 gzip 字节，这里兜底识别一次。
        let raw = response.bytes()?;
        let bytes = if raw.starts_with(&[0x1f, 0x8b]) {
            use std::io::Read;
            let mut out = Vec::new();
            let mut decoder = flate2::read::GzDecoder::new(&raw[..]);
            if decoder.read_to_end(&mut out).is_ok() {
                out
            } else {
                raw.to_vec()
            }
        } else {
            raw.to_vec()
        };
        let body = String::from_utf8_lossy(&bytes);
        serde_json::from_str(&body).map_err(|error| {
            let preview: String = body.chars().take(120).collect();
            LiveError::parse(format!("{url} 返回的不是 JSON（{error}）：{preview}"))
        })
    }

    /// GET + 查询参数。
    pub fn get_json(
        &self,
        url: &str,
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<Value, LiveError> {
        let request = self
            .client
            .get(url)
            .query(query)
            .headers(self.headers(headers)?);
        let response = self.send(request)?;
        Self::decode(response, url)
    }

    /// GET + 查询参数，同时保留响应头（B 站扫码登录需要读取 Set-Cookie）。
    pub fn get_json_with_headers(
        &self,
        url: &str,
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<(Value, HeaderMap), LiveError> {
        let request = self
            .client
            .get(url)
            .query(query)
            .headers(self.headers(headers)?);
        let response = self.send(request)?;
        let response_headers = response.headers().clone();
        let value = Self::decode(response, url)?;
        Ok((value, response_headers))
    }

    /// GET，URL 已自带查询串（wbi 签名要求签名串与发送串完全一致）。
    pub fn get_json_raw(
        &self,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<Value, LiveError> {
        let request = self.client.get(url).headers(self.headers(headers)?);
        let response = self.send(request)?;
        Self::decode(response, url)
    }

    pub fn get_text(
        &self,
        url: &str,
        query: &[(&str, &str)],
        headers: &[(&str, &str)],
    ) -> Result<String, LiveError> {
        let request = self
            .client
            .get(url)
            .query(query)
            .headers(self.headers(headers)?);
        let response = self.send(request)?;
        Ok(response.text()?)
    }

    /// POST 表单（斗鱼 `getH5Play` 走这个）。
    pub fn post_form(
        &self,
        url: &str,
        form: &[(&str, String)],
        headers: &[(&str, &str)],
    ) -> Result<Value, LiveError> {
        let request = self
            .client
            .post(url)
            .form(form)
            .headers(self.headers(headers)?);
        let response = self.send(request)?;
        Self::decode(response, url)
    }

    /// POST 一段已经拼好的表单串（签名必须原样发送，不能被重新编码）。
    pub fn post_form_raw(
        &self,
        url: &str,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<Value, LiveError> {
        let request = self
            .client
            .post(url)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body.to_string())
            .headers(self.headers(headers)?);
        let response = self.send(request)?;
        Self::decode(response, url)
    }
}

/// 给 JSON 里的 `code` 字段做风控归类（B 站用 -352/-412，虎牙用 status）。
pub(crate) fn check_code(value: &Value, url: &str) -> Result<(), LiveError> {
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code == 0 {
        return Ok(());
    }
    let message = value
        .get("message")
        .or_else(|| value.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if code == -352 || code == -412 {
        return Err(LiveError::RiskControl(format!(
            "{url} code={code} {message}"
        )));
    }
    Err(LiveError::protocol(format!(
        "{url} code={code} {message}"
    )))
}
