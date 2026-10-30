//! 局域网同步：UDP 广播发现 + 本机 HTTP 服务，同一 Wi-Fi 下的星幕直播互相收发配置包。
//!
//! 做法照搬 dart_simple_live：一端广播 `{"type":"hello"}`，收到的设备回一份自己的信息，
//! 双方各自记下对方的 IP，之后用 HTTP 交换数据。区别只有两点：
//!
//! 1. **数据包是谁的就是谁的**：Rust 侧不解析同步包内容，只负责搬运一份 JSON 文本。
//!    打包（`buildBundle`）与合并（`importData`）都在前端做——数据本来就住在 WebView 的
//!    localStorage 里，后端如果也去解析一遍，就等于维护两套数据结构。
//! 2. **端口用 23244/23245**，避开 dart 版（23234/23235）。两边的包格式不兼容，
//!    端口错开可以避免「连上了但导入失败」这种更难看的状态。
//!
//! 传输面只有局域网内的明文本机服务，不做鉴权：它只在用户主动打开「数据同步」页时
//! 才启动，收到数据也要用户在弹窗里点「应用」才会覆盖本机。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

/// HTTP 交换同步包用（对方来拉，或推给对方）。
pub const HTTP_PORT: u16 = 23244;
/// UDP 发现广播用。
pub const UDP_PORT: u16 = 23245;

const APP_NAME: &str = "星幕直播 Starveil";
const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(3);
/// 超过这个时间没再收到广播就把对方从列表里去掉（广播每 3 秒一次）。
const PEER_TTL: Duration = Duration::from_secs(16);
/// 同步包上限：关注几百个、统计几百个主播也就几 MB，16MB 足够挡住乱发的包。
const MAX_BODY: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub app: String,
    pub platform: String,
    pub version: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub address: String,
    pub port: u16,
    pub version: String,
    /// 秒级时间戳，前端只用来显示「刚刚 / 12 秒前」。
    pub last_seen: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct InboxItem {
    pub from: String,
    pub address: String,
    pub received_at: u64,
    pub bytes: usize,
    pub payload: String,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub running: bool,
    pub device: DeviceInfo,
    pub http_port: u16,
    pub udp_port: u16,
    pub addresses: Vec<String>,
    /// 本机这份同步包是什么时候交给后端的（秒级时间戳）；`None` 表示还没发布过。
    pub published_at: Option<u64>,
    /// 启动失败的原因（端口被占用最常见），前端直接显示出来。
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PushResult {
    pub bytes: usize,
}

struct Bundle {
    content: String,
    updated_at: u64,
}

#[derive(Default)]
struct Inner {
    /// 本机准备好给对方拉取的数据（前端 `buildBundle()` 的原文）。
    bundle: Option<Bundle>,
    /// 收到还没被前端取走的包。
    inbox: Vec<InboxItem>,
    peers: HashMap<String, Peer>,
}

pub struct LanSync {
    device: DeviceInfo,
    inner: Mutex<Inner>,
    running: AtomicBool,
    error: Mutex<Option<String>>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

impl LanSync {
    /// `name` 是显示给对端看的设备名（Windows 取计算机名，安卓取机型）。
    pub fn new(name: String, platform: String) -> Self {
        // 设备 id 只用来区分「谁在广播」：自己发的 hello 会从自己的 socket 里回来，
        // 靠它过滤。随机生成即可，进程重启换一个新 id 不影响使用。
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let id = format!("{:x}{:x}", nanos, std::process::id());
        Self {
            device: DeviceInfo {
                id,
                name,
                app: APP_NAME.to_string(),
                platform,
                version: env!("CARGO_PKG_VERSION").to_string(),
                port: HTTP_PORT,
            },
            inner: Mutex::new(Inner::default()),
            running: AtomicBool::new(false),
            error: Mutex::new(None),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 启动 HTTP 服务与 UDP 发现。重复调用是安全的（已在跑就直接返回）。
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        let listener = TcpListener::bind(("0.0.0.0", HTTP_PORT))
            .map_err(|error| port_error(&error, HTTP_PORT, "局域网同步服务"))?;
        let udp = UdpSocket::bind(("0.0.0.0", UDP_PORT))
            .map_err(|error| port_error(&error, UDP_PORT, "局域网发现服务"))?;
        // 广播和接收共用一个 socket：自己的 hello 也会回到自己手里，
        // `on_datagram` 会按设备 id 丢掉，不用另开一个发送 socket。
        let _ = udp.set_broadcast(true);
        let _ = udp.set_read_timeout(Some(Duration::from_millis(700)));
        let _ = listener.set_nonblocking(true);

        self.running.store(true, Ordering::SeqCst);
        *self.error.lock().unwrap() = None;

        let http_sync = self.clone();
        thread::spawn(move || http_sync.serve(listener));
        let udp_sync = self.clone();
        thread::spawn(move || udp_sync.discover(udp));
        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        *self.inner.lock().unwrap() = Inner::default();
    }

    pub fn status(&self) -> Status {
        Status {
            running: self.is_running(),
            device: self.device.clone(),
            http_port: HTTP_PORT,
            udp_port: UDP_PORT,
            addresses: local_addresses(),
            published_at: self.inner.lock().unwrap().bundle.as_ref().map(|item| item.updated_at),
            error: self.error.lock().unwrap().clone(),
        }
    }

    /// 前端把最新的同步包交过来，别的设备来拉时拿到的就是它。
    pub fn publish(&self, content: String) -> Result<usize, String> {
        if content.len() > MAX_BODY {
            return Err("同步包太大，已拒绝发布".to_string());
        }
        if serde_json::from_str::<Value>(&content).is_err() {
            return Err("同步包不是合法 JSON".to_string());
        }
        let bytes = content.len();
        self.inner.lock().unwrap().bundle = Some(Bundle {
            content,
            updated_at: now_secs(),
        });
        Ok(bytes)
    }

    /// 取走尚未处理的包（取走即清空，避免前端每轮轮询都重复弹窗）。
    pub fn take_inbox(&self) -> Vec<InboxItem> {
        std::mem::take(&mut self.inner.lock().unwrap().inbox)
    }

    pub fn peers(&self) -> Vec<Peer> {
        let mut inner = self.inner.lock().unwrap();
        let now = now_secs();
        inner
            .peers
            .retain(|_, peer| now.saturating_sub(peer.last_seen) <= PEER_TTL.as_secs());
        let mut list: Vec<Peer> = inner.peers.values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    // ------------------------------------------------------------ HTTP 服务

    fn serve(self: Arc<Self>, listener: TcpListener) {
        while self.is_running() {
            match listener.accept() {
                Ok((stream, _)) => {
                    let sync = self.clone();
                    thread::spawn(move || sync.handle(stream));
                }
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(120));
                }
                Err(_) => thread::sleep(Duration::from_millis(200)),
            }
        }
    }

    fn handle(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(6)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(6)));
        let Some((method, path, body)) = read_request(&mut stream) else {
            return;
        };
        match (method.as_str(), path.as_str()) {
            // 浏览器里直接打开 http://<ip>:23244 也能看到服务在跑，方便排查。
            ("GET", "/") => respond(
                &mut stream,
                200,
                "OK",
                &json!({
                    "status": true,
                    "message": "starveil lan sync is running",
                    "app": APP_NAME,
                    "version": env!("CARGO_PKG_VERSION"),
                    "platform": self.device.platform,
                })
                .to_string(),
            ),
            ("GET", "/info") => respond(&mut stream, 200, "OK", &device_json(&self.device)),
            ("GET", "/sync/bundle") => {
                let bundle = self.inner.lock().unwrap().bundle.as_ref().map(|item| item.content.clone());
                match bundle {
                    Some(content) => respond(&mut stream, 200, "OK", &content),
                    None => respond(
                        &mut stream,
                        409,
                        "Conflict",
                        &json!({
                            "status": false,
                            "message": "对方还没有准备好数据，请让对方停留在「数据同步」页面",
                        })
                        .to_string(),
                    ),
                }
            }
            ("POST", "/sync/bundle") => {
                let size = body.len();
                let text = match String::from_utf8(body) {
                    Ok(text) => text,
                    Err(_) => {
                        respond(
                            &mut stream,
                            400,
                            "Bad Request",
                            r#"{"status":false,"message":"同步包不是 UTF-8 文本"}"#,
                        );
                        return;
                    }
                };
                if serde_json::from_str::<Value>(&text).is_err() {
                    respond(
                        &mut stream,
                        400,
                        "Bad Request",
                        r#"{"status":false,"message":"同步包不是合法 JSON"}"#,
                    );
                    return;
                }
                let from = peer_name(&stream);
                let mut inner = self.inner.lock().unwrap();
                inner.inbox.push(InboxItem {
                    from,
                    address: peer_address(&stream),
                    received_at: now_secs(),
                    bytes: size,
                    payload: text,
                });
                // 只留最近 8 份，正常用不到这么多，纯粹防止对端狂发把内存吃满。
                let extra = inner.inbox.len().saturating_sub(8);
                if extra > 0 {
                    inner.inbox.drain(0..extra);
                }
                drop(inner);
                respond(
                    &mut stream,
                    200,
                    "OK",
                    &json!({ "status": true, "bytes": size }).to_string(),
                );
            }
            _ => respond(
                &mut stream,
                404,
                "Not Found",
                r#"{"status":false,"message":"没有这个接口"}"#,
            ),
        }
    }

    // ------------------------------------------------------------ UDP 发现

    fn discover(self: Arc<Self>, socket: UdpSocket) {
        // 起来先喊一嗓子，别等第一个 3 秒周期。
        self.announce(&socket);
        let mut last_announce = Instant::now();
        let mut buffer = [0u8; 4096];
        while self.is_running() {
            if last_announce.elapsed() >= ANNOUNCE_INTERVAL {
                self.announce(&socket);
                last_announce = Instant::now();
            }
            match socket.recv_from(&mut buffer) {
                Ok((len, from)) => self.on_datagram(&socket, &buffer[..len], from),
                Err(ref error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                // 其它错误（网卡切换、接口没了）等一下再来，别把线程打死。
                Err(_) => thread::sleep(Duration::from_millis(300)),
            }
        }
    }

    fn announce(&self, socket: &UdpSocket) {
        let payload = json!({
            "id": self.device.id,
            "type": "hello",
            "name": self.device.name,
            "platform": self.device.platform,
            "version": self.device.version,
        })
        .to_string();
        let target = SocketAddr::from(([255, 255, 255, 255], UDP_PORT));
        let _ = socket.send_to(payload.as_bytes(), target);
    }

    fn on_datagram(&self, socket: &UdpSocket, data: &[u8], from: SocketAddr) {
        let Ok(value) = serde_json::from_slice::<Value>(data) else {
            return;
        };
        let id = value["id"].as_str().unwrap_or("").to_string();
        // 空 id 或者自己的回声都直接丢：不做这个判断，自己的广播会让自己
        // 无限「发现」自己，并在列表里堆出一条本机设备。
        if id.is_empty() || id == self.device.id {
            return;
        }
        let kind = value["type"].as_str().unwrap_or("");
        if kind == "hello" {
            // 有人在找伴，把自己的信息回给它（单播回去，不用再广播一次）。
            let reply = device_json(&self.device);
            let _ = socket.send_to(reply.as_bytes(), from);
            return;
        }
        // 其余消息都当成对端的信息：地址以数据包来源为准——能收到就说明这条路通。
        let address = from.ip().to_string();
        let port = value["port"]
            .as_u64()
            .map(|value| value as u16)
            .filter(|port| *port > 0)
            .unwrap_or(HTTP_PORT);
        let peer = Peer {
            id: id.clone(),
            name: value["name"].as_str().unwrap_or("未知设备").to_string(),
            platform: value["platform"].as_str().unwrap_or(kind).to_string(),
            address,
            port,
            version: value["version"].as_str().unwrap_or("").to_string(),
            last_seen: now_secs(),
        };
        self.inner.lock().unwrap().peers.insert(id, peer);
    }
}

fn device_json(device: &DeviceInfo) -> String {
    json!({
        "id": device.id,
        "type": device.platform,
        "name": device.name,
        "platform": device.platform,
        "app": device.app,
        "version": device.version,
        "port": device.port,
    })
    .to_string()
}

/// 把 socket 的对端地址拼成 `ip:port`，写在收到的包里方便前端显示来源。
fn peer_address(stream: &TcpStream) -> String {
    stream
        .peer_addr()
        .map(|addr| format!("{}:{}", addr.ip(), addr.port()))
        .unwrap_or_default()
}

/// 对端 IP（不带端口）。推送方没在包里带名字，就显示它的 IP。
fn peer_name(stream: &TcpStream) -> String {
    stream
        .peer_addr()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "局域网设备".to_string())
}

fn port_error(error: &std::io::Error, port: u16, what: &str) -> String {
    if error.kind() == std::io::ErrorKind::AddrInUse {
        format!("{port} 端口已被占用：请关闭另一个星幕直播窗口或占用该端口的程序后重试")
    } else {
        format!("{what}启动失败：{error}")
    }
}

/// 本机在局域网里的 IPv4 地址。
///
/// 用「连一个外网 UDP 地址」的经典技巧拿默认路由的出口 IP：UDP 的 connect 不发包，
/// 只是让系统选一条路由，因此断网/被墙都不影响（拿不到就返回空，前端提示手动填地址）。
fn local_addresses() -> Vec<String> {
    let mut list = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("223.5.5.5:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" {
                    list.push(ip);
                }
            }
        }
    }
    list
}

// ---------------------------------------------------------------- HTTP 解析

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 读一个完整的 HTTP 请求：请求行 + 头（按 Content-Length 读包体）。
fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(position) = find_subsequence(&buffer, b"\r\n\r\n") {
            break position;
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return None;
    }

    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    // 查询串不参与路由（局域网接口没有参数，留着只是为了别被 `?t=1` 打挂）。
    let path = parts
        .next()
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();
    Some((method, path, body))
}

fn respond(stream: &mut TcpStream, code: u16, reason: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

// ---------------------------------------------------------------- 客户端

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(5))
        // 局域网里没有证书这回事，走的是明文 http://<ip>:23244。
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
}

fn base_url(address: &str, port: u16) -> String {
    let host = address.trim().trim_start_matches("http://").trim_end_matches('/');
    if host.is_empty() {
        return String::new();
    }
    format!("http://{host}:{port}")
}

fn explain(error: reqwest::Error, url: &str) -> String {
    if error.is_timeout() {
        return format!("{url} 超时：确认两台设备在同一 Wi-Fi，且对方没有锁屏退出");
    }
    if error.is_connect() {
        return format!("连不上 {url}：对方可能已经离开「数据同步」页面，或端口被系统防火墙拦了");
    }
    format!("请求 {url} 失败：{error}")
}

/// 拉取对端准备好的同步包（原文 JSON 文本）。
pub fn pull(address: &str, port: u16) -> Result<String, String> {
    let base = base_url(address, port);
    if base.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let url = format!("{base}/sync/bundle");
    let client = build_client()?;
    let response = client.get(&url).send().map_err(|error| explain(error, &url))?;
    let status = response.status().as_u16();
    let text = response.text().map_err(|error| format!("读取响应失败：{error}"))?;
    if status == 409 {
        return Err("对方还没有准备好数据，请让对方停留在「数据同步」页面".to_string());
    }
    if !(200..300).contains(&status) {
        return Err(format!("对方返回 {status}：{text}"));
    }
    if serde_json::from_str::<Value>(&text).is_err() {
        return Err("对方返回的内容不是合法的同步包".to_string());
    }
    Ok(text)
}

/// 把本机同步包推给对端（对端收到后由用户确认是否应用）。
pub fn push(address: &str, port: u16, content: &str) -> Result<PushResult, String> {
    let base = base_url(address, port);
    if base.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let url = format!("{base}/sync/bundle");
    let client = build_client()?;
    let response = client
        .post(&url)
        .header("Content-Type", "application/json; charset=utf-8")
        .body(content.to_string())
        .send()
        .map_err(|error| explain(error, &url))?;
    let status = response.status().as_u16();
    let text = response.text().map_err(|error| format!("读取响应失败：{error}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("对方拒绝了这次发送（{status}）：{text}"));
    }
    Ok(PushResult {
        bytes: content.len(),
    })
}

/// 手动填地址时先问一句「你是谁」，确认对方真的是星幕直播。
pub fn probe(address: &str, port: u16) -> Result<Peer, String> {
    let base = base_url(address, port);
    if base.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let url = format!("{base}/info");
    let client = build_client()?;
    let response = client.get(&url).send().map_err(|error| explain(error, &url))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("对方返回 {status}，可能不是星幕直播的同步服务"));
    }
    let value: Value = response
        .json()
        .map_err(|error| format!("对方信息无法解析：{error}"))?;
    let id = value["id"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return Err("对方不是星幕直播的同步服务（缺少设备标识）".to_string());
    }
    Ok(Peer {
        id,
        name: value["name"].as_str().unwrap_or("未知设备").to_string(),
        platform: value["platform"].as_str().unwrap_or("").to_string(),
        address: address.trim().trim_start_matches("http://").to_string(),
        port,
        version: value["version"].as_str().unwrap_or("").to_string(),
        last_seen: now_secs(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 起一个只服务一次请求的临时监听器，用真实 socket 走完「解析请求 → 路由 → 回包」。
    fn serve_once(sync: &Arc<LanSync>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定端口失败");
        let port = listener.local_addr().expect("读取端口失败").port();
        let sync = sync.clone();
        thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                sync.handle(stream);
            }
        });
        port
    }

    fn new_sync() -> Arc<LanSync> {
        Arc::new(LanSync::new("测试机".to_string(), "windows".to_string()))
    }

    #[test]
    fn serves_device_info() {
        let sync = new_sync();
        let port = serve_once(&sync);
        let value: Value = reqwest::blocking::get(format!("http://127.0.0.1:{port}/info"))
            .expect("请求失败")
            .json()
            .expect("解析失败");
        assert_eq!(value["name"], "测试机");
        assert_eq!(value["platform"], "windows");
        assert_eq!(value["port"], HTTP_PORT);
        assert!(!value["id"].as_str().unwrap_or("").is_empty());
    }

    #[test]
    fn accepts_and_serves_bundle() {
        let sync = new_sync();
        let port = serve_once(&sync);
        let body = r#"{"version":2,"follow":[{"platform":"bilibili","roomId":"1"}]}"#;
        let response = reqwest::blocking::Client::new()
            .post(format!("http://127.0.0.1:{port}/sync/bundle"))
            .body(body)
            .send()
            .expect("推送失败");
        assert_eq!(response.status().as_u16(), 200);
        let inbox = sync.take_inbox();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].payload, body);
        assert_eq!(inbox[0].bytes, body.len());
        // 取走即清空，下一次轮询不会重复弹窗。
        assert!(sync.take_inbox().is_empty());

        // 本机发布后，别人来拉应该拿到同一份内容。
        sync.publish(body.to_string()).expect("发布失败");
        let port = serve_once(&sync);
        let text = reqwest::blocking::get(format!("http://127.0.0.1:{port}/sync/bundle"))
            .expect("拉取失败")
            .text()
            .expect("读取失败");
        assert_eq!(text, body);
    }

    #[test]
    fn rejects_broken_payload() {
        let sync = new_sync();
        let port = serve_once(&sync);
        let response = reqwest::blocking::Client::new()
            .post(format!("http://127.0.0.1:{port}/sync/bundle"))
            .body("not json")
            .send()
            .expect("推送失败");
        assert_eq!(response.status().as_u16(), 400);
        assert!(sync.take_inbox().is_empty());
        assert!(sync.publish("{oops".to_string()).is_err());
    }

    #[test]
    fn reports_not_ready_when_bundle_missing() {
        let sync = new_sync();
        let port = serve_once(&sync);
        let response = reqwest::blocking::get(format!("http://127.0.0.1:{port}/sync/bundle")).expect("请求失败");
        assert_eq!(response.status().as_u16(), 409);
        assert!(response.text().unwrap().contains("还没有准备好"));
    }

    #[test]
    fn hello_gets_answered_with_device_info() {
        let sync = new_sync();
        let ours = UdpSocket::bind("127.0.0.1:0").expect("绑定失败");
        let theirs = UdpSocket::bind("127.0.0.1:0").expect("绑定失败");
        theirs
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("设置超时失败");

        let hello = json!({ "id": "peer-1", "type": "hello" }).to_string();
        theirs
            .send_to(hello.as_bytes(), ours.local_addr().unwrap())
            .expect("发送失败");
        let mut buffer = [0u8; 1024];
        let (len, from) = ours.recv_from(&mut buffer).expect("接收失败");
        sync.on_datagram(&ours, &buffer[..len], from);

        let (len, _) = theirs.recv_from(&mut buffer).expect("没收到回复");
        let reply: Value = serde_json::from_slice(&buffer[..len]).expect("回复不是 JSON");
        assert_eq!(reply["name"], "测试机");
        assert_eq!(reply["port"], HTTP_PORT);

        // 收到对端信息后要进列表；自己的广播则必须被丢掉。
        let info = json!({
            "id": "peer-1",
            "type": "windows",
            "name": "客厅电脑",
            "platform": "windows",
            "version": "0.6.2",
            "port": HTTP_PORT,
        })
        .to_string();
        let from: SocketAddr = format!("127.0.0.1:{}", theirs.local_addr().unwrap().port())
            .parse()
            .unwrap();
        sync.on_datagram(&ours, info.as_bytes(), from);
        let peers = sync.peers();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].name, "客厅电脑");
        assert_eq!(peers[0].port, HTTP_PORT);

        let own = json!({ "id": sync.device.id, "type": "hello" }).to_string();
        sync.on_datagram(&ours, own.as_bytes(), from);
        assert_eq!(sync.peers().len(), 1);
    }

    #[test]
    fn request_with_query_string_still_routes() {
        let sync = new_sync();
        let port = serve_once(&sync);
        let response =
            reqwest::blocking::get(format!("http://127.0.0.1:{port}/info?t=1")).expect("请求失败");
        assert_eq!(response.status().as_u16(), 200);
    }
}
