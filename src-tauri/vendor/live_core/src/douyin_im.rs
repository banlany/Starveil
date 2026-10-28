//! 抖音弹幕（`webcast/im/push/v2`）。
//!
//! 与另外三站最大的不同：WebSocket 握手必须带 webmssdk 生成的 `signature`，
//! 而那个脚本是 600 KB 的混淆代码，只能在 JS 引擎里跑。本 crate 不内嵌 JS 引擎，
//! 所以签名由 WebView 侧算好后随 `start_danmaku` 传进来（见 `RoomExtra::Douyin`
//! 的 `signature` 字段），这里只负责「拿签名 → 连 → 解 protobuf」。
//!
//! 协议要点（与 dart_simple_live 的 `douyin_danmaku.dart` 对齐）：
//! - 传输单元是 `PushFrame`，其 `payload` 字段是 **gzip 压缩的 `Response`**；
//! - 进房后要按时发 `payloadType="hb"` 的空帧保活，服务端 `needAck` 时要回
//!   `payloadType="ack"` 且把 `internalExt` 原样塞进 payload；
//! - `Response.cursor` 是重连游标，必须延续上一次的，否则会重放一堆历史弹幕。

use crate::danmaku::{
    DanmakuMessage, StatusSink, next_backoff, set_read_timeout, should_report, sleep_while,
};
use crate::model::RoomExtra;
use std::io::Read;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;

/// 抖音下发的用户 ID 为空时也能连（服务端只把它当匿名标识），这里给一个稳定的假值。
const ANONYMOUS_USER_ID: &str = "7000000000000000000";

fn ensure_crypto_provider() {
    // tungstenite 的 rustls 没带默认 CryptoProvider，进程内装一次即可。
    crate::danmaku::ensure_crypto_provider();
}

// ---------------------------------------------------------------- protobuf 读取

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        let mut shift = 0u32;
        loop {
            let byte = *self.data.get(self.pos)?;
            self.pos += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
            shift += 7;
            if shift >= 64 {
                return None;
            }
        }
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let length = self.varint()? as usize;
        let end = self.pos.checked_add(length)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    fn skip(&mut self, wire: u8) -> Option<()> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => {
                self.pos = self.pos.checked_add(8)?;
            }
            2 => {
                self.bytes()?;
            }
            5 => {
                self.pos = self.pos.checked_add(4)?;
            }
            _ => return None,
        }
        (self.pos <= self.data.len()).then_some(())
    }

    /// 读到下一个字段头 `(字段号, wire type)`，读完返回 None。
    fn header(&mut self) -> Option<(u32, u8)> {
        let key = self.varint()?;
        Some(((key >> 3) as u32, (key & 0x07) as u8))
    }

    fn string(&mut self) -> Option<String> {
        Some(String::from_utf8_lossy(self.bytes()?).to_string())
    }
}

fn read_varint_field(reader: &mut Reader<'_>, wire: u8) -> Option<u64> {
    match wire {
        0 => reader.varint(),
        2 => {
            // 有些字段既可能是 varint 也可能是打包后的 bytes，兜底解析一次。
            let raw = reader.bytes()?;
            Reader::new(raw).varint()
        }
        _ => {
            reader.skip(wire)?;
            None
        }
    }
}

// ---------------------------------------------------------------- protobuf 写入

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn write_tag(out: &mut Vec<u8>, field: u32, wire: u8) {
    write_varint(out, (u64::from(field) << 3) | u64::from(wire));
}

fn write_bytes_field(out: &mut Vec<u8>, field: u32, value: &[u8]) {
    write_tag(out, field, 2);
    write_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

/// 心跳 / 进房帧：`PushFrame{ payloadType: "hb" }`。
fn heartbeat_frame() -> Vec<u8> {
    let mut out = Vec::new();
    write_bytes_field(&mut out, 7, b"hb");
    out
}

/// 收到 `needAck` 的推送后必须回执，否则服务端会在几十秒后掐断。
fn ack_frame(log_id: u64, internal_ext: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    write_tag(&mut out, 2, 0);
    write_varint(&mut out, log_id);
    write_bytes_field(&mut out, 7, b"ack");
    write_bytes_field(&mut out, 8, internal_ext);
    out
}

// ---------------------------------------------------------------- 业务消息

/// `PushFrame` 解出来的三个字段。
struct Frame {
    log_id: u64,
    payload_type: String,
    payload: Vec<u8>,
}

fn parse_frame(data: &[u8]) -> Option<Frame> {
    let mut reader = Reader::new(data);
    let mut frame = Frame {
        log_id: 0,
        payload_type: String::new(),
        payload: Vec::new(),
    };
    while let Some((field, wire)) = reader.header() {
        match (field, wire) {
            (2, _) => frame.log_id = read_varint_field(&mut reader, wire).unwrap_or(0),
            (7, 2) => frame.payload_type = reader.string()?,
            (8, 2) => frame.payload = reader.bytes()?.to_vec(),
            _ => reader.skip(wire)?,
        }
    }
    Some(frame)
}

struct ResponseMeta {
    internal_ext: Vec<u8>,
    need_ack: bool,
    /// `Response.cursor`，为带历史消息的回执游标，重连时要延续。
    cursor: String,
}

/// `Response` 里的 `Message`：method + 载荷。
fn parse_response(data: &[u8]) -> (ResponseMeta, Vec<(String, Vec<u8>)>) {
    let mut response = ResponseMeta {
        internal_ext: Vec::new(),
        need_ack: false,
        cursor: String::new(),
    };
    let mut messages = Vec::new();
    let mut reader = Reader::new(data);
    while let Some((field, wire)) = reader.header() {
        match (field, wire) {
            (1, 2) => {
                let Some(raw) = reader.bytes() else { break };
                if let Some(message) = parse_message(raw) {
                    messages.push(message);
                }
            }
            (2, 2) => response.cursor = reader.string().unwrap_or_default(),
            (5, 2) => response.internal_ext = reader.bytes().unwrap_or_default().to_vec(),
            (9, _) => response.need_ack = read_varint_field(&mut reader, wire).unwrap_or(0) != 0,
            _ => {
                if reader.skip(wire).is_none() {
                    break;
                }
            }
        }
    }
    (response, messages)
}

fn parse_message(data: &[u8]) -> Option<(String, Vec<u8>)> {
    let mut method = String::new();
    let mut payload = Vec::new();
    let mut reader = Reader::new(data);
    while let Some((field, wire)) = reader.header() {
        match (field, wire) {
            (1, 2) => method = reader.string()?,
            (2, 2) => payload = reader.bytes()?.to_vec(),
            _ => reader.skip(wire)?,
        }
    }
    (!method.is_empty()).then_some((method, payload))
}

/// `ChatMessage{ user.nickName, content }`。
fn parse_chat(data: &[u8]) -> Option<(String, String)> {
    let mut reader = Reader::new(data);
    let mut user = String::new();
    let mut content = String::new();
    let mut rtf_text = String::new();
    while let Some((field, wire)) = reader.header() {
        match (field, wire) {
            (2, 2) => user = parse_user(reader.bytes()?).unwrap_or_default(),
            (3, 2) => content = reader.string()?,
            // rtfContent：图文混排版本，正文为空时从它的文本片段里拼一段出来。
            (22, 2) => rtf_text = parse_rtf_text(reader.bytes()?),
            _ => reader.skip(wire)?,
        }
    }
    let text = if content.trim().is_empty() {
        rtf_text.trim().to_string()
    } else {
        content
    };
    (!text.is_empty()).then_some((user, text))
}

/// `User.nickName` 是字段 3。
fn parse_user(data: &[u8]) -> Option<String> {
    let mut reader = Reader::new(data);
    while let Some((field, wire)) = reader.header() {
        match (field, wire) {
            (3, 2) => return reader.string(),
            _ => reader.skip(wire)?,
        }
    }
    None
}

/// `Text.piecesList[].stringValue`：只取纯文本片段，表情图（`imageValue`）跳过。
fn parse_rtf_text(data: &[u8]) -> String {
    let mut reader = Reader::new(data);
    let mut text = String::new();
    while let Some((field, wire)) = reader.header() {
        match (field, wire) {
            (4, 2) => {
                let Some(piece) = reader.bytes() else { break };
                let mut piece_reader = Reader::new(piece);
                while let Some((piece_field, piece_wire)) = piece_reader.header() {
                    match (piece_field, piece_wire) {
                        (3, 2) => {
                            text.push_str(&piece_reader.string().unwrap_or_default());
                        }
                        _ => {
                            if piece_reader.skip(piece_wire).is_none() {
                                break;
                            }
                        }
                    }
                }
            }
            _ => {
                if reader.skip(wire).is_none() {
                    break;
                }
            }
        }
    }
    text
}

fn gunzip(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut decoder = flate2::read::GzDecoder::new(data);
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

// ---------------------------------------------------------------- 连接

fn build_url(room_id: &str, user_id: &str, signature: &str, cursor: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let cursor = if cursor.is_empty() {
        format!("h-1_t-{now}_r-1_d-1_u-1")
    } else {
        cursor.to_string()
    };
    let pairs: [(&str, &str); 31] = [
        ("app_name", "douyin_web"),
        ("version_code", "180800"),
        ("webcast_sdk_version", "1.3.0"),
        ("update_version_code", "1.3.0"),
        ("compress", "gzip"),
        ("resp_content_type", "protobuf"),
        ("cursor", cursor.as_str()),
        ("host", "https://live.douyin.com"),
        ("aid", "6383"),
        ("live_id", "1"),
        ("did_rule", "3"),
        ("debug", "false"),
        ("maxCacheMessageNumber", "20"),
        ("endpoint", "live_pc"),
        ("support_wrds", "1"),
        ("im_path", "/webcast/im/fetch/"),
        ("user_unique_id", user_id),
        ("device_platform", "web"),
        ("cookie_enabled", "true"),
        ("screen_width", "1920"),
        ("screen_height", "1080"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("browser_name", "Mozilla"),
        ("browser_version", "125.0.0.0"),
        ("browser_online", "true"),
        ("tz_name", "Asia/Shanghai"),
        ("identity", "audience"),
        ("room_id", room_id),
        ("heartbeatDuration", "0"),
        ("signature", signature),
    ];
    let query = pairs
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                key,
                percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("wss://webcast3-ws-web-lq.douyin.com/webcast/im/push/v2/?{query}")
}

pub(crate) fn run(
    extra: &RoomExtra,
    tx: &Sender<DanmakuMessage>,
    status: &StatusSink,
    stop: &AtomicBool,
) {
    ensure_crypto_provider();
    let RoomExtra::Douyin {
        room_id,
        web_rid,
        cookie,
        signature,
        user_id,
        ..
    } = extra
    else {
        status.unsupported("抖音弹幕参数缺失，已跳过弹幕");
        return;
    };
    if signature.trim().is_empty() {
        // 聊天栏顶部的状态条会显示这句话，不需要再往聊天记录里塞一条系统消息。
        status.failed("抖音弹幕需要签名，但这次没有拿到（签名脚本未加载或被风控拦截）");
        return;
    }
    let user_id = if user_id.trim().is_empty() {
        ANONYMOUS_USER_ID
    } else {
        user_id.as_str()
    };
    let referer = format!("https://live.douyin.com/{web_rid}");

    let mut cursor = String::new();
    let mut backoff = crate::danmaku::RECONNECT_MIN;
    let mut failures = 0u32;
    status.connecting("正在连接抖音弹幕服务器…");

    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let url = build_url(room_id, user_id, signature.trim(), &cursor);
        let mut request = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                status.failed(format!("抖音弹幕地址无效：{error}"));
                return;
            }
        };
        for (key, value) in [
            ("Cookie", cookie.as_str()),
            (
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            ),
            ("Origin", "https://live.douyin.com"),
            ("Referer", referer.as_str()),
            ("Accept", "application/json, text/plain, */*"),
            ("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8"),
            ("Cache-Control", "no-cache"),
            ("Pragma", "no-cache"),
        ] {
            if let Ok(value) = tungstenite::http::HeaderValue::from_str(value) {
                request.headers_mut().insert(key, value);
            }
        }

        match tungstenite::connect(request) {
            Ok((mut socket, _)) => {
                backoff = crate::danmaku::RECONNECT_MIN;
                failures = 0;
                set_read_timeout(&mut socket);
                status.connected("抖音弹幕已连接");
                let _ = socket.send(tungstenite::Message::Binary(heartbeat_frame().into()));

                let mut last_heartbeat = Instant::now();
                loop {
                    if stop.load(std::sync::atomic::Ordering::Relaxed) {
                        let _ = socket.close(None);
                        return;
                    }
                    if last_heartbeat.elapsed() >= Duration::from_secs(10) {
                        let _ = socket.send(tungstenite::Message::Binary(heartbeat_frame().into()));
                        last_heartbeat = Instant::now();
                    }
                    match socket.read() {
                        Ok(tungstenite::Message::Binary(data)) => {
                            handle_frame(&data, tx, &mut socket, &mut cursor);
                        }
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(error))
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                            break;
                        }
                        Err(_) => break,
                    }
                }
                failures += 1;
                if !stop.load(std::sync::atomic::Ordering::Relaxed) && failures == 1 {
                    status.connecting("抖音弹幕已断开，正在重连…");
                }
            }
            Err(error) => {
                failures += 1;
                if should_report(failures) {
                    status.failed(format!("抖音弹幕连接失败：{error}"));
                }
            }
        }
        if !sleep_while(stop, backoff) {
            return;
        }
        backoff = next_backoff(backoff);
    }
}

fn handle_frame(
    data: &[u8],
    tx: &Sender<DanmakuMessage>,
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    cursor: &mut String,
) {
    let Some(frame) = parse_frame(data) else { return };
    if frame.payload.is_empty() {
        return;
    }
    let payload = if frame.payload.starts_with(&[0x1f, 0x8b]) {
        match gunzip(&frame.payload) {
            Some(raw) => raw,
            None => return,
        }
    } else {
        frame.payload.clone()
    };
    let (response, messages) = parse_response(&payload);
    if response.need_ack {
        let _ = socket.send(tungstenite::Message::Binary(
            ack_frame(frame.log_id, &response.internal_ext).into(),
        ));
    }
    if !response.cursor.is_empty() {
        cursor.clone_from(&response.cursor);
    }
    for (method, body) in messages {
        match method.as_str() {
            "WebcastChatMessage" => {
                if let Some((user, text)) = parse_chat(&body) {
                    let _ = tx.send(DanmakuMessage::chat(user, text));
                }
            }
            // 其余（礼物、进场、点赞、在线人数）这一版都不渲染：
            // 聊天栏只保留真正的对话，避免刷屏。在线人数用房间头里的那份。
            _ => {}
        }
    }
}
