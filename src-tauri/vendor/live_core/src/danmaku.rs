//! 弹幕接收。
//!
//! 三站三套协议，这里把它们收敛成一个 `Receiver<DanmakuMessage>`：
//! - 哔哩哔哩：WebSocket + 16 字节头，正文 JSON，ver=2 走 zlib、ver=3 走 brotli
//! - 斗鱼：WebSocket + 12 字节头，正文是 STT 文本
//! - 虎牙：WebSocket + Tars 编码
//!
//! 只读不写：本项目不实现发送弹幕。

use crate::error::LiveError;
use serde::Serialize;
use crate::model::{Platform, RoomExtra};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use base64::Engine as _;
use crate::huya_token::{Reader, Writer};
use tungstenite::client::IntoClientRequest;

/// 一条弹幕（或系统提示）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DanmakuMessage {
    pub user: String,
    pub text: String,
    /// RGB，`None` 表示默认白色。
    pub color: Option<u32>,
    /// 系统消息（进房提示、人气值等），UI 用弱化样式。
    pub system: bool,
    /// 0=滚动，1=顶部固定，2=底部固定（B 站弹幕模式 5/4）。
    #[serde(default)]
    pub position: u8,
    /// B 站醒目留言（SC）；普通弹幕为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sc: Option<SuperChatMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SuperChatMessage {
    pub price: u64,
    pub avatar: String,
    pub background_color: String,
    pub background_bottom_color: String,
    pub start_time: u64,
    pub end_time: u64,
}

impl DanmakuMessage {
    pub fn chat(user: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            user: user.into(),
            text: text.into(),
            color: None,
            system: false,
            position: 0,
            sc: None,
        }
    }

    pub fn system(text: impl Into<String>) -> Self {
        Self {
            user: String::new(),
            text: text.into(),
            color: None,
            system: true,
            position: 0,
            sc: None,
        }
    }
}

/// 一次弹幕会话。丢到后台线程跑，UI 侧定时 `drain()`。
pub struct DanmakuSession {
    rx: Receiver<DanmakuMessage>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    platform: Platform,
}

impl DanmakuSession {
    pub fn start(platform: Platform, extra: &RoomExtra) -> Result<Self, LiveError> {
        let (tx, rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));

        let thread_stop = stop.clone();
        let extra = extra.clone();
        let thread = thread::Builder::new()
            .name("danmaku".to_string())
            .spawn(move || match platform {
                Platform::Bilibili => run_bilibili(&extra, &tx, &thread_stop),
                Platform::Douyu => run_douyu(&extra, &tx, &thread_stop),
                Platform::Huya => run_huya(&extra, &tx, &thread_stop),
            })
            .map_err(|error| LiveError::network(format!("启动弹幕线程失败：{error}")))?;

        Ok(Self {
            rx,
            stop,
            thread: Some(thread),
            platform,
        })
    }

    pub fn run_danmaku_platform(&self) -> Platform {
        self.platform
    }

    /// 取走已到达的弹幕（非阻塞）。
    pub fn drain(&self) -> Vec<DanmakuMessage> {
        self.rx.try_iter().collect()
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            // 网络读可能阻塞，交给它自己超时退出，不在这里干等。
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for DanmakuSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// tungstenite 的 rustls 没带默认 CryptoProvider，进程内装一次即可。
fn ensure_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn sleep_while(stop: &AtomicBool, duration: Duration) -> bool {
    let step = Duration::from_millis(100);
    let mut left = duration;
    while left > Duration::ZERO {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        thread::sleep(step.min(left));
        left = left.saturating_sub(step);
    }
    !stop.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------- 哔哩哔哩

fn run_bilibili(extra: &RoomExtra, tx: &Sender<DanmakuMessage>, stop: &AtomicBool) {
    ensure_crypto_provider();
    let RoomExtra::Bilibili {
        token,
        host,
        buvid3,
        buvid4,
        cookie,
        uid,
        room_id: _,
        ..
    } = extra
    else {
        let _ = tx.send(DanmakuMessage::system("B 站弹幕参数缺失，已跳过弹幕"));
        return;
    };
    if token.is_empty() {
        let _ = tx.send(DanmakuMessage::system("未取到 B 站弹幕 token，弹幕不可用"));
        return;
    }
    let Some(room_id) = bilibili_room_id(extra) else {
        return;
    };

    let url = format!("wss://{host}/sub");
    let mut attempt = 0;
    while !stop.load(Ordering::Relaxed) && attempt < 3 {
        attempt += 1;
        // B 站弹幕服务器会校验 Origin，并可能根据 buvid 下发不同的房间流。
        let mut request = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                let _ = tx.send(DanmakuMessage::system(format!(
                    "B 站弹幕握手失败：{error}"
                )));
                return;
            }
        };
        let mut ws_cookie = cookie.trim().to_string();
        if !ws_cookie.contains("buvid3=") {
            if !ws_cookie.is_empty() {
                ws_cookie.push_str("; ");
            }
            ws_cookie.push_str(&format!("buvid3={buvid3}; buvid4={buvid4}"));
        }
        if let Ok(value) = tungstenite::http::HeaderValue::from_str(&ws_cookie) {
            request.headers_mut().insert("Cookie", value);
        }

        match tungstenite::connect(request) {
            Ok((mut socket, _)) => {
                // 给底层 TCP 设个读超时：否则房间安静时 read() 会永久阻塞，
                // 切房后线程退不出去，socket 与缓冲区都泄漏。
                if let tungstenite::stream::MaybeTlsStream::Rustls(stream) = socket.get_ref() {
                    let _ = stream
                        .sock
                        .set_read_timeout(Some(Duration::from_millis(600)));
                }
                if let Err(error) = socket.send(tungstenite::Message::Binary(
                    bilibili_packet(7, bilibili_join_body(&room_id, token, buvid3, *uid)).into(),
                )) {
                    let _ = tx.send(DanmakuMessage::system(format!(
                        "B 站弹幕进房失败：{error}"
                    )));
                }

                let mut last_heartbeat = std::time::Instant::now();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        let _ = socket.close(None);
                        return;
                    }
                    if last_heartbeat.elapsed() >= Duration::from_secs(25) {
                        let _ = socket.send(tungstenite::Message::Binary(
                            bilibili_packet(2, Vec::new()).into(),
                        ));
                        last_heartbeat = std::time::Instant::now();
                    }

                    match socket.read() {
                        Ok(tungstenite::Message::Binary(data)) => {
                            bilibili_handle(&data, tx);
                        }
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(error))
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
            }
            Err(error) => {
                let _ = tx.send(DanmakuMessage::system(format!(
                    "B 站弹幕连接失败：{error}"
                )));
            }
        }
        if !sleep_while(stop, Duration::from_secs(3)) {
            return;
        }
    }
}

/// 弹幕参数里没有单独存房间号，token 请求时用 detail.room_id；这里从 token 无法反推，
/// 因此由调用方把 room_id 放在 `RoomExtra::Bilibili` 里（见 model 注释）。
fn bilibili_room_id(extra: &RoomExtra) -> Option<String> {
    match extra {
        RoomExtra::Bilibili { room_id, .. } if !room_id.is_empty() => Some(room_id.clone()),
        _ => None,
    }
}

fn bilibili_join_body(room_id: &str, token: &str, buvid: &str, uid: u64) -> Vec<u8> {
    format!(
        r#"{{"uid":{uid},"roomid":{room_id},"protover":3,"buvid":"{buvid}","platform":"web","type":2,"key":"{token}"}}"#
    )
    .into_bytes()
}

fn bilibili_packet(action: u32, body: Vec<u8>) -> Vec<u8> {
    let mut packet = Vec::with_capacity(16 + body.len());
    packet.extend_from_slice(&((16 + body.len()) as u32).to_be_bytes());
    packet.extend_from_slice(&16u16.to_be_bytes());
    // 发送包 version=0（JSON 正文）；原版 Dart 也是这样写的。
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&action.to_be_bytes());
    packet.extend_from_slice(&1u32.to_be_bytes());
    packet.extend_from_slice(&body);
    packet
}

fn bilibili_handle(data: &[u8], tx: &Sender<DanmakuMessage>) {
    if data.len() < 16 {
        return;
    }
    let version = u16::from_be_bytes([data[6], data[7]]);
    let operation = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);
    let body = &data[16..];

    match operation {
        5 => {
            let decoded = match version {
                2 => inflate(body),
                3 => {
                    let mut out = Vec::new();
                    let mut reader = brotli::Decompressor::new(body, 8192);
                    match std::io::Read::read_to_end(&mut reader, &mut out) {
                        Ok(_) => out,
                        Err(_) => return,
                    }
                }
                _ => body.to_vec(),
            };
            bilibili_parse_json(&String::from_utf8_lossy(&decoded), tx);
        }
        3 => {
            // operation=3 是心跳应答（body 前 4 字节是人气值）。
            // 这里只用来确认连接还在，不再往聊天区塞「人气 N」系统消息：
            // 直播间头部已经显示平台给的观众/大航海数据，重复推送只会刷屏。
        }
        _ => {}
    }
}

fn inflate(data: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut decoder = flate2::read::ZlibDecoder::new(data);
    let mut out = Vec::new();
    let _ = decoder.read_to_end(&mut out);
    out
}

fn bilibili_parse_json(text: &str, tx: &Sender<DanmakuMessage>) {
    for chunk in text.split(|ch: char| ch.is_control()) {
        let chunk = chunk.trim();
        if chunk.len() < 3 || !chunk.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(chunk) else {
            continue;
        };
        let cmd = value.get("cmd").and_then(|cmd| cmd.as_str()).unwrap_or("");
        if cmd == "SUPER_CHAT_MESSAGE" {
            let Some(data) = value.get("data") else {
                continue;
            };
            let text = data
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                continue;
            }
            let user = data
                .get("user_info")
                .and_then(|info| info.get("uname"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let avatar = data
                .get("user_info")
                .and_then(|info| info.get("face"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let price = data.get("price").and_then(|v| v.as_u64()).unwrap_or(0);
            let background_color = data
                .get("background_color")
                .and_then(|v| v.as_str())
                .unwrap_or("#fb7299")
                .to_string();
            let background_bottom_color = data
                .get("background_bottom_color")
                .and_then(|v| v.as_str())
                .unwrap_or("#fb7299")
                .to_string();
            let start_time = data.get("start_time").and_then(|v| v.as_u64()).unwrap_or(0);
            let end_time = data.get("end_time").and_then(|v| v.as_u64()).unwrap_or(0);
            let _ = tx.send(DanmakuMessage {
                user,
                text,
                color: None,
                system: false,
                position: 0,
                sc: Some(SuperChatMessage {
                    price,
                    avatar,
                    background_color,
                    background_bottom_color,
                    start_time,
                    end_time,
                }),
            });
            continue;
        }
        if !cmd.starts_with("DANMU_MSG") {
            continue;
        }
        let Some(info) = value.get("info").and_then(|info| info.as_array()) else {
            continue;
        };
        let text = info.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if text.is_empty() {
            continue;
        }
        let user = info
            .get(2)
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.get(1))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let meta = info.first().and_then(|v| v.as_array());
        // B 站 info[0]: [1]=mode(1 滚动/4 底部/5 顶部), [3]=颜色。
        let mode = meta
            .and_then(|arr| arr.get(1))
            .and_then(|v| v.as_i64())
            .unwrap_or(1);
        let position = match mode {
            5 => 1,
            4 => 2,
            _ => 0,
        };
        let color = bilibili_extract_color(info);

        let _ = tx.send(DanmakuMessage {
            user,
            text,
            color,
            system: false,
            position,
            sc: None,
        });
    }
}

/// 把 B 站各种形态的颜色值归一化成 RGB888（丢掉 alpha）。
///
/// 平台的下发格式并不统一：`"#FF7204"`、`"16777215"`、纯数字 `16777215`、
/// 甚至 32 位带 alpha 的值都可能出现。统一截到低 24 位，避免前端拿到
/// 8 位十六进制字符串拼出非法 `#xxxxxxxx`（canvas 会直接不画）。
fn normalize_color(value: &serde_json::Value) -> Option<u32> {
    let raw: u64 = if let Some(text) = value.as_str() {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        match text.strip_prefix('#') {
            Some(hex) => u64::from_str_radix(hex, 16).ok()?,
            None if text.chars().all(|ch| ch.is_ascii_digit()) => text.parse().ok()?,
            None => u64::from_str_radix(text, 16).ok()?,
        }
    } else {
        value.as_u64()?
    };
    let rgb = (raw & 0x00FF_FFFF) as u32;
    // 0 在弹幕里等于「没给颜色」，交给下一层回退。
    (rgb > 0).then_some(rgb)
}

/// 从 `info[15]` 里挖颜色。
///
/// 这一格可能是对象，也可能是「对象序列化成的 JSON 字符串」，
/// 颜色还可能再套一层 `extra` 里，所以按「取 color → 否则递归进 extra」处理。
fn bilibili_color_from_extra(extra: &serde_json::Value) -> Option<u32> {
    let owned;
    let object = match extra {
        serde_json::Value::String(text) => {
            owned = serde_json::from_str::<serde_json::Value>(text).ok()?;
            owned.as_object()?
        }
        serde_json::Value::Object(map) => map,
        _ => return None,
    };
    if let Some(color) = object.get("color").and_then(normalize_color) {
        return Some(color);
    }
    object.get("extra").and_then(bilibili_color_from_extra)
}

/// B 站彩色弹幕 / UP 主自定义色：颜色可能藏在三个地方，按可靠性依次取。
///
/// 1. `info[0][15].extra` —— 平台下发的扩展 JSON（`{"color":"#FF7204",...}`），
///    彩色弹幕与舰长高亮色基本都在这里；
/// 2. `info[0][7]` —— 数值形式的颜色；
/// 3. `info[0][3]` —— 传统字段（普通弹幕是 16777215 白色）。
fn bilibili_extract_color(info: &[serde_json::Value]) -> Option<u32> {
    let meta = info.first()?.as_array()?;
    if let Some(color) = meta.get(15).and_then(bilibili_color_from_extra) {
        return Some(color);
    }
    if let Some(color) = meta.get(7).and_then(normalize_color) {
        return Some(color);
    }
    meta.get(3).and_then(normalize_color)
}

// ---------------------------------------------------------------- 斗鱼

fn run_douyu(extra: &RoomExtra, tx: &Sender<DanmakuMessage>, stop: &AtomicBool) {
    ensure_crypto_provider();
    let RoomExtra::Douyu { rid } = extra else {
        return;
    };
    let host = "danmuproxy.douyu.com";
    let mut attempt = 0;
    while !stop.load(Ordering::Relaxed) && attempt < 3 {
        attempt += 1;
        let port = 8501 + (attempt - 1) % 6;
        match douyu_connect(host, port) {
            Ok(mut socket) => {
                let _ = socket.send(tungstenite::Message::Binary(
                    douyu_packet(&format!("type@=loginreq/roomid@={rid}/")).into(),
                ));
                let _ = socket.send(tungstenite::Message::Binary(
                    douyu_packet(&format!("type@=joingroup/rid@={rid}/gid@=-9999/")).into(),
                ));

                let mut last_heartbeat = std::time::Instant::now();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        let _ = socket.close(None);
                        return;
                    }
                    if last_heartbeat.elapsed() >= Duration::from_secs(40) {
                        let _ = socket.send(tungstenite::Message::Binary(
                            douyu_packet("type@=mrkl/").into(),
                        ));
                        last_heartbeat = std::time::Instant::now();
                    }

                    match socket.read() {
                        Ok(tungstenite::Message::Binary(data)) => douyu_handle(&data, tx),
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(error))
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
            }
            Err(error) => {
                let _ = tx.send(DanmakuMessage::system(format!(
                    "斗鱼弹幕连接失败：{error}"
                )));
            }
        }
        if !sleep_while(stop, Duration::from_secs(3)) {
            return;
        }
    }
}

/// 斗鱼的弹幕服务器只接受系统 TLS（rustls 的套件协商会被拒），
/// 所以这里用 Schannel / Secure Transport 自己包一层，再做 WebSocket 升级。
fn douyu_connect(
    host: &str,
    port: u16,
) -> Result<
    tungstenite::WebSocket<native_tls::TlsStream<std::net::TcpStream>>,
    Box<dyn std::error::Error>,
> {
    use std::net::{TcpStream, ToSocketAddrs};

    let address = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or("无法解析斗鱼弹幕域名")?;
    let tcp = TcpStream::connect(address)?;
    tcp.set_read_timeout(Some(Duration::from_millis(600)))?;
    tcp.set_nodelay(true).ok();

    let tls = native_tls::TlsConnector::new()?.connect(host, tcp)?;
    let (socket, _response) =
        tungstenite::client::client(format!("wss://{host}:{port}/"), tls)?;
    Ok(socket)
}

fn douyu_packet(body: &str) -> Vec<u8> {
    let bytes = body.as_bytes();
    let declared = (bytes.len() + 9) as u32; // 斗鱼把长度声明成 9+body，比实际头短 4
    let mut packet = Vec::with_capacity(bytes.len() + 13);
    packet.extend_from_slice(&declared.to_le_bytes());
    packet.extend_from_slice(&declared.to_le_bytes());
    packet.extend_from_slice(&689u16.to_le_bytes()); // client send to server
    packet.push(0); // encrypted
    packet.push(0); // reserved
    packet.extend_from_slice(bytes);
    packet.push(0);
    packet
}

fn douyu_handle(data: &[u8], tx: &Sender<DanmakuMessage>) {
    if data.len() < 13 {
        return;
    }
    let declared = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
    if declared < 9 || data.len() < declared - 9 + 12 {
        return;
    }
    let body_len = declared - 9;
    let body = &data[12..12 + body_len];
    let Ok(text) = std::str::from_utf8(body) else {
        return;
    };

    for field in text.split('/') {
        if field.is_empty() {
            continue;
        }
        if let Some(value) = field.strip_prefix("type@=")
            && value == "chatmsg"
        {
            let user = stt_value(text, "nn").unwrap_or_default();
            let message = stt_value(text, "txt").unwrap_or_default();
            let color = stt_value(text, "col")
                .and_then(|col| col.parse::<u32>().ok())
                .and_then(douyu_color);
            if !message.is_empty() {
                let _ = tx.send(DanmakuMessage {
                    user,
                    text: message,
                    color,
                    system: false,
                    position: 0,
                    sc: None,
                });
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b站封包头部符合协议() {
        let packet = bilibili_packet(7, vec![b'{', b'}']);
        assert_eq!(packet.len(), 18);
        assert_eq!(u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]), 18);
        assert_eq!(u16::from_be_bytes([packet[4], packet[5]]), 16);
        assert_eq!(u32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]), 7);
    }

    #[test]
    fn b站弹幕json能解析出用户文本与颜色() {
        let json = r#"{"cmd":"DANMU_MSG","info":[[0,1,25,16711680],"你好","[uid]"]}"#;
        let (tx, rx) = channel();
        bilibili_parse_json(json, &tx);
        let messages: Vec<_> = rx.try_iter().collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].user, "");
        assert_eq!(messages[0].text, "你好");
        assert_eq!(messages[0].color, Some(16711680));
        assert_eq!(messages[0].position, 0);
    }

    #[test]
    fn 颜色归一化支持十六进制十进制与alpha截断() {
        use serde_json::json;
        assert_eq!(normalize_color(&json!("#FF7204")), Some(0xFF7204));
        assert_eq!(normalize_color(&json!("16711680")), Some(0xFF0000));
        assert_eq!(normalize_color(&json!(16711680u64)), Some(0xFF0000));
        // 32 位带 alpha 的值截断到低 24 位，否则前端会拼出非法 hex
        assert_eq!(normalize_color(&json!(0xFF11_2233u64)), Some(0x11_2233));
        // 0 视为「没给颜色」，交给下一层回退
        assert_eq!(normalize_color(&json!(0)), None);
        assert_eq!(normalize_color(&json!("")), None);
    }

    #[test]
    fn 颜色优先取扩展字段再回落() {
        use serde_json::json;
        // info[15] 常见形态：JSON 字符串里再套一层 extra
        let extra = json!(r##"{"extra":"{\"color\":\"#FF7204\"}"}"##);
        assert_eq!(bilibili_color_from_extra(&extra), Some(0xFF7204));
        // 直接是对象也认
        assert_eq!(bilibili_color_from_extra(&json!({"color": "#00FF00"})), Some(0x00FF00));

        let mut meta: Vec<serde_json::Value> = vec![serde_json::Value::Null; 16];
        meta[1] = json!(1);
        meta[3] = json!(16777215);
        meta[15] = json!(r##"{"extra":"{\"color\":\"#FF7204\"}"}"##);
        let info = vec![serde_json::Value::Array(meta.clone())];
        assert_eq!(bilibili_extract_color(&info), Some(0xFF7204), "扩展字段优先");

        // 没有扩展字段时用 info[7]
        meta[15] = serde_json::Value::Null;
        meta[7] = json!(0x33_6699u64);
        let info = vec![serde_json::Value::Array(meta.clone())];
        assert_eq!(bilibili_extract_color(&info), Some(0x33_6699));

        // 都没有再回落 info[3]
        meta[7] = serde_json::Value::Null;
        let info = vec![serde_json::Value::Array(meta)];
        assert_eq!(bilibili_extract_color(&info), Some(0xFF_FFFF));
    }

    #[test]
    fn b站固定弹幕和sc能解析() {
        let fixed = r#"{"cmd":"DANMU_MSG","info":[[0,5,25,16777215],"顶部","[uid]"]}"#;
        let (tx, rx) = channel();
        bilibili_parse_json(fixed, &tx);
        let messages: Vec<_> = rx.try_iter().collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].position, 1);

        let sc = r##"{"cmd":"SUPER_CHAT_MESSAGE","data":{"message":"SC 内容","price":30,"background_color":"#111111","background_bottom_color":"#222222","start_time":10,"end_time":20,"user_info":{"uname":"用户","face":"https://example.com/a.jpg"}}}"##;
        let (tx, rx) = channel();
        bilibili_parse_json(sc, &tx);
        let messages: Vec<_> = rx.try_iter().collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "SC 内容");
        assert_eq!(messages[0].sc.as_ref().unwrap().price, 30);
        assert_eq!(messages[0].sc.as_ref().unwrap().avatar, "https://example.com/a.jpg");
    }

    #[test]
    fn 斗鱼封包长度声明是9加正文() {
        let packet = douyu_packet("type@=mrkl/");
        let declared = u32::from_le_bytes([packet[0], packet[1], packet[2], packet[3]]);
        assert_eq!(declared as usize, "type@=mrkl/".len() + 9);
        assert_eq!(packet[12], b't');
        assert_eq!(*packet.last().unwrap(), 0);
    }

    #[test]
    fn 斗鱼chatmsg解析() {
        // 手工拼一个 chatmsg 包
        let body = "type@=chatmsg/nn@=测试用户/txt@=你好世界/col@=1/";
        let mut data = vec![0u8; 12];
        data[0..4].copy_from_slice(&(body.len() as u32 + 9).to_le_bytes());
        data.extend_from_slice(body.as_bytes());
        data.push(0);
        let (tx, rx) = channel();
        douyu_handle(&data, &tx);
        let messages: Vec<_> = rx.try_iter().collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].user, "测试用户");
        assert_eq!(messages[0].text, "你好世界");
        assert_eq!(messages[0].color, Some(0xFF0000));
    }

    #[test]
    fn 未转发时直接丢弃() {
        let (tx, rx) = channel::<DanmakuMessage>();
        let data = {
            let body = "type@=uenter/nn@=某人/";
            let mut data = vec![0u8; 12];
            data[0..4].copy_from_slice(&(body.len() as u32 + 9).to_le_bytes());
            data.extend_from_slice(body.as_bytes());
            data.push(0);
            data
        };
        douyu_handle(&data, &tx);
        assert!(rx.try_iter().next().is_none());
    }
}

/// 斗鱼 STT：`key@=value` 用 `/` 分隔，`@S` 还原成 `/`、`@A` 还原成 `@`。
fn stt_value(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}@=");
    for field in text.split('/') {
        if let Some(value) = field.strip_prefix(&prefix) {
            return Some(value.replace("@S", "/").replace("@A", "@"));
        }
    }
    None
}

/// 斗鱼用颜色编号而不是色值。
fn douyu_color(code: u32) -> Option<u32> {
    match code {
        1 => Some(0xFF0000),
        2 => Some(0x1E87F0),
        3 => Some(0x7AC84B),
        4 => Some(0xFF7F00),
        5 => Some(0x9B39F4),
        6 => Some(0xFF69B4),
        _ => None,
    }
}

// ---------------------------------------------------------------- 虎牙

fn huya_join_packet(ayyuid: u64, top_sid: u64) -> Vec<u8> {
    // 原版 HuyaDanmaku.getJoinData 的 Tars 结构：
    // {0: ayyuid, 1: true, 2:"", 3:"", 4: topSid, 5: sid, 6:0, 7:0}
    let mut args = Writer::new();
    args.int(ayyuid as i64, 0);
    args.int(1, 1);
    args.string("", 2);
    args.string("", 3);
    args.int(top_sid as i64, 4);
    args.int(top_sid as i64, 5);
    args.int(0, 6);
    args.int(0, 7);

    let mut packet = Writer::new();
    packet.int(1, 0);
    packet.bytes(&args.buf, 1);
    packet.buf
}

fn huya_read_sender(reader: &mut Reader<'_>) -> String {
    let mut nickname = String::new();
    while !reader.eof() {
        let Ok((ty, tag)) = reader.head() else {
            break;
        };
        if ty == 11 {
            break;
        }
        match tag {
            2 => nickname = reader.string_with_type(ty).unwrap_or_default(),
            _ => {
                let _ = reader.skip(ty);
            }
        }
    }
    nickname
}

fn huya_read_bullet_color(reader: &mut Reader<'_>) -> u32 {
    let mut color = 0;
    while !reader.eof() {
        let Ok((ty, tag)) = reader.head() else {
            break;
        };
        if ty == 11 {
            break;
        }
        match tag {
            0 => color = reader.int_with_type(ty).unwrap_or(0).max(0) as u32,
            _ => {
                let _ = reader.skip(ty);
            }
        }
    }
    color
}

fn huya_parse_message(data: &[u8], tx: &Sender<DanmakuMessage>) {
    let mut reader = Reader::new(data);
    let mut user = String::new();
    let mut text = String::new();
    let mut color = 0;
    while !reader.eof() {
        let Ok((ty, tag)) = reader.head() else {
            break;
        };
        match tag {
            0 if ty == 10 => user = huya_read_sender(&mut reader),
            3 => text = reader.string_with_type(ty).unwrap_or_default(),
            6 if ty == 10 => color = huya_read_bullet_color(&mut reader),
            _ => {
                let _ = reader.skip(ty);
            }
        }
    }
    if text.is_empty() {
        return;
    }
    // 虎牙默认弹幕色是纯蓝 0x0000FF，不能把整个直播间都染蓝；
    // 白色/无颜色也交给主题文字色。
    let color = if color == 0 || color == 0x00FF_FFFF || color == 0x0000_00FF {
        None
    } else {
        Some(color & 0x00FF_FFFF)
    };
    let _ = tx.send(DanmakuMessage {
        user,
        text,
        color,
        system: false,
        position: 0,
        sc: None,
    });
}

fn huya_handle(data: &[u8], tx: &Sender<DanmakuMessage>) {
    let mut outer = Reader::new(data);
    let Ok((ty, _)) = outer.head() else {
        return;
    };
    if outer.int_with_type(ty).unwrap_or(0) != 7 {
        return;
    }
    let Ok((ty, _)) = outer.head() else {
        return;
    };
    if ty != 13 {
        return;
    }
    let Ok(push_bytes) = outer.bytes_after_head() else {
        return;
    };
    let mut push = Reader::new(&push_bytes);
    let mut uri = 0;
    let mut message = Vec::new();
    while !push.eof() {
        let Ok((ty, tag)) = push.head() else {
            break;
        };
        match tag {
            1 => uri = push.int_with_type(ty).unwrap_or(0),
            2 => message = push.bytes_after_head().unwrap_or_default(),
            _ => {
                let _ = push.skip(ty);
            }
        }
    }
    if uri == 1400 && !message.is_empty() {
        huya_parse_message(&message, tx);
    }
}

fn run_huya(extra: &RoomExtra, tx: &Sender<DanmakuMessage>, stop: &AtomicBool) {
    ensure_crypto_provider();
    let RoomExtra::Huya {
        presenter_uid,
        yyid,
        ..
    } = extra
    else {
        return;
    };
    if *presenter_uid == 0 {
        let _ = tx.send(DanmakuMessage::system("虎牙弹幕参数缺失"));
        return;
    }
    let top_sid = *presenter_uid;
    let ayyuid = if *yyid > 0 { *yyid } else { top_sid };
    let heartbeat = base64::engine::general_purpose::STANDARD
        .decode("ABQdAAwsNgBM")
        .unwrap_or_default();
    let url = "wss://cdnws.api.huya.com";
    let mut attempt = 0;
    while !stop.load(Ordering::Relaxed) && attempt < 3 {
        attempt += 1;
        match tungstenite::connect(url) {
            Ok((mut socket, _)) => {
                if let tungstenite::stream::MaybeTlsStream::Rustls(stream) = socket.get_ref() {
                    let _ = stream
                        .sock
                        .set_read_timeout(Some(Duration::from_millis(600)));
                }
                if socket
                    .send(tungstenite::Message::Binary(
                        huya_join_packet(ayyuid, top_sid).into(),
                    ))
                    .is_err()
                {
                    continue;
                }
                let mut last_heartbeat = std::time::Instant::now();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        let _ = socket.close(None);
                        return;
                    }
                    if last_heartbeat.elapsed() >= Duration::from_secs(60) {
                        let _ = socket.send(tungstenite::Message::Binary(
                            heartbeat.clone().into(),
                        ));
                        last_heartbeat = std::time::Instant::now();
                    }
                    match socket.read() {
                        Ok(tungstenite::Message::Binary(data)) => huya_handle(&data, tx),
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(error))
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
            }
            Err(error) => {
                let _ = tx.send(DanmakuMessage::system(format!(
                    "虎牙弹幕连接失败：{error}"
                )));
            }
        }
        if !sleep_while(stop, Duration::from_secs(3)) {
            return;
        }
    }
}
