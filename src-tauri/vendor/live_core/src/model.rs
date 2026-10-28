use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 支持的直播平台。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum Platform {
    Bilibili,
    Douyu,
    Huya,
    Douyin,
    Kuaishou,
}

impl Platform {
    /// UI 顺序：先 B 站，再斗鱼、虎牙，最后是抖音、快手。
    pub const ALL: [Platform; 5] = [
        Platform::Bilibili,
        Platform::Douyu,
        Platform::Huya,
        Platform::Douyin,
        Platform::Kuaishou,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Platform::Bilibili => "bilibili",
            Platform::Douyu => "douyu",
            Platform::Huya => "huya",
            Platform::Douyin => "douyin",
            Platform::Kuaishou => "kuaishou",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Platform::Bilibili => "哔哩哔哩",
            Platform::Douyu => "斗鱼",
            Platform::Huya => "虎牙",
            Platform::Douyin => "抖音",
            Platform::Kuaishou => "快手",
        }
    }

    /// 站点的网页首页，用于「打开房间页面」兜底。
    pub fn home(self) -> &'static str {
        match self {
            Platform::Bilibili => "https://live.bilibili.com",
            Platform::Douyu => "https://www.douyu.com",
            Platform::Huya => "https://www.huya.com",
            Platform::Douyin => "https://live.douyin.com",
            Platform::Kuaishou => "https://live.kuaishou.com",
        }
    }

    /// 输入框为空时填的示例房间号（真实在播的大房间）。
    pub fn sample_room(self) -> &'static str {
        match self {
            Platform::Bilibili => "21452505",
            Platform::Douyu => "9999",
            Platform::Huya => "998",
            // 抖音/快手都以「网页房间号」为准，这里放官方直播广场里的常驻房间。
            Platform::Douyin => "631413137191",
            Platform::Kuaishou => "3xab7d4v8m2kq9e",
        }
    }

    pub fn from_id(value: &str) -> Option<Self> {
        match value {
            "bilibili" => Some(Platform::Bilibili),
            "douyu" => Some(Platform::Douyu),
            "huya" => Some(Platform::Huya),
            "douyin" => Some(Platform::Douyin),
            "kuaishou" => Some(Platform::Kuaishou),
            _ => None,
        }
    }
}

/// 搜索结果里的一条直播间。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveRoomItem {
    pub platform: Platform,
    pub room_id: String,
    pub title: String,
    pub user_name: String,
    pub cover: String,
    pub online: u64,
}

/// 房间页头的完整信息。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LiveRoomDetail {
    pub platform: Platform,
    pub room_id: String,
    pub title: String,
    pub user_name: String,
    /// 主播头像；部分平台详情页只给封面，解析时尽量取真正的头像。
    #[serde(default)]
    pub avatar: String,
    pub cover: String,
    pub online: u64,
    /// 在线观看人数（B 站「看过」人数）；拿不到时为 0，界面回退显示人气。
    #[serde(default)]
    pub viewers: u64,
    /// 大航海（舰长）人数；目前只有 B 站提供，其它平台为 0。
    #[serde(default)]
    pub guard_count: u64,
    /// 本场开播时间（Unix 秒）；0 表示未知，界面回退到本地观看时长。
    #[serde(default)]
    pub live_start_time: u64,
    pub live: bool,
    pub area: Option<String>,
    pub intro: String,
    /// 网页版房间地址。
    pub url: String,
    /// 取流需要的站点私有上下文。
    pub extra: RoomExtra,
}

/// 各站取流的私有中间数据。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RoomExtra {
    Bilibili {
        buvid3: String,
        buvid4: String,
        /// 弹幕 token（`getDanmuInfo` 下发），为空表示弹幕不可用。
        token: String,
        /// 弹幕服务器主机，默认 `broadcastlv.chat.bilibili.com`。
        host: String,
        /// 真实房间号，弹幕 join 需要。
        room_id: String,
        /// 登录 Cookie（匿名时也含 buvid3/buvid4），弹幕握手需要。
        /// 不序列化给前端，避免把 SESSDATA 暴露到 WebView。
        #[serde(default, skip_serializing)]
        cookie: String,
        /// 登录用户 UID，匿名时为 0。
        #[serde(default)]
        uid: u64,
    },
    Huya {
        lines: Vec<HuyaLine>,
        bitrates: Vec<HuyaBitrate>,
        /// 主播频道号，anticode 的 `seqid` 依赖它。
        presenter_uid: u64,
        /// 主播 yyid，弹幕 join 需要。
        yyid: u64,
    },
    Douyu {
        rid: String,
    },
    Douyin {
        /// 一次性房间号（19 位），每次开播都会变，reflow 取流用它。
        room_id: String,
        /// 主播固定网页房间号，对外展示与拼接链接用它。
        web_rid: String,
        /// 进房接口下发的 `stream_url`，里面是带签名的 FLV/HLS 地址。
        stream_url: Value,
        /// 弹幕握手要用的 Cookie（登录态，缺 ttwid 时已补匿名值）。
        /// 不下发给前端：SESSDATA 之类的凭据不出进程。
        #[serde(default, skip_serializing)]
        cookie: String,
        /// webmssdk 生成的 `signature`。它只能在 JS 引擎里算出来，
        /// 所以由 WebView 算好后随 `start_danmaku` 传进来；
        /// 为空表示这次没拿到签名，弹幕会明确报错而不是静默空着。
        #[serde(default, skip_serializing)]
        signature: String,
        /// 弹幕用的 `user_unique_id`，必须和算签名时用的是同一个值。
        #[serde(default, skip_serializing)]
        user_id: String,
    },
    Kuaishou {
        /// 主播 ID（`live.kuaishou.com/u/<id>` 里的那一段）。
        author_id: String,
        /// 当前场次的直播流 ID，弹幕与取流都依赖它。
        #[serde(default)]
        stream_id: String,
        /// `liveStream.playUrls`：快手把每个清晰度的地址都塞在这里。
        #[serde(default)]
        play_urls: Value,
    },
    Empty,
}

impl Default for RoomExtra {
    fn default() -> Self {
        RoomExtra::Empty
    }
}

/// 虎牙的一条推流线路。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HuyaLine {
    /// 如 `http://al.flv.huya.com/src`
    pub flv_url: String,
    pub stream_name: String,
    /// 线路名，如 `AL` / `TX` / `HS`
    pub cdn: String,
    /// 页面上给出的 anticode，需要按 §4.2 重算后才可用
    pub anti_code: String,
}

/// 虎牙的一档码率。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HuyaBitrate {
    pub name: String,
    /// 0 表示原画
    pub bitrate: u32,
}

/// 一级分类（如「网游」「娱乐」）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveCategory {
    pub id: String,
    pub name: String,
    pub children: Vec<LiveSubCategory>,
}

/// 二级分类（如「英雄联盟」）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveSubCategory {
    pub id: String,
    pub name: String,
    pub parent_id: String,
    pub pic: String,
}

/// 一档清晰度。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayQuality {
    pub name: String,
    pub data: QualityData,
}

/// 回传给取流接口的私有句柄。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum QualityData {
    Bilibili { qn: u32 },
    Huya { bitrate: u32 },
    Douyu { rate: u32, cdns: Vec<String> },
    /// 抖音的档位键：`FULL_HD1` / `HD1` / `SD1` / `SD2`。
    Douyin { key: String },
    /// 快手的清晰度直接用地址列表表示（每档可能有多条同码率线路）。
    Kuaishou { urls: Vec<String> },
}

/// 取流结果。
///
/// FLV 与 HLS 分两个字段而不是混在一个列表里：前端要按协议选不同的播放器
/// （mpegts.js / hls.js），靠 URL 后缀猜不可靠（虎牙的 HLS 后缀由接口下发）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlayUrls {
    pub urls: Vec<String>,
    /// HLS（m3u8）线路；为空表示这个平台/清晰度没有 HLS 出口。
    #[serde(default)]
    pub hls_urls: Vec<String>,
    /// 播放器需要的请求头，如 `Referer` / `User-Agent`。
    pub headers: Vec<(String, String)>,
}

impl PlayUrls {
    pub fn new(urls: Vec<String>) -> Self {
        Self {
            urls,
            hls_urls: Vec::new(),
            headers: Vec::new(),
        }
    }

    /// 附上 HLS 线路（与 FLV 并列，前端作为可选/兜底线路）。
    pub fn with_hls(mut self, urls: Vec<String>) -> Self {
        self.hls_urls = urls;
        self
    }

    pub fn header(mut self, key: &str, value: &str) -> Self {
        self.headers.push((key.to_string(), value.to_string()));
        self
    }
}
