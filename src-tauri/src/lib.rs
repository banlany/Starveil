//! Tauri 后端：把 `live_core` 的三站取流与弹幕包装成命令，界面全部交给 WebView2。
//!
//! 视频不再走 libmpv：前端用 mpegts.js 播 FLV，音频和渲染都由 WebView2 负责。
//!
//! 斗鱼比较特殊：清晰度和取流参数需要执行服务端下发的混淆 JS 签名。
//! 这里用 WebView 的 JS 引擎签名，再把参数回传给 Rust；斗鱼 CDN 还会校验
//! Referer，浏览器 fetch 不允许设置 Referer，因此额外起一个本机流代理。
//!
//! 桌面（Windows）与移动端（Android）共用这一份后端：入口是 [`run()`]，
//! `main.rs` 与 Tauri 的移动端桥接层都调它。平台差异（WebView2 数据目录、
//! GPU 沙箱、剪贴板、TLS 后端）都靠 `cfg` 分流，不做第二套实现。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use live_core::{
    DanmakuSession, HttpSession, LiveCore, LiveError, LiveRoomDetail, LiveRoomItem, Platform,
    PlayQuality, QualityData,
};
use live_core::model::RoomExtra;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

mod webdav;
mod win32;

const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BILIBILI_REFERER: &str = "https://www.bilibili.com/";

struct Session {
    detail: LiveRoomDetail,
    qualities: Vec<PlayQuality>,
    douyu_did: Option<String>,
}

struct DanmakuRuntime {
    stop: Arc<AtomicBool>,
}

#[derive(Clone)]
struct ProxyTarget {
    url: String,
    referer: String,
    user_agent: String,
}

struct AppState {
    /// 每个平台单独一个 LiveCore，避免把 B 站 Cookie 发给斗鱼/虎牙。
    cores: Mutex<HashMap<Platform, Arc<LiveCore>>>,
    cookies: Mutex<HashMap<String, String>>,
    sessions: Mutex<HashMap<String, Session>>,
    danmaku: Mutex<Option<DanmakuRuntime>>,
    proxy_port: u16,
    proxy_targets: Arc<Mutex<HashMap<String, ProxyTarget>>>,
}

impl AppState {
    fn core(&self, platform: Platform) -> Arc<LiveCore> {
        let cores = self.cores.lock().expect("平台核心锁失效");
        cores
            .get(&platform)
            .cloned()
            .expect("平台核心未初始化")
    }

    fn cookie(&self, platform: &str) -> String {
        self.cookies
            .lock()
            .ok()
            .and_then(|cookies| cookies.get(platform).cloned())
            .unwrap_or_default()
    }

    /// 只在阻塞线程里构造 LiveCore：reqwest 的 blocking Client 不能在
    /// 异步运行时线程上创建，否则会让后续命令卡住。
    fn store_cookie(&self, platform: Platform, cookie: String, core: Arc<LiveCore>) {
        let cookie = cookie.trim().to_string();
        if let Ok(mut cookies) = self.cookies.lock() {
            if cookie.is_empty() {
                cookies.remove(platform.id());
            } else {
                cookies.insert(platform.id().to_string(), cookie);
            }
        }
        if let Ok(mut cores) = self.cores.lock() {
            cores.insert(platform, core);
        }
    }
}

#[derive(Serialize)]
struct RoomPayload {
    key: String,
    detail: LiveRoomDetail,
    qualities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    douyu_script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    douyu_did: Option<String>,
}

#[derive(Serialize)]
struct PlayPayload {
    urls: Vec<String>,
    /// HLS（m3u8）线路，交给前端的 hls.js；为空表示没有 HLS 出口。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    hls_urls: Vec<String>,
    headers: Vec<(String, String)>,
}

#[derive(Serialize)]
struct ResolvedInput {
    platform: String,
    room_id: String,
    is_short_link: bool,
    raw: String,
}

#[derive(Serialize, Clone)]
struct AnchorItem {
    platform: String,
    room_id: String,
    user_name: String,
    avatar: String,
    live: bool,
    uid: String,
}

fn strip_em(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(other) => other.to_string().trim_matches('"').to_string(),
        None => String::new(),
    }
}

fn value_i64(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.parse().unwrap_or(0),
        Some(Value::Bool(flag)) => i64::from(*flag),
        _ => 0,
    }
}

fn value_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) != 0,
        Some(Value::String(text)) => text == "1" || text == "true",
        _ => false,
    }
}

fn bili_buvid() -> Option<(String, String)> {
    let http = HttpSession::new();
    let value = http
        .get_json(
            "https://api.bilibili.com/x/frontend/finger/spi",
            &[],
            &[("user-agent", DESKTOP_UA), ("referer", BILIBILI_REFERER)],
        )
        .ok()?;
    let data = value.get("data")?;
    let b3 = data.get("b_3").and_then(Value::as_str)?.to_string();
    let b4 = data.get("b_4").and_then(Value::as_str)?.to_string();
    Some((b3, b4))
}

#[tauri::command]
async fn search_anchors(
    state: State<'_, AppState>,
    platform: String,
    keyword: String,
    page: Option<u32>,
) -> Result<Vec<AnchorItem>, String> {
    let platform = parse_platform(&platform)?;
    let page = page.unwrap_or(1);
    let keyword = keyword.trim().to_string();
    if keyword.is_empty() {
        return Err("请输入主播昵称或 ID".to_string());
    }
    let cookie = state.cookie(platform.id());
    tauri::async_runtime::spawn_blocking(move || match platform {
        Platform::Bilibili => {
            let http = HttpSession::new();
            let mut cookie_header = cookie.trim().to_string();
            if let Some((b3, b4)) = bili_buvid() {
                if !cookie_header.is_empty() {
                    cookie_header.push_str("; ");
                }
                cookie_header.push_str(&format!("buvid3={b3}; buvid4={b4}"));
            }
            let value = http
                .get_json(
                    "https://api.bilibili.com/x/web-interface/search/type",
                    &[
                        ("context", ""),
                        ("search_type", "live_user"),
                        ("cover_type", "user_cover"),
                        ("order", ""),
                        ("keyword", keyword.as_str()),
                        ("category_id", ""),
                        ("__refresh__", ""),
                        ("_extra", ""),
                        ("highlight", "0"),
                        ("single_column", "0"),
                        ("page", &page.to_string()),
                    ],
                    &[
                        ("user-agent", DESKTOP_UA),
                        ("referer", "https://search.bilibili.com/"),
                        ("cookie", cookie_header.as_str()),
                    ],
                )
                .map_err(fail)?;
            let mut items = Vec::new();
            for item in value
                .get("data")
                .and_then(|data| data.get("result"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let room_id = value_text(item.get("roomid"));
                if room_id.is_empty() {
                    continue;
                }
                let user_name = strip_em(
                    item.get("uname")
                        .and_then(Value::as_str)
                        .unwrap_or("B 站主播"),
                );
                let avatar = item
                    .get("uface")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let avatar = if avatar.starts_with("//") {
                    format!("https:{avatar}@400w.jpg")
                } else if avatar.starts_with("http") && !avatar.contains('@') {
                    format!("{avatar}@400w.jpg")
                } else {
                    avatar
                };
                let uid = {
                    let text = value_text(item.get("uid"));
                    if text.is_empty() { room_id.clone() } else { text }
                };
                items.push(AnchorItem {
                    platform: platform.id().to_string(),
                    room_id,
                    user_name,
                    avatar,
                    live: value_bool(item.get("is_live")),
                    uid,
                });
            }
            // 主播 UID 不是 live_user 搜索的索引字段；纯数字时按 UID 反查直播间。
            if items.is_empty() && keyword.chars().all(|ch| ch.is_ascii_digit()) {
                let headers = [
                    ("user-agent", DESKTOP_UA),
                    ("referer", "https://space.bilibili.com/"),
                ];
                if let Ok(room) = http.get_json(
                    "https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld",
                    &[("mid", keyword.as_str())],
                    &headers,
                ) {
                    let room_id = value_text(room.get("data").and_then(|data| data.get("roomid")));
                    if !room_id.is_empty() && room_id != "0" {
                        let card = http
                            .get_json(
                                "https://api.bilibili.com/x/web-interface/card",
                                &[("mid", keyword.as_str())],
                                &headers,
                            )
                            .ok();
                        let user_name = card
                            .as_ref()
                            .and_then(|value| value.pointer("/data/card/name"))
                            .and_then(Value::as_str)
                            .unwrap_or("B 站主播")
                            .to_string();
                        let avatar = card
                            .as_ref()
                            .and_then(|value| value.pointer("/data/card/face"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let avatar = if avatar.starts_with("http") && !avatar.contains('@') {
                            format!("{avatar}@400w.jpg")
                        } else {
                            avatar
                        };
                        items.push(AnchorItem {
                            platform: platform.id().to_string(),
                            room_id,
                            user_name,
                            avatar,
                            live: value_i64(
                                room.get("data").and_then(|data| data.get("liveStatus")),
                            ) == 1,
                            uid: keyword.clone(),
                        });
                    }
                }
            }
            Ok(items)
        }
        Platform::Douyu => {
            let http = HttpSession::new();
            let value = http
                .get_json(
                    "https://www.douyu.com/japi/search/api/searchUser",
                    &[
                        ("kw", keyword.as_str()),
                        ("page", &page.to_string()),
                        ("pageSize", "20"),
                        ("filterType", "1"),
                    ],
                    &[
                        ("user-agent", DESKTOP_UA),
                        ("referer", "https://www.douyu.com/search/"),
                    ],
                )
                .map_err(fail)?;
            let mut items = Vec::new();
            for item in value
                .get("data")
                .and_then(|data| data.get("relateUser"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let anchor = item.get("anchorInfo").unwrap_or(&Value::Null);
                let room_id = value_text(anchor.get("rid"));
                if room_id.is_empty() {
                    continue;
                }
                let room_type = value_i64(anchor.get("roomType"));
                let live = value_i64(anchor.get("isLive")) == 1 && room_type == 0;
                items.push(AnchorItem {
                    platform: platform.id().to_string(),
                    room_id,
                    user_name: anchor
                        .get("nickName")
                        .and_then(Value::as_str)
                        .unwrap_or("斗鱼主播")
                        .to_string(),
                    avatar: anchor
                        .get("avatar")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    live,
                    uid: {
                        let uid = value_text(anchor.get("uid"));
                        if uid.is_empty() {
                            value_text(
                                anchor
                                    .get("algorithm")
                                    .and_then(|algorithm| algorithm.get("_to_uid")),
                            )
                        } else {
                            uid
                        }
                    },
                });
            }
            Ok(items)
        }
        Platform::Huya => {
            let http = HttpSession::new();
            let value = http
                .get_json(
                    "https://search.cdn.huya.com/",
                    &[
                        ("m", "Search"),
                        ("do", "getSearchContent"),
                        ("q", keyword.as_str()),
                        ("uid", "0"),
                        ("v", "1"),
                        ("typ", "-5"),
                        ("livestate", "0"),
                        ("rows", &page.saturating_mul(20).to_string()),
                        ("start", "0"),
                    ],
                    &[("user-agent", DESKTOP_UA)],
                )
                .map_err(fail)?;
            let mut items = Vec::new();
            for item in value
                .get("response")
                .and_then(|response| response.get("1"))
                .and_then(|data| data.get("docs"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
            {
                let room_id = value_text(item.get("room_id"));
                if room_id.is_empty() {
                    continue;
                }
                let uid = {
                    let text = value_text(item.get("uid"));
                    if text.is_empty() { room_id.clone() } else { text }
                };
                items.push(AnchorItem {
                    platform: platform.id().to_string(),
                    room_id,
                    user_name: item
                        .get("game_nick")
                        .and_then(Value::as_str)
                        .unwrap_or("虎牙主播")
                        .to_string(),
                    avatar: item
                        .get("game_avatarUrl180")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    live: value_bool(item.get("gameLiveOn")),
                    uid,
                });
            }
            Ok(items)
        }
        // 抖音/快手没有公开的主播搜索接口，关注页的「按昵称找主播」暂不适用。
        Platform::Douyin | Platform::Kuaishou => Err(format!(
            "{}暂不支持按昵称搜索主播，请直接粘贴直播间链接",
            platform.name()
        )),
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))?
}

#[derive(Serialize, Clone)]
struct LoginUser {
    logged_in: bool,
    name: String,
    avatar: String,
    uid: String,
    message: String,
}

#[derive(Serialize)]
struct QrPayload {
    url: String,
    key: String,
}

#[derive(Serialize)]
struct QrPollResult {
    status: String,
    message: String,
    cookie: Option<String>,
    user: Option<LoginUser>,
}

fn parse_platform(id: &str) -> Result<Platform, String> {
    Platform::from_id(id).ok_or_else(|| format!("未知平台：{id}"))
}

fn fail(error: LiveError) -> String {
    error.to_string()
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, LiveError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("任务执行失败：{error}"))?
        .map_err(fail)
}

// ---------------------------------------------------------------- 斗鱼

fn douyu_cookie(did: &str, login: &str) -> String {
    if login.trim().is_empty() {
        format!("dy_did={did}; acf_did={did}")
    } else {
        format!("{}; dy_did={did}; acf_did={did}", login.trim())
    }
}

fn douyu_referer(room_id: &str) -> String {
    format!("https://www.douyu.com/{room_id}")
}

fn douyu_script(room_id: &str, did: &str, login: &str) -> Result<String, String> {
    let http = HttpSession::new();
    let cookie = douyu_cookie(did, login);
    let referer = douyu_referer(room_id);
    let value = http
        .get_json(
            "https://www.douyu.com/swf_api/homeH5Enc",
            &[("rids", room_id)],
            &[
                ("user-agent", DESKTOP_UA),
                ("referer", referer.as_str()),
                ("cookie", cookie.as_str()),
            ],
        )
        .map_err(fail)?;
    let key = format!("room{room_id}");
    let script = value
        .get("data")
        .and_then(|data| data.get(key.as_str()))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if script.is_empty() {
        return Err("斗鱼没有下发取流签名脚本".to_string());
    }
    Ok(script)
}

fn douyu_post(room_id: &str, did: &str, login: &str, body: &str) -> Result<Value, String> {
    let http = HttpSession::new();
    let cookie = douyu_cookie(did, login);
    let referer = douyu_referer(room_id);
    http.post_form_raw(
        &format!("https://www.douyu.com/lapi/live/getH5Play/{room_id}"),
        body,
        &[
            ("user-agent", DESKTOP_UA),
            ("referer", referer.as_str()),
            ("cookie", cookie.as_str()),
        ],
    )
    .map_err(fail)
}

fn check_douyu(value: &Value) -> Result<(), String> {
    let error = value.get("error").and_then(Value::as_i64).unwrap_or(0);
    if error != 0 {
        let message = value
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("斗鱼接口返回错误 {error}：{message}"));
    }
    Ok(())
}

fn unescape_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// 代理出错时打印的 URL 片段。完整直链带签名且很长，日志里只留主机与路径开头。
fn preview(url: &str) -> String {
    let cut = url.find(['?', '#']).unwrap_or(url.len());
    let base = &url[..cut];
    if base.len() > 90 {
        format!("{}…", &base[..90])
    } else {
        base.to_string()
    }
}

/// 代理并发上限。每条连接一个线程，卡死的连接会一直占着线程不放，
/// 这里加个闸：超了直接 503，让播放器立刻走换线，别把进程拖垮。
const PROXY_MAX_CONNECTIONS: usize = 32;

/// 上游只建一次客户端。原先每条连接都 `Client::builder().build()`，
/// 连接池和内部 runtime 全重建一遍，卡死的连接越多浪费越大。
///
/// 注意这里**不能**用 `read_timeout`（blocking 版没有），也不能用 `.timeout()`——
/// 那是整个请求的总超时，会把正常的长连接直播流拦腰砍断。上游真的挂死时
/// 靠的是前端 stall 检测换线 → 浏览器关掉旧连接 → 我们写 socket 失败退出。
fn upstream_client() -> Option<reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .build()
                .ok()
        })
        .clone()
}

fn start_proxy() -> (u16, Arc<Mutex<HashMap<String, ProxyTarget>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("启动本地流代理失败");
    let port = listener.local_addr().expect("读取代理端口失败").port();
    let targets = Arc::new(Mutex::new(HashMap::new()));
    let shared = targets.clone();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            // 以前用 `incoming().flatten()` 把 accept 错误整个吞掉：句柄耗尽
            // 之类的持续错误会让这里满核空转，日志里还一个字都没有。
            let stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    eprintln!("[proxy] accept 失败：{error}");
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };
            if active.load(Ordering::Relaxed) >= PROXY_MAX_CONNECTIONS {
                let mut socket = stream;
                let _ = write!(
                    socket,
                    "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
                );
                continue;
            }
            let targets = shared.clone();
            let active = active.clone();
            active.fetch_add(1, Ordering::Relaxed);
            std::thread::spawn(move || {
                proxy_connection(stream, targets);
                active.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });
    (port, targets)
}

fn proxy_connection(stream: TcpStream, targets: Arc<Mutex<HashMap<String, ProxyTarget>>>) {
    let _ = stream.set_nodelay(true);
    // 半开连接（浏览器崩溃、睡眠唤醒、预连接）会让读请求头永久阻塞。
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    // 浏览器不再读数据时（切线路、关房间、MSE 卡死），写方向也要能退出来。
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let Ok(clone) = stream.try_clone() else { return };
    let mut reader = BufReader::new(clone);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) => break,
            Ok(_) if header.trim().is_empty() => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }

    let mut socket = stream;
    let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n";
    if method == "OPTIONS" {
        let _ = write!(
            socket,
            "HTTP/1.1 204 No Content\r\n{cors}Access-Control-Max-Age: 86400\r\nConnection: close\r\n\r\n"
        );
        return;
    }
    let token = path
        .strip_prefix("/stream/")
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    let target = targets
        .lock()
        .ok()
        .and_then(|map| map.get(token).cloned());
    let Some(target) = target else {
        eprintln!("[proxy] 未知 token：{}", preview(path));
        let _ = write!(
            socket,
            "HTTP/1.1 404 Not Found\r\n{cors}Connection: close\r\nContent-Length: 0\r\n\r\n"
        );
        return;
    };

    let Some(client) = upstream_client() else {
        let _ = write!(
            socket,
            "HTTP/1.1 502 Bad Gateway\r\n{cors}Connection: close\r\nContent-Length: 0\r\n\r\n"
        );
        return;
    };
    let fetch = || {
        client
            .get(&target.url)
            .header("referer", &target.referer)
            .header("user-agent", &target.user_agent)
            .send()
    };
    // 抖音/快手 CDN 偶发 403：签名刚下发、同一路流被并发拉取时都会这样，
    // 停 300ms 再要一次多半就正常了。只重试一次，别把「真的拉不到」拖成卡顿。
    let mut response = fetch();
    if !matches!(&response, Ok(response) if response.status().is_success()) {
        std::thread::sleep(Duration::from_millis(300));
        response = fetch();
    }
    let mut response = match response {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            eprintln!(
                "[proxy] 上游 HTTP {} ← {}\n        目标 {}\n        referer {}",
                response.status().as_u16(),
                preview(&target.url),
                target.url,
                target.referer
            );
            let _ = write!(
                socket,
                "HTTP/1.1 502 Bad Gateway\r\n{cors}Connection: close\r\nContent-Length: 0\r\n\r\n"
            );
            return;
        }
        Err(error) => {
            eprintln!("[proxy] 上游请求失败 ← {}：{error}", preview(&target.url));
            let _ = write!(
                socket,
                "HTTP/1.1 502 Bad Gateway\r\n{cors}Connection: close\r\nContent-Length: 0\r\n\r\n"
            );
            return;
        }
    };

    if write!(
        socket,
        "HTTP/1.1 200 OK\r\n{cors}Content-Type: video/x-flv\r\nCache-Control: no-cache, no-store\r\nConnection: close\r\n\r\n"
    )
    .is_err()
    {
        return;
    }
    // 响应头已经发完，后面只写不读，读超时没有意义。
    let _ = socket.set_read_timeout(None);
    // 手动搬数据而不是 `std::io::copy`：写失败要立刻退出。
    // 否则浏览器切线路/关房间后，这条线程还会卡在 write 上，
    // 上游连接也一直挂着，长时间挂机线程数只增不减。
    let mut buffer = vec![0u8; 32 * 1024];
    loop {
        match response.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if socket.write_all(&buffer[..count]).is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    let _ = socket.flush();
}

// ---------------------------------------------------------------- 基础数据

#[tauri::command]
async fn recommend(
    state: State<'_, AppState>,
    platform: String,
    page: Option<u32>,
) -> Result<Vec<LiveRoomItem>, String> {
    let platform = parse_platform(&platform)?;
    let core = state.core(platform);
    blocking(move || core.recommend(platform, page.unwrap_or(1))).await
}

#[tauri::command]
async fn search(
    state: State<'_, AppState>,
    platform: String,
    keyword: String,
) -> Result<Vec<LiveRoomItem>, String> {
    let platform = parse_platform(&platform)?;
    let core = state.core(platform);
    blocking(move || core.search(platform, &keyword)).await
}

#[tauri::command]
async fn categories(
    state: State<'_, AppState>,
    platform: String,
) -> Result<Vec<live_core::LiveCategory>, String> {
    let platform = parse_platform(&platform)?;
    let core = state.core(platform);
    blocking(move || core.categories(platform)).await
}

#[tauri::command]
async fn category_rooms(
    state: State<'_, AppState>,
    platform: String,
    parent_id: String,
    sub_id: String,
    name: String,
    page: Option<u32>,
) -> Result<Vec<LiveRoomItem>, String> {
    let platform = parse_platform(&platform)?;
    let category = live_core::LiveSubCategory {
        id: sub_id,
        name,
        parent_id,
        pic: String::new(),
    };
    let core = state.core(platform);
    blocking(move || core.category_rooms(platform, &category, page.unwrap_or(1))).await
}

#[tauri::command]
fn resolve_input(current: String, input: String) -> Result<ResolvedInput, String> {
    let current = parse_platform(&current)?;
    let value = input.trim();
    if value.is_empty() {
        return Err("请先填写房间号或直播间链接".to_string());
    }
    if let Some(parsed) = live_core::url_parser::parse(value) {
        return Ok(ResolvedInput {
            platform: parsed.platform.id().to_string(),
            room_id: parsed.room_id,
            is_short_link: parsed.is_short_link,
            raw: parsed.raw,
        });
    }
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Ok(ResolvedInput {
            platform: current.id().to_string(),
            room_id: value.to_string(),
            is_short_link: false,
            raw: value.to_string(),
        });
    }
    Err(format!("无法识别的房间号或链接：{value}"))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------- 直播间

#[tauri::command]
async fn open_room(
    state: State<'_, AppState>,
    platform: String,
    room_id: String,
) -> Result<RoomPayload, String> {
    let platform = parse_platform(&platform)?;
    let core = state.core(platform);
    let login_cookie = state.cookie(platform.id());
    let requested = room_id.clone();

    let (detail, qualities, script, did) = tauri::async_runtime::spawn_blocking(move || {
        let detail = core.detail(platform, &requested).map_err(fail)?;
        if platform == Platform::Douyu {
            let did = live_core::douyu_sign::device_id();
            // 未开播时取流脚本可能也拿不到，但房间详情/关注仍应可用。
            let script = if detail.live {
                douyu_script(&detail.room_id, &did, &login_cookie).ok()
            } else {
                None
            };
            Ok::<_, String>((detail, Vec::new(), script, Some(did)))
        } else {
            let qualities = match core.qualities(&detail) {
                Ok(qualities) => qualities,
                Err(_) if !detail.live => Vec::new(),
                Err(error) => return Err(fail(error)),
            };
            Ok::<_, String>((detail, qualities, None, None))
        }
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))??;

    let key = format!("{}:{}", detail.platform.id(), detail.room_id);
    let names = qualities.iter().map(|quality| quality.name.clone()).collect();
    let payload = RoomPayload {
        key: key.clone(),
        detail: detail.clone(),
        qualities: names,
        douyu_script: script,
        douyu_did: did.clone(),
    };
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.insert(
            key,
            Session {
                detail,
                qualities,
                douyu_did: did,
            },
        );
    }
    Ok(payload)
}

#[tauri::command]
async fn douyu_qualities(
    state: State<'_, AppState>,
    key: String,
    signed_args: String,
) -> Result<Vec<String>, String> {
    let (room_id, did) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "会话锁失效".to_string())?;
        let session = sessions
            .get(&key)
            .ok_or_else(|| "房间会话已失效，请重新进房".to_string())?;
        (
            session.detail.room_id.clone(),
            session
                .douyu_did
                .clone()
                .ok_or_else(|| "斗鱼会话缺少设备号".to_string())?,
        )
    };
    let login_cookie = state.cookie("douyu");

    let (names, qualities) = tauri::async_runtime::spawn_blocking(move || {
        let body = format!(
            "{signed_args}&cdn=&rate=-1&ver=Douyu_223061205&iar=1&ive=1&hevc=0&fa=0"
        );
        let value = douyu_post(&room_id, &did, &login_cookie, &body)?;
        check_douyu(&value)?;
        let data = value
            .get("data")
            .ok_or_else(|| "斗鱼返回了无效的播放质量".to_string())?;
        let mut cdns = data
            .get("cdnsWithName")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("cdn").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        cdns.sort_by_key(|cdn| cdn.starts_with("scdn"));
        let rates = data
            .get("multirates")
            .and_then(Value::as_array)
            .ok_or_else(|| "斗鱼返回了无效的清晰度列表".to_string())?;
        if rates.is_empty() {
            return Err("斗鱼没有可用的清晰度".to_string());
        }
        let mut qualities = Vec::with_capacity(rates.len());
        for item in rates {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("清晰度")
                .to_string();
            let rate = item.get("rate").and_then(Value::as_u64).unwrap_or(0) as u32;
            qualities.push(PlayQuality {
                name,
                data: QualityData::Douyu {
                    rate,
                    cdns: cdns.clone(),
                },
            });
        }
        let names = qualities.iter().map(|quality| quality.name.clone()).collect();
        Ok::<_, String>((names, qualities))
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))??;

    if let Ok(mut sessions) = state.sessions.lock()
        && let Some(session) = sessions.get_mut(&key)
    {
        session.qualities = qualities;
    }
    Ok(names)
}

#[tauri::command]
async fn douyu_play(
    state: State<'_, AppState>,
    key: String,
    index: usize,
    signed_args: String,
) -> Result<PlayPayload, String> {
    let (detail, quality, did) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "会话锁失效".to_string())?;
        let session = sessions
            .get(&key)
            .ok_or_else(|| "房间会话已失效，请重新进房".to_string())?;
        let quality = session
            .qualities
            .get(index)
            .ok_or_else(|| "清晰度不存在，请重新进房".to_string())?
            .clone();
        (
            session.detail.clone(),
            quality,
            session
                .douyu_did
                .clone()
                .ok_or_else(|| "斗鱼会话缺少设备号".to_string())?,
        )
    };
    let QualityData::Douyu { rate, cdns } = quality.data else {
        return Err("清晰度句柄与平台不匹配".to_string());
    };
    let login_cookie = state.cookie("douyu");
    let room_id = detail.room_id.clone();
    let urls = tauri::async_runtime::spawn_blocking(move || {
        let mut urls = Vec::new();
        let mut last_error = String::new();
        for cdn in cdns {
            let body = format!("{signed_args}&cdn={cdn}&rate={rate}");
            match douyu_post(&room_id, &did, &login_cookie, &body) {
                Ok(value) => {
                    if let Err(error) = check_douyu(&value) {
                        last_error = error;
                        continue;
                    }
                    let Some(data) = value.get("data") else {
                        last_error = "斗鱼返回了无效的播放地址".to_string();
                        continue;
                    };
                    let Some(rtmp_url) = data.get("rtmp_url").and_then(Value::as_str) else {
                        last_error = "斗鱼播放地址缺少 rtmp_url".to_string();
                        continue;
                    };
                    let Some(rtmp_live) = data.get("rtmp_live").and_then(Value::as_str) else {
                        last_error = "斗鱼播放地址缺少 rtmp_live".to_string();
                        continue;
                    };
                    let mut url = format!(
                        "{}/{}",
                        rtmp_url.trim_end_matches('/'),
                        unescape_html(rtmp_live)
                    );
                    if url.contains("expire=300") && url.contains("fcdn=ws") {
                        url.push_str("&expire=0");
                    }
                    urls.push(url);
                }
                Err(error) => last_error = error,
            }
        }
        if urls.is_empty() {
            return Err(if last_error.is_empty() {
                "斗鱼没有可用的播放地址".to_string()
            } else {
                last_error
            });
        }
        Ok::<_, String>(urls)
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))??;

    let referer = format!("https://www.douyu.com/{}", detail.room_id);
    let mut proxy_urls = Vec::with_capacity(urls.len());
    // 锁中毒（持锁线程 panic）时用 into_inner 继续：这里如果直接跳过，
    // 所有平台的播放都会返回空地址列表，界面只显示「没有可用的播放地址」，
    // 真实原因（代理表不可用）完全看不到。
    let mut targets = match state.proxy_targets.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    {
        for (line, url) in urls.into_iter().enumerate() {
            let token = format!("{}-{}-{line}", key.replace(':', "_"), index);
            targets.insert(
                token.clone(),
                ProxyTarget {
                    url,
                    referer: referer.clone(),
                    user_agent: DESKTOP_UA.to_string(),
                },
            );
            proxy_urls.push(format!(
                "http://127.0.0.1:{}/stream/{token}",
                state.proxy_port
            ));
        }
    }
    Ok(PlayPayload {
        urls: proxy_urls,
        hls_urls: Vec::new(),
        headers: Vec::new(),
    })
}

/// 所有平台的 FLV 都走本机代理：B 站/虎牙部分 CDN 不返回 CORS 头，
/// 浏览器直连会在预检或 Referer 上失败，表现为“只有某一条线路能播”。
fn proxy_play_urls(
    state: &AppState,
    key: &str,
    index: usize,
    urls: Vec<String>,
    referer: String,
) -> Vec<String> {
    let mut proxied = Vec::with_capacity(urls.len());
    // 锁中毒（持锁线程 panic）时用 into_inner 继续：这里如果直接跳过，
    // 所有平台的播放都会返回空地址列表，界面只显示「没有可用的播放地址」，
    // 真实原因（代理表不可用）完全看不到。
    let mut targets = match state.proxy_targets.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    {
        for (line, url) in urls.into_iter().enumerate() {
            let token = format!("{}-{}-{line}", key.replace(':', "_"), index);
            targets.insert(
                token.clone(),
                ProxyTarget {
                    url,
                    referer: referer.clone(),
                    user_agent: DESKTOP_UA.to_string(),
                },
            );
            proxied.push(format!(
                "http://127.0.0.1:{}/stream/{token}",
                state.proxy_port
            ));
        }
    }
    proxied
}

#[tauri::command]
async fn play(
    state: State<'_, AppState>,
    key: String,
    index: usize,
) -> Result<PlayPayload, String> {
    let (detail, quality) = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "会话锁失效".to_string())?;
        let session = sessions
            .get(&key)
            .ok_or_else(|| "房间会话已失效，请重新进房".to_string())?;
        let quality = session
            .qualities
            .get(index)
            .ok_or_else(|| "清晰度不存在".to_string())?
            .clone();
        (session.detail.clone(), quality)
    };

    let platform = detail.platform;
    let room_id = detail.room_id.clone();
    let core = state.core(platform);
    let play = blocking(move || core.play(&detail, &quality)).await?;
    let mut hls_urls = play.hls_urls;
    let mut flv_urls = Vec::with_capacity(play.urls.len());
    // 后端已按协议分流；这里再兜一层，防止某个平台把 m3u8 混进 urls。
    for url in play.urls {
        if url.to_ascii_lowercase().contains(".m3u8") {
            hls_urls.push(url);
        } else {
            flv_urls.push(url);
        }
    }
    if flv_urls.is_empty() && hls_urls.is_empty() {
        return Err("这个清晰度没有可用的播放地址".to_string());
    }
    eprintln!(
        "[play] {key} 清晰度 {index}：FLV {} 条 / HLS {} 条",
        flv_urls.len(),
        hls_urls.len()
    );
    let referer = match platform {
        Platform::Bilibili => format!("https://live.bilibili.com/{room_id}"),
        Platform::Huya => format!("https://www.huya.com/{room_id}"),
        Platform::Douyu => format!("https://www.douyu.com/{room_id}"),
        Platform::Douyin => format!("https://live.douyin.com/{room_id}"),
        Platform::Kuaishou => format!("https://live.kuaishou.com/u/{room_id}"),
    };
    Ok(PlayPayload {
        urls: proxy_play_urls(&state, &key, index, flv_urls, referer.clone()),
        hls_urls,
        headers: Vec::new(),
    })
}

// ---------------------------------------------------------------- 弹幕

/// 发送一条弹幕。只做纯文本，表情/图片/礼物弹幕不在支持范围内。
#[tauri::command]
async fn send_danmaku(
    state: State<'_, AppState>,
    key: String,
    text: String,
) -> Result<(), String> {
    let detail = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "会话锁失效".to_string())?;
        let session = sessions
            .get(&key)
            .ok_or_else(|| "房间会话已失效，请重新进房".to_string())?;
        session.detail.clone()
    };
    let core = state.core(detail.platform);
    blocking(move || core.send_danmaku(&detail, &text)).await
}

/// 启动弹幕会话。
///
/// `signature` / `user_id` 只有抖音用：它的 WebSocket 握手要带 webmssdk 生成的
/// 签名，而那个脚本只能在 JS 引擎里跑，所以由 WebView 算好后传进来。
#[tauri::command]
async fn start_danmaku(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    signature: Option<String>,
    user_id: Option<String>,
) -> Result<(), String> {
    stop_danmaku_inner(&state);

    let mut detail = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "会话锁失效".to_string())?;
        sessions
            .get(&key)
            .map(|session| session.detail.clone())
            .ok_or_else(|| "房间会话已失效，请重新进房".to_string())?
    };

    // 抖音的签名只能在 JS 引擎里算，所以由前端算好传进来；其余平台用不到这两个参数。
    if let RoomExtra::Douyin {
        signature: slot_sig,
        user_id: slot_uid,
        ..
    } = &mut detail.extra
    {
        *slot_sig = signature.unwrap_or_default();
        *slot_uid = user_id.unwrap_or_default();
    }

    let session =
        DanmakuSession::start(detail.platform, &detail.extra).map_err(|error| error.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    std::thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            for status in session.drain_status() {
                let _ = app.emit("danmaku-status", &status);
            }
            for message in session.drain() {
                let _ = app.emit("danmaku", &message);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    if let Ok(mut slot) = state.danmaku.lock() {
        *slot = Some(DanmakuRuntime { stop });
    }
    Ok(())
}

#[tauri::command]
fn stop_danmaku(state: State<'_, AppState>) -> Result<(), String> {
    stop_danmaku_inner(&state);
    Ok(())
}

fn stop_danmaku_inner(state: &State<'_, AppState>) {
    if let Ok(mut slot) = state.danmaku.lock()
        && let Some(runtime) = slot.take()
    {
        runtime.stop.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- 剪贴板 / 浏览器

/// 复制文本到系统剪贴板。
///
/// 走 Win32 剪贴板 API（见 `win32` 模块），不再 fork `cmd /C clip`，
/// 所以不会闪终端窗口，也不会因为等待子进程退出而卡住界面。
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    win32::copy_to_clipboard(&text)
}

/// 用系统默认浏览器打开链接。
///
/// 同样不再走 `cmd /C start`：它会弹终端，而且对带引号的 URL 处理并不可靠。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("链接为空".to_string());
    }
    // 只放行 http/https。这个命令 WebView 可以直接调，不校验的话
    // `file:///...exe`、UNC 路径都会被 ShellExecuteW 当成可执行目标。
    let lower = url.get(..8).map(str::to_ascii_lowercase).unwrap_or_default();
    let is_http = lower.starts_with("https://") || lower.starts_with("http://");
    if !is_http {
        return Err("只支持打开 http/https 链接".to_string());
    }
    win32::open_in_browser(&url)
}

// ---------------------------------------------------------------- 账号登录

async fn build_core(cookie: String) -> Result<Arc<LiveCore>, String> {
    tauri::async_runtime::spawn_blocking(move || Arc::new(LiveCore::new().with_cookie(cookie)))
        .await
        .map_err(|error| format!("创建平台会话失败：{error}"))
}

#[tauri::command]
async fn set_cookie(
    state: State<'_, AppState>,
    platform: String,
    cookie: String,
) -> Result<(), String> {
    let platform = parse_platform(&platform)?;
    let cookie = cookie.trim().to_string();
    let core = build_core(cookie.clone()).await?;
    state.store_cookie(platform, cookie, core);
    Ok(())
}

#[tauri::command]
async fn clear_cookie(state: State<'_, AppState>, platform: String) -> Result<(), String> {
    let platform = parse_platform(&platform)?;
    let core = build_core(String::new()).await?;
    state.store_cookie(platform, String::new(), core);
    Ok(())
}

// ---------------------------------------------------------------- 网页登录

/// 各平台的网页登录入口：(打开地址, 窗口标题, 读取 Cookie 的地址)。
///
/// Cookie 是按 URL 取的，第三个值必须和登录页同域，否则 WebView2 的
/// CookieManager 会把真正的登录凭据过滤掉（尤其是 `.douyin.com` 这类父域 Cookie）。
fn login_page(platform: Platform) -> Option<(&'static str, &'static str, &'static str)> {
    match platform {
        Platform::Bilibili => Some((
            "https://passport.bilibili.com/login",
            "登录哔哩哔哩",
            "https://www.bilibili.com",
        )),
        Platform::Douyu => Some(("https://www.douyu.com/", "登录斗鱼", "https://www.douyu.com")),
        Platform::Douyin => Some((
            "https://live.douyin.com/",
            "登录抖音",
            "https://live.douyin.com",
        )),
        Platform::Kuaishou => Some((
            "https://live.kuaishou.com/",
            "登录快手",
            "https://live.kuaishou.com",
        )),
        Platform::Huya => None,
    }
}

fn login_window_label(platform: Platform) -> String {
    format!("login-{}", platform.id())
}

/// 新窗口的 WebView2 environment 参数必须和主窗口**完全一致**。
///
/// WebView2 文档里写明：浏览器进程在多个 WebView 之间共享，若这次创建时给的
/// environment options 与已在运行的 WebView 不同，会直接返回
/// `HRESULT_FROM_WIN32(ERROR_INVALID_STATE)`（0x8007139F，"组或资源的状态不是
/// 执行请求操作的正确状态"）。主窗口的参数在 `tauri.conf.json` 的
/// `app.windows[0].additionalBrowserArgs` —— **改一处必须同步改另一处**。
const LOGIN_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion";

/// 打开一个独立的登录窗口。
///
/// 它和主窗口共用同一个 WebView2 用户数据目录，所以 cookie 是共享的：
/// 用户在窗口里扫码或账号登录完，主窗口这边直接就能读到，不需要复制粘贴。
#[tauri::command]
async fn open_login_window(app: AppHandle, platform: String) -> Result<(), String> {
    let platform = parse_platform(&platform)?;
    let (url, title, _) = login_page(platform)
        .ok_or_else(|| format!("{}暂不支持账号登录", platform.name()))?;
    let label = login_window_label(platform);
    // 重复打开时先关掉旧的，否则同 label 建窗会直接报错。
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
    }
    let parsed: tauri::Url = url
        .parse()
        .map_err(|error| format!("登录地址无效：{error}"))?;
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(parsed))
        .title(title)
        .inner_size(520.0, 800.0)
        .min_inner_size(400.0, 560.0)
        .additional_browser_args(LOGIN_BROWSER_ARGS)
        .center()
        .build()
        .map_err(|error| format!("打开登录窗口失败：{error}"))?;
    Ok(())
}

#[derive(Serialize)]
struct LoginCapture {
    user: LoginUser,
    cookie: String,
}

/// 读 Cookie 时按名字判断字段是否存在（值里可能有 `=`，所以只切第一个）。
fn cookie_has_field(cookie: &str, name: &str) -> bool {
    cookie.split(';').any(|part| {
        part.trim().split_once('=').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case(name) && !value.trim().is_empty()
        })
    })
}

fn cookie_field<'a>(cookie: &'a str, name: &str) -> Option<&'a str> {
    cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key.trim().eq_ignore_ascii_case(name) && !value.trim().is_empty()).then_some(value.trim())
    })
}

/// 抖音/快手没有「当前用户」的免签名接口，只能按登录凭据是否存在来判断。
/// 这一步只做提示，不拦人：Cookie 是否真的可用，取流或发弹幕时平台会给出答案。
fn web_login_user(platform: Platform, cookie: &str) -> LoginUser {
    let (fields, fallback_name): (&[&str], &str) = match platform {
        Platform::Douyin => (&["sessionid", "sessionid_ss", "sid_guard"], "抖音账号"),
        Platform::Kuaishou => (
            &["userId", "kuaishou.live.web_st", "kuaishou.web.cp.api_st"],
            "快手账号",
        ),
        Platform::Douyu => (&["acf_auth"], "斗鱼账号"),
        Platform::Bilibili => (&["SESSDATA"], "B 站用户"),
        Platform::Huya => (&[], "虎牙账号"),
    };
    let logged_in = fields
        .iter()
        .any(|field| cookie_has_field(cookie, field));
    if !logged_in {
        return LoginUser {
            logged_in: false,
            name: String::new(),
            avatar: String::new(),
            uid: String::new(),
            message: if cookie.trim().is_empty() {
                "登录窗口里还没有 Cookie，请先完成扫码或账号登录".to_string()
            } else {
                "没有检测到登录凭据，请确认窗口里已经登录成功（不是停在扫码页）".to_string()
            },
        };
    }
    // 快手 Cookie 里的 `userId` 就是账号的数字 ID，可以直接显示。
    let uid = cookie_field(cookie, "userId")
        .or_else(|| cookie_field(cookie, "DedeUserID"))
        .unwrap_or("")
        .to_string();
    LoginUser {
        logged_in: true,
        name: fallback_name.to_string(),
        avatar: String::new(),
        uid,
        message: format!("已读取登录 Cookie（{} 字符）", cookie.trim().len()),
    }
}

/// 从登录窗口（没开就用主窗口）读出该平台的 Cookie。
///
/// 两个窗口共享同一份 cookie 存储，所以即使用户已经关掉登录窗口也读得到。
#[tauri::command]
async fn capture_login(app: AppHandle, platform: String) -> Result<LoginCapture, String> {
    let platform = parse_platform(&platform)?;
    let (_, _, cookie_url) =
        login_page(platform).ok_or_else(|| format!("{}暂不支持账号登录", platform.name()))?;
    let label = login_window_label(platform);
    let window = app
        .get_webview_window(&label)
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "找不到可以读取 Cookie 的窗口".to_string())?;
    let url: tauri::Url = cookie_url
        .parse()
        .map_err(|error| format!("读取地址无效：{error}"))?;
    let cookies = window
        .cookies_for_url(url)
        .map_err(|error| format!("读取 Cookie 失败：{error}"))?;
    let cookie = cookies
        .iter()
        .map(|item| format!("{}={}", item.name(), item.value()))
        // Cookie 值里理论上不该有换行；有的话会破坏 HTTP 头，直接剔除。
        .filter(|pair| !pair.contains(['\r', '\n']))
        .collect::<Vec<_>>()
        .join("; ");
    let user = if platform == Platform::Bilibili && !cookie.is_empty() {
        // B 站有 nav 接口，能顺便把昵称和头像带出来。
        tauri::async_runtime::spawn_blocking({
            let cookie = cookie.clone();
            move || bili_user(&cookie)
        })
        .await
        .map_err(|error| format!("验证登录态失败：{error}"))?
        .unwrap_or_else(|_| web_login_user(platform, &cookie))
    } else {
        web_login_user(platform, &cookie)
    };
    if user.logged_in {
        // 登录成功后把窗口收掉，免得用户以为还要在里面停留。
        let _ = window.close();
    }
    Ok(LoginCapture { user, cookie })
}

fn bili_user(cookie: &str) -> Result<LoginUser, String> {
    let http = HttpSession::new().with_cookie(cookie);
    let value = http
        .get_json(
            "https://api.bilibili.com/x/web-interface/nav",
            &[],
            &[
                ("user-agent", DESKTOP_UA),
                ("referer", BILIBILI_REFERER),
            ],
        )
        .map_err(fail)?;
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let logged_in = code == 0
        && data
            .get("isLogin")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if !logged_in {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("B 站 Cookie 无效或已过期");
        return Ok(LoginUser {
            logged_in: false,
            name: String::new(),
            avatar: String::new(),
            uid: String::new(),
            message: message.to_string(),
        });
    }
    Ok(LoginUser {
        logged_in: true,
        name: data
            .get("uname")
            .and_then(Value::as_str)
            .unwrap_or("B 站用户")
            .to_string(),
        avatar: data
            .get("face")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        uid: data
            .get("mid")
            .and_then(Value::as_u64)
            .map(|mid| mid.to_string())
            .unwrap_or_default(),
        message: "已登录".to_string(),
    })
}

#[tauri::command]
async fn login_status(platform: String, cookie: String) -> Result<LoginUser, String> {
    let platform = parse_platform(&platform)?;
    tauri::async_runtime::spawn_blocking(move || match platform {
        Platform::Bilibili => bili_user(&cookie),
        Platform::Douyu => {
            let configured = !cookie.trim().is_empty();
            Ok(LoginUser {
                logged_in: configured,
                name: if configured {
                    "斗鱼账号".to_string()
                } else {
                    String::new()
                },
                avatar: String::new(),
                uid: String::new(),
                message: if configured {
                    format!("已配置 Cookie（{} 字符）", cookie.trim().len())
                } else {
                    "未配置 Cookie".to_string()
                },
            })
        }
        Platform::Douyin | Platform::Kuaishou => Ok(web_login_user(platform, &cookie)),
        _ => Ok(LoginUser {
            logged_in: false,
            name: String::new(),
            avatar: String::new(),
            uid: String::new(),
            message: "该平台暂不支持账号登录".to_string(),
        }),
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))?
}

#[tauri::command]
async fn bili_qr_generate() -> Result<QrPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let http = HttpSession::new();
        let value = http
            .get_json(
                "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
                &[],
                &[
                    ("user-agent", DESKTOP_UA),
                    ("referer", BILIBILI_REFERER),
                    ("origin", "https://www.bilibili.com"),
                    ("accept", "application/json, text/plain, */*"),
                ],
            )
            .map_err(fail)?;
        let data = value
            .get("data")
            .filter(|data| !data.is_null())
            .ok_or_else(|| {
                format!(
                    "B 站二维码接口没有返回数据：{}",
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("接口异常")
                )
            })?;
        let url = data
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "B 站没有返回二维码地址".to_string())?
            .to_string();
        // 有的返回不带 qrcode_key 字段，但 URL 查询串里一定有。
        let key = data
            .get("qrcode_key")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                url::Url::parse(&url).ok().and_then(|parsed| {
                    parsed
                        .query_pairs()
                        .find(|(key, _)| key == "qrcode_key")
                        .map(|(_, value)| value.into_owned())
                })
            })
            .ok_or_else(|| "B 站没有返回二维码 key".to_string())?;
        Ok(QrPayload { url, key })
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))?
}

const BILI_COOKIE_KEYS: [&str; 8] = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
];

fn bili_cookie_parts_from_url(url: &str) -> Vec<String> {
    let Ok(parsed) = url::Url::parse(url) else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    for (key, value) in parsed.query_pairs() {
        if BILI_COOKIE_KEYS.contains(&key.as_ref()) {
            parts.push(format!("{key}={value}"));
        }
    }
    parts
}

fn bili_cookie_parts_from_headers(headers: &reqwest::header::HeaderMap) -> Vec<String> {
    let mut parts = Vec::new();
    for value in headers.get_all("set-cookie").iter() {
        let Ok(text) = value.to_str() else {
            continue;
        };
        // 只取 name=value，忽略 Path/Domain/HttpOnly 等属性。
        let Some(first) = text.split(';').next() else {
            continue;
        };
        let Some((name, value)) = first.split_once('=') else {
            continue;
        };
        if BILI_COOKIE_KEYS.contains(&name) && !value.is_empty() {
            parts.push(format!("{name}={value}"));
        }
    }
    parts
}

fn merge_bili_cookies(url: &str, headers: &reqwest::header::HeaderMap) -> Result<String, String> {
    let mut merged: Vec<(String, String)> = Vec::new();
    for part in bili_cookie_parts_from_headers(headers)
        .into_iter()
        .chain(bili_cookie_parts_from_url(url))
    {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if let Some(existing) = merged.iter_mut().find(|(key, _)| key == name) {
            existing.1 = value.to_string();
        } else {
            merged.push((name.to_string(), value.to_string()));
        }
    }
    if !merged.iter().any(|(name, _)| name == "SESSDATA") {
        return Err("B 站登录成功但没有返回 SESSDATA，请改用 Cookie 登录".to_string());
    }
    Ok(merged
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

#[tauri::command]
async fn bili_qr_poll(key: String) -> Result<QrPollResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let http = HttpSession::new();
        let (value, headers) = http
            .get_json_with_headers(
                "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
                &[("qrcode_key", key.as_str()), ("source", "main-fe-header")],
                &[
                    ("user-agent", DESKTOP_UA),
                    ("referer", BILIBILI_REFERER),
                    ("origin", "https://www.bilibili.com"),
                    ("accept", "application/json, text/plain, */*"),
                ],
            )
            .map_err(fail)?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        if data.is_null() {
            return Err(format!(
                "B 站轮询接口没有返回数据：{}",
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("接口异常")
            ));
        }
        let code = value_i64(data.get("code"));
        match code {
            0 => {
                let url = data.get("url").and_then(Value::as_str).unwrap_or("");
                let cookie = merge_bili_cookies(url, &headers)?;
                // 扫码成功后用 nav 接口补头像/昵称；nav 偶发风控时仍保留 Cookie。
                let user = bili_user(&cookie).unwrap_or_else(|error| LoginUser {
                    logged_in: true,
                    name: "B 站用户".to_string(),
                    avatar: String::new(),
                    uid: String::new(),
                    message: error,
                });
                let user = if user.logged_in {
                    user
                } else {
                    LoginUser {
                        logged_in: true,
                        name: "B 站用户".to_string(),
                        avatar: String::new(),
                        uid: String::new(),
                        message: user.message,
                    }
                };
                Ok(QrPollResult {
                    status: "authorized".to_string(),
                    message: "登录成功".to_string(),
                    cookie: Some(cookie),
                    user: Some(user),
                })
            }
            86101 => Ok(QrPollResult {
                status: "waiting".to_string(),
                message: "等待扫码".to_string(),
                cookie: None,
                user: None,
            }),
            86090 => Ok(QrPollResult {
                status: "scanned".to_string(),
                message: "已扫码，请在手机上确认".to_string(),
                cookie: None,
                user: None,
            }),
            86038 => Ok(QrPollResult {
                status: "expired".to_string(),
                message: "二维码已过期，请刷新".to_string(),
                cookie: None,
                user: None,
            }),
            _ => Ok(QrPollResult {
                status: "error".to_string(),
                message: data
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("二维码状态异常")
                    .to_string(),
                cookie: None,
                user: None,
            }),
        }
    })
    .await
    .map_err(|error| format!("任务执行失败：{error}"))?
}

// ---------------------------------------------------------------- 窗口与托盘

/// WebView2 用户数据目录：放到 `%LOCALAPPDATA%\Starveil\WebView2`，
/// 不跟着 identifier 走（`com.banlany.starveil` 默认会落在 `com.banlany.starveil\EBWebView`，
/// 更早的版本还用过 `top.june6699.starveil`；两处都不该用来存用户数据）。
#[cfg(windows)]
fn webview_data_dir() -> PathBuf {
    match std::env::var("LOCALAPPDATA") {
        Ok(local) => Path::new(&local).join("Starveil").join("WebView2"),
        // 非 Windows 或读不到 LOCALAPPDATA 时退回当前目录，保证还能起来。
        Err(_) => PathBuf::from("starveil-webview"),
    }
}

/// 运行时日志：写到 `%LOCALAPPDATA%\Starveil\starveil.log`，
/// 出问题（比如窗口空白）时用户可以直接把这个文件发过来。
fn log_line(message: &str) {
    // 移动端没有 %LOCALAPPDATA%：统一打到标准输出，Android 上会进 logcat
    // （`adb logcat -s RustStdoutStderr`）。
    if cfg!(not(windows)) {
        println!("[starveil] {message}");
    }
    let dir = match std::env::var("LOCALAPPDATA") {
        Ok(local) => Path::new(&local).join("Starveil"),
        Err(_) => return,
    };
    let _ = std::fs::create_dir_all(&dir);
    let line = format!(
        "[{}] {message}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default()
    );
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("starveil.log"))
    {
        use std::io::Write as _;
        let _ = file.write_all(line.as_bytes());
    }
}

/// 前端初始化完成后调用，便于确认页面真的跑起来了。
#[tauri::command]
fn frontend_log(message: String) {
    log_line(&format!("[web] {message}"));
}

// ---------------------------------------------------------------- WebDAV 同步

/// 探测 WebDAV 目标：验证地址/账号，并报告同步文件是否已存在。
#[tauri::command]
async fn webdav_test(
    url: String,
    username: String,
    password: String,
    allow_insecure_tls: bool,
) -> Result<webdav::WebdavInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        webdav::probe(&url, &username, &password, allow_insecure_tls)
    })
    .await
    .map_err(|error| format!("同步任务异常：{error}"))?
}

/// 把同步包整包上传（覆盖远端同名文件）。
#[tauri::command]
async fn webdav_upload(
    url: String,
    username: String,
    password: String,
    allow_insecure_tls: bool,
    content: String,
) -> Result<webdav::WebdavInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        webdav::upload(&url, &username, &password, allow_insecure_tls, &content)
    })
    .await
    .map_err(|error| format!("同步任务异常：{error}"))?
}

/// 拉取远端同步包，返回原文由前端解析。
#[tauri::command]
async fn webdav_download(
    url: String,
    username: String,
    password: String,
    allow_insecure_tls: bool,
) -> Result<webdav::WebdavDownload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        webdav::download(&url, &username, &password, allow_insecure_tls)
    })
    .await
    .map_err(|error| format!("同步任务异常：{error}"))?
}

/// 准备 WebView2 的数据目录，并把目录通过环境变量交给 WebView2。
///
/// 这里不用 `WebviewWindowBuilder::data_directory`——实践里由 Rust 手动建窗时
/// WebView2 环境会创建失败（窗口在但没有 webview 进程、页面空白），
/// 而配置建窗 + `WEBVIEW2_USER_DATA_FOLDER` 这条路上表现正常。
#[cfg(windows)]
fn prepare_webview_data() {
    let data_dir = webview_data_dir();
    let _ = std::fs::create_dir_all(&data_dir);

    if std::env::var("STARVEIL_NO_DATADIR").is_err() {
        // WebView2 在没有显式 user data folder 时会读这个变量。
        unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir) };
    }
}

/// 移动端与其它平台不需要指定 WebView 数据目录（由系统按包名分配）。
#[cfg(not(windows))]
fn prepare_webview_data() {}

/// WebView2 的 GPU 进程沙箱在部分环境下初始化会失败：
/// GPU 进程连续 `exit_code=7` 崩溃后，浏览器主进程会 FATAL 退出
/// （`GPU process isn't usable. Goodbye.`），窗口最终全黑。
///
/// 根因（已实测确认）：Chromium 的 GPU 沙箱要给自己的子进程创建
/// 「受限令牌 + 嵌套 Job Object」。**当父进程本身已经被放进某个 Job 时**
/// （Windows 桌面 Job、WorkBuddy 的 sandbox-cli、CI 容器等），
/// 嵌套 Job 的创建会被拒绝 → GPU 进程起不来。
///
/// 实测对照（同一台机器、同一份二进制）：
///   - 由 explorer.exe 启动（进程在 Windows 桌面 Job 里）→ GPU 崩溃 3/3
///   - 由 WmiPrvSE 启动（进程不在任何 Job 里）→ GPU 正常 3/3
///
/// 所以这里直接检测「本进程是否在 Job 中」，据此决定是否关闭 GPU 沙箱。
/// 结果缓存进标记文件，之后的启动直接复用。
#[cfg(windows)]
fn gpu_sandbox_broken_marker() -> PathBuf {
    starveil_data_dir().join("gpu-sandbox-broken.flag")
}

fn starveil_data_dir() -> PathBuf {
    match std::env::var("LOCALAPPDATA") {
        Ok(local) => Path::new(&local).join("Starveil"),
        Err(_) => PathBuf::from("."),
    }
}

/// 当前进程是否被放进了一个 Job Object。
///
/// Windows 上 `IsProcessInJob(NULL, ...)` 表示「查询进程所属的任意 Job」。
/// 返回 true 就说明父进程链上有 Job，Chromium 的 GPU 沙箱很可能起不来。
///
/// 直接调 kernel32，不引入 `windows` crate（避免多一个依赖和版本耦合）。
#[cfg(windows)]
fn current_process_in_job() -> Option<bool> {
    use std::ffi::c_void;

    #[repr(C)]
    struct Bool {
        value: i32,
    }

    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn IsProcessInJob(
            process: *mut c_void,
            job: *mut c_void,
            result: *mut Bool,
        ) -> i32;
    }

    unsafe {
        let mut in_job = Bool { value: 0 };
        // 第二个参数传 NULL 表示「进程所属的任意 Job」。
        let ok = IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job);
        if ok == 0 {
            return None;
        }
        Some(in_job.value != 0)
    }
}

#[cfg(not(windows))]
fn current_process_in_job() -> Option<bool> {
    None
}

/// 按需给 WebView2 追加 `--disable-gpu-sandbox`。
///
/// 环境变量里的参数是**追加**到 `additionalBrowserArgs` 之后的，
/// 所以这里不会覆盖配置里的静态参数。
#[cfg(windows)]
fn apply_gpu_sandbox_workaround() {
    // 用户显式要求保留沙箱时不动。
    if std::env::var("STARVEIL_FORCE_GPU_SANDBOX").is_ok() {
        log_line("GPU 沙箱：按环境变量要求保持开启");
        return;
    }
    // 用户显式要求关闭时直接关。
    if std::env::var("STARVEIL_DISABLE_GPU_SANDBOX").is_ok() {
        append_browser_args("--disable-gpu-sandbox");
        log_line("GPU 沙箱：按环境变量要求关闭");
        return;
    }

    let marker = gpu_sandbox_broken_marker();
    if marker.exists() {
        // 之前已经判定为不可用，直接沿用结论。
        append_browser_args("--disable-gpu-sandbox");
        log_line("GPU 沙箱：沿用上次的结论（已禁用）");
        return;
    }

    match current_process_in_job() {
        Some(true) => {
            // 在 Job 里 → GPU 沙箱起不来，直接关掉。
            let _ = std::fs::create_dir_all(starveil_data_dir());
            let _ = std::fs::write(&marker, b"1");
            append_browser_args("--disable-gpu-sandbox");
            log_line("GPU 沙箱：检测到本进程处于 Job Object 中，GPU 沙箱将无法启动，已关闭");
        }
        Some(false) => {
            log_line("GPU 沙箱：未处于 Job Object 中，保持开启");
        }
        None => {
            log_line("GPU 沙箱：无法判定 Job 状态，先按正常启动");
        }
    }
}

/// WebView2 的 GPU 沙箱问题不存在于移动端。
#[cfg(not(windows))]
fn apply_gpu_sandbox_workaround() {}

/// 往 WebView2 的浏览器参数末尾追加一段。
///
/// 环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 里的参数是**追加**到
/// `tauri.conf.json` 的 `additionalBrowserArgs` **之后**的，不会覆盖它，
/// 所以这里用来做「运行时才决定」的参数（目前只有 GPU 沙箱降级）。
///
/// 顺带记一条坑：wry 源码 `webview2/mod.rs` 里默认参数是
/// `unwrap_or_else` 提供的（`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`），
/// 一旦配置里显式写了 `additionalBrowserArgs`，wry 的默认就**整份失效**——
/// 所以配置里必须自己把这三个 feature 写全。
/// 其中 `CalculateNativeWinOcclusion` 用来关掉 Windows 原生的遮挡检测：
/// 无边框窗口经常被系统误判为「被遮挡」而停止渲染与计时器。
#[cfg(windows)]
fn append_browser_args(extra: &str) {
    let key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let current = std::env::var(key).unwrap_or_default();
    if current.split_whitespace().any(|a| a == extra) {
        return;
    }
    let merged = if current.trim().is_empty() {
        extra.to_string()
    } else {
        format!("{current} {extra}")
    };
    unsafe { std::env::set_var(key, merged) };
}

/// 桌面 `main()` 与移动端（Android/iOS）桥接层共用的唯一入口。
///
/// `mobile_entry_point` 会由 Tauri 生成的原生工程在 Activity 启动时回调，
/// 桌面侧则由 `main.rs` 直接调用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log_line("==== 启动 ====");
    // 必须在 Tauri 建窗之前设置，WebView2 只会在没有显式 user data folder 时读它。
    prepare_webview_data();
    // GPU 沙箱探测要在建窗之前做完，否则首启就会黑屏一次。
    apply_gpu_sandbox_workaround();
    let (proxy_port, proxy_targets) = start_proxy();
    // 在进入 async 运行时之前创建 blocking HTTP client。
    // 必须按 Platform::ALL 建：漏掉哪个平台，取核心时就会 panic，
    // 而 panic 在 async 任务里不会变成前端可见的 reject，界面会一直卡在加载中。
    let mut cores = HashMap::new();
    for platform in Platform::ALL {
        cores.insert(platform, Arc::new(LiveCore::new()));
    }
    tauri::Builder::default()
        .manage(AppState {
            cores: Mutex::new(cores),
            cookies: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            danmaku: Mutex::new(None),
            proxy_port,
            proxy_targets,
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // 启动后记录一次 webview 的真实状态，便于排查窗口空白之类的问题。
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                match handle.get_webview_window("main") {
                    Some(window) => {
                        log_line(&format!(
                            "窗口可见={:?} 地址={:?}",
                            window.is_visible(),
                            window.url()
                        ));
                    }
                    None => log_line("找不到 main 窗口"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            recommend,
            search,
            search_anchors,
            categories,
            category_rooms,
            resolve_input,
            quit_app,
            open_room,
            douyu_qualities,
            douyu_play,
            play,
            start_danmaku,
            stop_danmaku,
            send_danmaku,
            copy_text,
            open_url,
            set_cookie,
            clear_cookie,
            open_login_window,
            capture_login,
            login_status,
            bili_qr_generate,
            bili_qr_poll,
            frontend_log,
            webdav_test,
            webdav_upload,
            webdav_download
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
