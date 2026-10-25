use serde::{Deserialize, Serialize};

/// 支持的直播平台。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum Platform {
    Bilibili,
    Douyu,
    Huya,
}

impl Platform {
    /// UI 顺序：先 B 站，再斗鱼、虎牙。
    pub const ALL: [Platform; 3] = [Platform::Bilibili, Platform::Douyu, Platform::Huya];

    pub fn id(self) -> &'static str {
        match self {
            Platform::Bilibili => "bilibili",
            Platform::Douyu => "douyu",
            Platform::Huya => "huya",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Platform::Bilibili => "哔哩哔哩",
            Platform::Douyu => "斗鱼",
            Platform::Huya => "虎牙",
        }
    }

    /// 站点的网页首页，用于「打开房间页面」兜底。
    pub fn home(self) -> &'static str {
        match self {
            Platform::Bilibili => "https://live.bilibili.com",
            Platform::Douyu => "https://www.douyu.com",
            Platform::Huya => "https://www.huya.com",
        }
    }

    /// 输入框为空时填的示例房间号（真实在播的大房间）。
    pub fn sample_room(self) -> &'static str {
        match self {
            Platform::Bilibili => "21452505",
            Platform::Douyu => "9999",
            Platform::Huya => "998",
        }
    }

    pub fn from_id(value: &str) -> Option<Self> {
        match value {
            "bilibili" => Some(Platform::Bilibili),
            "douyu" => Some(Platform::Douyu),
            "huya" => Some(Platform::Huya),
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
    Empty,
}

impl Default for RoomExtra {
    fn default() -> Self {
        RoomExtra::Empty
    }
}

/// 虎牙的一条推流线路。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
}

/// 取流结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PlayUrls {
    pub urls: Vec<String>,
    /// 播放器需要的请求头，如 `Referer` / `User-Agent`。
    pub headers: Vec<(String, String)>,
}

impl PlayUrls {
    pub fn new(urls: Vec<String>) -> Self {
        Self {
            urls,
            headers: Vec::new(),
        }
    }

    pub fn header(mut self, key: &str, value: &str) -> Self {
        self.headers.push((key.to_string(), value.to_string()));
        self
    }
}
