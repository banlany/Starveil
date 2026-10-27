//! 极简 WebDAV 客户端：只做同步需要的四件事——探测、探测元信息、上传、下载。
//!
//! 为什么不用专门的 WebDAV crate：同步单元就是一个整包 JSON 文件，
//! `PUT` / `GET` / `PROPFIND(Depth: 0)` 三条请求足够，`reqwest` 本来就支持自定义方法，
//! 引入 crate 反而多一层抽象和编译时间。
//!
//! 认证统一走 Basic Auth（群晖、坚果云、Nextcloud 都支持）。
//! 局域网 NAS 常见自签证书，因此提供 `allow_insecure_tls` 开关，
//! 只在用户明确要求时放行，不做静默降级。

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::Method;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct WebdavInfo {
    /// 请求的完整地址，回显给前端便于核对
    pub url: String,
    /// HTTP 状态码；`test` 时 404 也算「服务器通、只是文件还没上传」
    pub status: u16,
    pub exists: bool,
    pub size: Option<u64>,
    /// 服务端返回的 Last-Modified / getlastmodified，原样透传
    pub modified: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WebdavDownload {
    // 把探测到的元信息摊平到顶层，前端拿到的是 {status,size,modified,content}
    #[serde(flatten)]
    pub info: WebdavInfo,
    pub content: String,
}

fn build_client(allow_insecure_tls: bool) -> Result<Client, String> {
    let builder = Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(allow_insecure_tls);
    builder.build().map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
}

fn join_error(url: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("连接 {url} 超时，检查地址是否可达、端口是否开放");
    }
    if error.is_connect() {
        return format!("无法连接 {url}：{error}");
    }
    format!("请求 {url} 失败：{error}")
}

/// 把状态码翻成人话：这些错误码在 WebDAV 上最常见的成因是固定的。
fn explain_status(status: u16, url: &str) -> String {
    match status {
        401 => "认证失败：用户名或密码不对（坚果云要用「应用密码」而不是登录密码）".to_string(),
        403 => "服务器拒绝访问：账号没有这个目录的读写权限".to_string(),
        404 => format!("路径不存在：{url}，检查路径与文件名是否正确"),
        405 => "服务器不允许这个方法：确认这是一个 WebDAV 地址（通常以 /dav/ 结尾）".to_string(),
        409 => "目标目录不存在：WebDAV 不会自动建中间目录，先在服务器上建好".to_string(),
        507 => "服务器空间不足".to_string(),
        other => format!("服务器返回 {other}"),
    }
}

fn headers_to_info(url: &str, status: u16, headers: &reqwest::header::HeaderMap) -> WebdavInfo {
    let size = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let modified = headers
        .get("last-modified")
        .or_else(|| headers.get("getlastmodified"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    WebdavInfo {
        url: url.to_string(),
        status,
        exists: (200..300).contains(&status),
        size,
        modified,
    }
}

/// 探测目标文件：存在则返回大小与修改时间，不存在返回 404（仍算「连接正常」）。
pub fn probe(
    url: &str,
    username: &str,
    password: &str,
    allow_insecure_tls: bool,
) -> Result<WebdavInfo, String> {
    let client = build_client(allow_insecure_tls)?;
    let request = client
        .request(Method::from_bytes(b"PROPFIND").map_err(|error| error.to_string())?, url)
        .basic_auth(username, Some(password))
        .header("Depth", "0")
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(
            r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#,
        );
    let response = request.send().map_err(|error| join_error(url, error))?;
    let status = response.status().as_u16();
    if status == 404 {
        // 服务器通、认证过，只是这个文件还没上传过——这是正常的首次同步状态。
        return Ok(WebdavInfo {
            url: url.to_string(),
            status,
            exists: false,
            size: None,
            modified: None,
        });
    }
    if !response.status().is_success() {
        return Err(explain_status(status, url));
    }
    // PROPFIND 返回的是 XML，Content-Length 是 XML 本身的长度，不是文件大小；
    // 只有 GET/PUT 的 Content-Length 才代表包体大小，这里置空避免误导。
    let headers = response.headers().clone();
    let mut info = headers_to_info(url, status, &headers);
    info.size = None;
    Ok(info)
}

/// 上传整包 JSON（覆盖同名文件）。
pub fn upload(
    url: &str,
    username: &str,
    password: &str,
    allow_insecure_tls: bool,
    content: &str,
) -> Result<WebdavInfo, String> {
    let client = build_client(allow_insecure_tls)?;
    let response = client
        .put(url)
        .basic_auth(username, Some(password))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(content.to_string())
        .send()
        .map_err(|error| join_error(url, error))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(explain_status(status, url));
    }
    let headers = response.headers().clone();
    let mut info = headers_to_info(url, status, &headers);
    if info.size.is_none() {
        info.size = Some(content.len() as u64);
    }
    Ok(info)
}

/// 下载整包 JSON，返回文本内容。
pub fn download(
    url: &str,
    username: &str,
    password: &str,
    allow_insecure_tls: bool,
) -> Result<WebdavDownload, String> {
    let client = build_client(allow_insecure_tls)?;
    let response = client
        .get(url)
        .basic_auth(username, Some(password))
        .send()
        .map_err(|error| join_error(url, error))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(explain_status(status, url));
    }
    let headers = response.headers().clone();
    let info = headers_to_info(url, status, &headers);
    let content = response.text().map_err(|error| format!("读取响应失败：{error}"))?;
    Ok(WebdavDownload { info, content })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_messages_are_actionable() {
        assert!(explain_status(401, "x").contains("认证失败"));
        assert!(explain_status(404, "x").contains("路径不存在"));
        assert!(explain_status(409, "x").contains("目录不存在"));
        assert_eq!(explain_status(500, "x"), "服务器返回 500");
    }

    #[test]
    fn info_reports_existence_by_status() {
        let headers = reqwest::header::HeaderMap::new();
        assert!(headers_to_info("u", 207, &headers).exists);
        assert!(!headers_to_info("u", 404, &headers).exists);
    }

    /// 起一个只会 PROPFIND / PUT / GET 的假 WebDAV，验证三条请求真的能跑通。
    /// 走的是真实 socket，能覆盖 reqwest 的方法、Basic Auth 头与包体编码。
    #[test]
    fn speaks_minimal_webdav() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};
        use std::thread;

        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口失败");
        let port = listener.local_addr().expect("读取端口失败").port();
        let stored = Arc::new(Mutex::new(String::new()));
        let writer = stored.clone();

        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("接受连接失败");
                // 按 Content-Length 读到完整请求，避免只拿到半截包体。
                let mut buffer: Vec<u8> = Vec::new();
                loop {
                    let mut chunk = [0u8; 1024];
                    let read = stream.read(&mut chunk).expect("读取失败");
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&buffer);
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let length = text[..head_end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if buffer.len() >= head_end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buffer).to_string();
                let first = request.lines().next().unwrap_or("").to_string();
                if first.starts_with("PROPFIND") {
                    let _ = stream.write_all(
                        b"HTTP/1.1 207 Multi-Status\r\nLast-Modified: Wed, 21 Oct 2026 07:28:00 GMT\r\nContent-Length: 0\r\n\r\n",
                    );
                } else if first.starts_with("PUT") {
                    let body = request.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                    *writer.lock().unwrap() = body;
                    let _ = stream.write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n");
                } else {
                    let body = writer.lock().unwrap().clone();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            }
        });

        let url = format!("http://127.0.0.1:{port}/starveil-sync.json");

        let info = probe(&url, "user", "pass", false).expect("PROPFIND 失败");
        assert!(info.exists);
        assert_eq!(info.modified.as_deref(), Some("Wed, 21 Oct 2026 07:28:00 GMT"));

        let uploaded = upload(&url, "user", "pass", false, r#"{"version":1}"#).expect("PUT 失败");
        assert_eq!(uploaded.status, 201);

        let downloaded = download(&url, "user", "pass", false).expect("GET 失败");
        assert_eq!(downloaded.content, r#"{"version":1}"#);
        assert_eq!(downloaded.info.status, 200);

        server.join().expect("服务线程异常");
    }
}
