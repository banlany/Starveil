//! Tauri 后端：把 `live_core` 的三站取流与弹幕包装成命令，界面全部交给 WebView2。
//!
//! 视频不再走 libmpv：前端用 mpegts.js 播 FLV，音频和渲染都由 WebView2 负责。
//!
//! 斗鱼比较特殊：清晰度和取流参数需要执行服务端下发的混淆 JS 签名。
//! 这里用 WebView 的 JS 引擎签名，再把参数回传给 Rust；斗鱼 CDN 还会校验
//! Referer，浏览器 fetch 不允许设置 Referer，因此额外起一个本机流代理。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use live_core::{
    DanmakuSession, HttpSession, LiveCore, LiveError, LiveRoomDetail, LiveRoomItem, Platform,
    PlayQuality, QualityData,
};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

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
                        ("rows", &(page * 20).to_string()),
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

fn start_proxy() -> (u16, Arc<Mutex<HashMap<String, ProxyTarget>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("启动本地流代理失败");
    let port = listener.local_addr().expect("读取代理端口失败").port();
    let targets = Arc::new(Mutex::new(HashMap::new()));
    let shared = targets.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let targets = shared.clone();
            std::thread::spawn(move || proxy_connection(stream, targets));
        }
    });
    (port, targets)
}

fn proxy_connection(stream: TcpStream, targets: Arc<Mutex<HashMap<String, ProxyTarget>>>) {
    let _ = stream.set_nodelay(true);
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
        let _ = write!(
            socket,
            "HTTP/1.1 404 Not Found\r\n{cors}Connection: close\r\nContent-Length: 0\r\n\r\n"
        );
        return;
    };

    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let response = client
        .get(&target.url)
        .header("referer", &target.referer)
        .header("user-agent", &target.user_agent)
        .send();
    let mut response = match response {
        Ok(response) if response.status().is_success() => response,
        _ => {
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
    let _ = std::io::copy(&mut response, &mut socket);
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
            let script = douyu_script(&detail.room_id, &did, &login_cookie)?;
            Ok::<_, String>((detail, Vec::new(), Some(script), Some(did)))
        } else {
            let qualities = core.qualities(&detail).map_err(fail)?;
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
    if let Ok(mut targets) = state.proxy_targets.lock() {
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
    if let Ok(mut targets) = state.proxy_targets.lock() {
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
    let mut urls = blocking(move || core.play(&detail, &quality)).await?.urls;
    // 当前播放器是 mpegts.js，只能吃 FLV；B 站清晰度接口会混入 HLS 线路。
    urls.retain(|url| !url.to_ascii_lowercase().contains(".m3u8"));
    if urls.is_empty() {
        return Err("这个清晰度只有 HLS 线路，当前播放器暂不支持".to_string());
    }
    let referer = match platform {
        Platform::Bilibili => format!("https://live.bilibili.com/{room_id}"),
        Platform::Huya => format!("https://www.huya.com/{room_id}"),
        Platform::Douyu => format!("https://www.douyu.com/{room_id}"),
    };
    Ok(PlayPayload {
        urls: proxy_play_urls(&state, &key, index, urls, referer),
        headers: Vec::new(),
    })
}

// ---------------------------------------------------------------- 弹幕

#[tauri::command]
async fn start_danmaku(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    stop_danmaku_inner(&state);

    let detail = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "会话锁失效".to_string())?;
        sessions
            .get(&key)
            .map(|session| session.detail.clone())
            .ok_or_else(|| "房间会话已失效，请重新进房".to_string())?
    };

    let session =
        DanmakuSession::start(detail.platform, &detail.extra).map_err(|error| error.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    std::thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
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

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("cmd")
        .args(["/C", "clip"])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("调用剪贴板失败：{error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("写入剪贴板失败：{error}"))?;
    }
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开链接失败：{error}"))
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

fn main() {
    let (proxy_port, proxy_targets) = start_proxy();
    // 在进入 async 运行时之前创建 blocking HTTP client。
    let mut cores = HashMap::new();
    for platform in [Platform::Bilibili, Platform::Douyu, Platform::Huya] {
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
            copy_text,
            open_url,
            set_cookie,
            clear_cookie,
            login_status,
            bili_qr_generate,
            bili_qr_poll
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
