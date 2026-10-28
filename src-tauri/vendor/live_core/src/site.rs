//! 站点抽象与分发。

use crate::bilibili::BilibiliSite;
use crate::douyin::DouyinSite;
use crate::douyu::DouyuSite;
use crate::error::LiveError;
use crate::http::HttpSession;
use crate::huya::HuyaSite;
use crate::kuaishou::KuaishouSite;
use crate::model::{
    LiveCategory, LiveRoomDetail, LiveRoomItem, LiveSubCategory, Platform, PlayQuality, PlayUrls,
};
use crate::url_parser;

/// 一个平台的完整能力。所有方法都是同步阻塞的：
/// 调用方负责把它扔到后台线程（GPUI 用 `background_executor`）。
pub trait LiveSite: Send + Sync {
    fn platform(&self) -> Platform;

    /// 按关键词搜索直播间。
    fn search(&self, http: &HttpSession, keyword: &str) -> Result<Vec<LiveRoomItem>, LiveError>;

    /// 读取房间头信息。
    fn detail(&self, http: &HttpSession, room_id: &str) -> Result<LiveRoomDetail, LiveError>;

    /// 列出真实可用的清晰度。
    fn qualities(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError>;

    /// 按热度推荐（首页用）。
    fn recommend(&self, http: &HttpSession, page: u32) -> Result<Vec<LiveRoomItem>, LiveError>;

    /// 一级 / 二级分类。
    fn categories(&self, http: &HttpSession) -> Result<Vec<LiveCategory>, LiveError>;

    /// 分类下的房间。
    fn category_rooms(
        &self,
        http: &HttpSession,
        category: &LiveSubCategory,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError>;

    /// 按清晰度取直链。
    fn play(
        &self,
        http: &HttpSession,
        detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError>;

    /// 发送一条纯文本弹幕。
    ///
    /// 默认返回「不支持」：发弹幕必须带登录态，且各平台的发送协议独立于收弹幕，
    /// 没实现的平台宁可明确报错，也不要发出去一条半成品。
    fn send_danmaku(
        &self,
        _http: &HttpSession,
        _detail: &LiveRoomDetail,
        _text: &str,
    ) -> Result<(), LiveError> {
        Err(LiveError::unsupported(format!(
            "{}暂不支持发送弹幕",
            self.platform().name()
        )))
    }
}

/// 门面：持有会话与三个站点实现。
pub struct LiveCore {
    http: HttpSession,
    sites: Vec<Box<dyn LiveSite>>,
}

impl Default for LiveCore {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveCore {
    pub fn new() -> Self {
        Self {
            http: HttpSession::new(),
            sites: vec![
                Box::new(BilibiliSite::new()),
                Box::new(DouyuSite::new()),
                Box::new(HuyaSite::new()),
                Box::new(DouyinSite::new()),
                Box::new(KuaishouSite::new()),
            ],
        }
    }

    /// 指定全局 Cookie（登录态）。
    pub fn with_cookie(mut self, cookie: impl Into<String>) -> Self {
        self.http = self.http.with_cookie(cookie);
        self
    }

    pub fn site(&self, platform: Platform) -> Result<&dyn LiveSite, LiveError> {
        self.sites
            .iter()
            .find(|site| site.platform() == platform)
            .map(|site| site.as_ref())
            .ok_or_else(|| LiveError::unsupported(format!("未注册平台 {}", platform.name())))
    }

    pub fn search(
        &self,
        platform: Platform,
        keyword: &str,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Err(LiveError::parse("搜索关键词不能为空"));
        }
        self.site(platform)?.search(&self.http, keyword)
    }

    pub fn detail(
        &self,
        platform: Platform,
        room_id: &str,
    ) -> Result<LiveRoomDetail, LiveError> {
        let room_id = room_id.trim();
        if room_id.is_empty() {
            return Err(LiveError::parse("房间号不能为空"));
        }
        self.site(platform)?.detail(&self.http, room_id)
    }

    pub fn recommend(
        &self,
        platform: Platform,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        self.site(platform)?.recommend(&self.http, page)
    }

    pub fn categories(&self, platform: Platform) -> Result<Vec<LiveCategory>, LiveError> {
        self.site(platform)?.categories(&self.http)
    }

    pub fn category_rooms(
        &self,
        platform: Platform,
        category: &LiveSubCategory,
        page: u32,
    ) -> Result<Vec<LiveRoomItem>, LiveError> {
        self.site(platform)?.category_rooms(&self.http, category, page)
    }

    pub fn qualities(
        &self,
        detail: &LiveRoomDetail,
    ) -> Result<Vec<PlayQuality>, LiveError> {
        self.site(detail.platform)?
            .qualities(&self.http, detail)
    }

    pub fn play(
        &self,
        detail: &LiveRoomDetail,
        quality: &PlayQuality,
    ) -> Result<PlayUrls, LiveError> {
        self.site(detail.platform)?
            .play(&self.http, detail, quality)
    }

    /// 发送一条弹幕（需要该平台已带登录 Cookie）。
    pub fn send_danmaku(&self, detail: &LiveRoomDetail, text: &str) -> Result<(), LiveError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(LiveError::parse("弹幕内容不能为空"));
        }
        if text.chars().count() > 100 {
            return Err(LiveError::parse("弹幕太长，最多 100 个字"));
        }
        self.site(detail.platform)?
            .send_danmaku(&self.http, detail, text)
    }

    /// 把用户在输入框里填的东西变成 (平台, 房间号)。
    ///
    /// 支持：完整房间链接、平台内短链（需调用方处理）、裸房间号。
    /// 裸房间号沿用当前选中的平台。
    pub fn resolve_input(
        &self,
        current: Platform,
        input: &str,
    ) -> Result<(Platform, String), LiveError> {
        let input = input.trim();
        if input.is_empty() {
            return Err(LiveError::parse("请先填写房间号或直播间链接"));
        }
        if let Some(parsed) = url_parser::parse(input) {
            if parsed.is_short_link {
                return Err(LiveError::unsupported(format!(
                    "短链需要先跟随跳转：{}",
                    parsed.raw
                )));
            }
            return Ok((parsed.platform, parsed.room_id));
        }
        if input
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return Ok((current, input.to_string()));
        }
        Err(LiveError::parse(format!("无法识别的房间号或链接：{input}")))
    }
}
