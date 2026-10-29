//! 斗鱼取流签名。
//!
//! 斗鱼把签名函数按房间号下发（`homeH5Enc`），函数体高度混淆且每次不同，只能执行不能移植。
//! 桌面端由 WebView 执行平台脚本完成签名（`web/js/pages/room.js` + CryptoJS，
//! 结果通过 `douyu_qualities` / `douyu_play` 的 `signedArgs` 传回来），
//! 所以这里只保留一个明确的“不支持”出口：调用方拿到的是原因，而不是一句含糊的失败。

use crate::error::LiveError;

/// 没有 JS 宿主时调用：说明缺的是执行环境，而不是网络或签名算法。
pub fn sign(_script: &str, _rid: &str, _did: &str, _timestamp: u64) -> Result<String, LiveError> {
    Err(LiveError::unsupported(
        "斗鱼签名脚本需要在 WebView 里执行，当前宿主没有 JS 环境",
    ))
}

/// 32 位十六进制设备号，进程内复用（匿名请求共用写死的假 did 容易被风控掐流）。
pub fn device_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 设备号是32位十六进制() {
        let did = device_id();
        assert_eq!(did.len(), 32);
        assert!(did.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(did, device_id());
    }
}
