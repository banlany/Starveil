/// 协议层错误。
///
/// 分类的目的只有一个：让 UI 能决定「要不要给重试按钮」「要不要提示配 Cookie」，
/// 而不是把一段英文异常原样丢给用户。
#[derive(thiserror::Error, Debug, Clone, PartialEq, Eq)]
pub enum LiveError {
    #[error("网络请求失败：{0}")]
    Network(String),

    #[error("被平台风控拦截（{0}），请稍后重试或配置 Cookie")]
    RiskControl(String),

    #[error("平台接口结构已变更：{0}")]
    ProtocolChanged(String),

    #[error("该平台暂不支持：{0}")]
    Unsupported(String),

    #[error("解析失败：{0}")]
    Parse(String),
}

impl LiveError {
    /// 这个错误重试一次有没有意义。
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            LiveError::Network(_) | LiveError::RiskControl(_) | LiveError::Parse(_)
        )
    }

    pub fn network(message: impl Into<String>) -> Self {
        LiveError::Network(message.into())
    }

    pub fn protocol(message: impl Into<String>) -> Self {
        LiveError::ProtocolChanged(message.into())
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        LiveError::Unsupported(message.into())
    }

    pub fn parse(message: impl Into<String>) -> Self {
        LiveError::Parse(message.into())
    }
}

impl From<reqwest::Error> for LiveError {
    fn from(value: reqwest::Error) -> Self {
        if value.is_timeout() {
            return LiveError::Network("请求超时".to_string());
        }
        if value.is_connect() {
            return LiveError::Network(format!("连接失败：{value}"));
        }
        LiveError::Network(value.to_string())
    }
}

impl From<serde_json::Error> for LiveError {
    fn from(value: serde_json::Error) -> Self {
        LiveError::Parse(format!("JSON 解析失败：{value}"))
    }
}
