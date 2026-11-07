//! FLV 流续接：上游换了地址，但下游那条 HTTP 响应不能断。
//!
//! 斗鱼的直链带 `expire=300`，到点 CDN 会干净地关掉连接。续签只能拿到一条
//! **新的**直链，而这条新直链是从 FLV 头开始的一整段新流。如果原样往同一个
//! 响应体里写，播放器（mpegts.js 的 FLV demuxer）会在流中间再遇到一次
//! `FLV\x01` 头，把它当成非法 tag，直接报错——表现就是「断流、重连」。
//!
//! 这里做两件事，让播放器完全感知不到换过地址：
//! 1. 丢掉续接流的 FLV 头（9 字节头 + 4 字节 PreviousTagSize）和脚本 tag；
//! 2. 从第一个视频关键帧开始输出，并把每个 tag 的时间戳接着上一路往下排。
//!
//! 时间戳是「流启动至今的毫秒数」，同一个房间的两条直链本来就能对上；但显式
//! 重排一遍更稳：主播重推流时时间戳会归零，直接透传会让播放器认为时间倒退。

/// tag 头 11 字节 + 数据 + PreviousTagSize 4 字节。
const TAG_HEADER: usize = 11;
const TAG_TRAILER: usize = 4;
const TAG_VIDEO: u8 = 9;
/// 音频 tag。续接时只从视频关键帧开始，这个值只在测试里拼样本用。
#[cfg(test)]
const TAG_AUDIO: u8 = 8;
/// 续接时第一帧与上一路最后一帧之间留的空隙。
const SPLICE_GAP_MS: u32 = 20;
/// 视频 tag 负载第一个字节的高 4 位是帧类型，1 表示关键帧。
const FRAME_KEY: u8 = 1;
/// 等待关键帧期间最多缓存这么多字节。单个 tag 最大也就几百 KB，超过说明流不对。
const MAX_PENDING: usize = 4 * 1024 * 1024;

fn tag_at(bytes: &[u8]) -> Option<(u8, u32, &[u8], usize)> {
    if bytes.len() < TAG_HEADER {
        return None;
    }
    let size = ((bytes[1] as usize) << 16) | ((bytes[2] as usize) << 8) | bytes[3] as usize;
    let total = TAG_HEADER + size + TAG_TRAILER;
    if bytes.len() < total {
        return None;
    }
    let ts = ((bytes[4] as u32) << 16)
        | ((bytes[5] as u32) << 8)
        | (bytes[6] as u32)
        | ((bytes[7] as u32) << 24);
    Some((bytes[0], ts, &bytes[TAG_HEADER..TAG_HEADER + size], total))
}

/// 判断是不是「能直接开始解码的画面帧」。
///
/// 斗鱼每条新连接的开头是：脚本 tag → 音频配置帧（7 字节）→ AVC/HEVC 序列头
/// （50 字节，frameType 也是 1，但它不是画面，时间戳还是从零起的小值）。
/// 只认 `frameType == 1` 会把序列头当成起点，后面的真实时间戳一减就是几千万，
/// 播放器直接卡死。所以 AVC/HEVC 还要看 AVCPacketType（1 = NALU，0 = 序列头）。
fn is_keyframe(kind: u8, payload: &[u8]) -> bool {
    if kind != TAG_VIDEO || payload.len() < 2 || payload[0] >> 4 != FRAME_KEY {
        return false;
    }
    let codec = payload[0] & 0x0f;
    if codec == 7 || codec == 12 {
        return payload[1] == 1;
    }
    true
}

/// FLV 头的长度（含紧跟其后的 PreviousTagSize0）。不是头、或者还没收全就返回 None。
fn flv_header_len(bytes: &[u8]) -> Option<usize> {
    if !bytes.starts_with(b"FLV") || bytes.len() < 9 {
        return None;
    }
    let data_offset = u32::from_be_bytes(bytes[5..9].try_into().ok()?) as usize;
    let total = data_offset.max(9) + 4;
    (bytes.len() >= total).then_some(total)
}

/// 把 tag 头里的时间戳换成 `ts`。
fn rewrite_timestamp(tag: &mut [u8], ts: u32) {
    tag[4] = (ts >> 16) as u8;
    tag[5] = (ts >> 8) as u8;
    tag[6] = ts as u8;
    tag[7] = (ts >> 24) as u8;
}

#[derive(Default)]
pub struct FlvSplicer {
    /// 一个 tag 被拆在两次 read 之间时剩下的半截。
    pending: Vec<u8>,
    /// 已输出过的最后一个时间戳。
    last_ts: Option<u32>,
    /// 本段流第一个关键帧的原始时间戳；None 表示还没找到可输出的起点。
    base_ts: Option<u32>,
    /// 本段流第一个关键帧要写出去的时间戳（上一路的末尾 + 空隙）。
    origin_ts: Option<u32>,
    /// 输出过的 tag 数，仅用于日志。
    emitted: u64,
}

impl FlvSplicer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 第一段流：原样透传，只顺手记下时间戳。
    pub fn observe(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
        // 不是 FLV（或 tag 结构对不上）时永远解析不出完整 tag，别让它一直涨。
        if self.pending.len() > MAX_PENDING {
            self.pending.clear();
            return;
        }
        let mut offset = 0;
        if self.pending.starts_with(b"FLV") {
            // 头还没收全就先攒着，别把半截头当成 tag 去解析。
            let Some(skip) = flv_header_len(&self.pending) else {
                return;
            };
            offset = skip;
        }
        while let Some((_, ts, _, total)) = tag_at(&self.pending[offset..]) {
            self.last_ts = Some(ts);
            offset += total;
        }
        self.pending.drain(..offset);
    }

    /// 换了一条上游地址：清掉残留，重新找关键帧。
    pub fn begin_segment(&mut self) {
        self.pending.clear();
        self.base_ts = None;
        self.origin_ts = None;
    }

    /// 续接的流：去掉 FLV 头与脚本 tag，时间戳接着上一路排。
    pub fn translate(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(chunk);
        // 一直等不到关键帧（上游发来的不是可解码的流）时别把内存吃满。
        if self.base_ts.is_none() && self.pending.len() > MAX_PENDING {
            self.pending.clear();
        }
        let mut out = Vec::with_capacity(self.pending.len());
        let mut offset = 0;
        while offset < self.pending.len() {
            if self.base_ts.is_none() && offset == 0 && self.pending.starts_with(b"FLV") {
                // 新一段流的 FLV 头，直接丢；按文件头里的数据偏移跳更稳。
                let Some(skip) = flv_header_len(&self.pending) else {
                    break;
                };
                offset = skip;
                continue;
            }
            let Some((kind, ts, payload, total)) = tag_at(&self.pending[offset..]) else {
                break;
            };
            let start = self.base_ts;
            let base = match start {
                Some(base) => base,
                None => {
                    // 脚本 tag 和音频/视频配置帧都跳过，从一个关键帧开始，
                    // 否则解码器会先收到一堆没有参考帧的 P 帧。
                    if !is_keyframe(kind, payload) {
                        offset += total;
                        continue;
                    }
                    self.base_ts = Some(ts);
                    // 接缝处只加一次空隙，后面按原始间隔走，不能每个 tag 都加。
                    self.origin_ts = Some(
                        self.last_ts
                            .map(|last| last.saturating_add(SPLICE_GAP_MS))
                            .unwrap_or(ts),
                    );
                    ts
                }
            };
            let origin = self.origin_ts.unwrap_or(base);
            let next = origin.saturating_add(ts.saturating_sub(base));
            let mut tag = self.pending[offset..offset + total].to_vec();
            rewrite_timestamp(&mut tag, next);
            out.extend_from_slice(&tag);
            self.last_ts = Some(next);
            self.emitted += 1;
            offset += total;
        }
        self.pending.drain(..offset);
        out
    }

    /// 已经接上的 tag 数。代理用它判断「续接真的起效了」还是「一直没等到关键帧」。
    pub fn emitted(&self) -> u64 {
        self.emitted
    }

    pub fn has_base(&self) -> bool {
        self.base_ts.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(kind: u8, ts: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(TAG_HEADER + payload.len() + TAG_TRAILER);
        out.push(kind);
        let size = payload.len();
        out.push((size >> 16) as u8);
        out.push((size >> 8) as u8);
        out.push(size as u8);
        out.push((ts >> 16) as u8);
        out.push((ts >> 8) as u8);
        out.push(ts as u8);
        out.push((ts >> 24) as u8);
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(payload);
        out.extend_from_slice(&(TAG_HEADER as u32 + size as u32 + TAG_TRAILER as u32).to_be_bytes());
        out
    }

    /// frameType 1 = 关键帧，2 = 普通帧；第二个字节是编码 id。
    fn video(frame: u8, ts: u32) -> Vec<u8> {
        let mut payload = vec![(frame << 4) | 7, 1];
        payload.extend_from_slice(&[0u8; 16]);
        tag(TAG_VIDEO, ts, &payload)
    }

    fn audio(ts: u32) -> Vec<u8> {
        let mut payload = vec![0xaf, 1];
        payload.extend_from_slice(&[0u8; 4]);
        tag(TAG_AUDIO, ts, &payload)
    }

    fn stream(tags: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"FLV\x01\x05\0\0\0\x09\0\0\0\0");
        for item in tags {
            out.extend_from_slice(item);
        }
        out
    }

    #[test]
    fn 第一段原样透传只记时间戳() {
        let mut splicer = FlvSplicer::new();
        let data = stream(&[audio(100), video(2, 140), video(2, 180)]);
        splicer.observe(&data);
        assert_eq!(splicer.last_ts, Some(180));
        assert!(splicer.translate(&[]).is_empty());
    }

    #[test]
    fn 续接丢掉头与脚本并从关键帧开始() {
        let mut splicer = FlvSplicer::new();
        splicer.observe(&stream(&[audio(100), video(2, 140), video(2, 300)]));
        assert_eq!(splicer.last_ts, Some(300));

        splicer.begin_segment();
        // 新一段：脚本 tag + 配置帧 + 关键帧 + 普通帧，时间戳从头开始。
        let script = tag(18, 0, b"onMetaData");
        let fresh = stream(&[script, audio(5), video(1, 20), video(2, 60)]);
        let out = splicer.translate(&fresh);

        // 输出里不该再有 FLV 头，也不该有脚本 tag。
        assert!(!out.starts_with(b"FLV"));
        let mut offset = 0;
        let mut stamps = Vec::new();
        while let Some((kind, ts, _, total)) = tag_at(&out[offset..]) {
            assert_eq!(kind, TAG_VIDEO);
            stamps.push(ts);
            offset += total;
        }
        assert_eq!(stamps, vec![320, 360]);
        assert_eq!(splicer.last_ts, Some(360));
        assert_eq!(splicer.emitted(), 2);
    }

    #[test]
    fn 时间戳归零也能接着上次往下排() {
        let mut splicer = FlvSplicer::new();
        splicer.observe(&stream(&[video(1, 9_000), video(2, 9_040)]));
        splicer.last_ts = Some(9_040);
        splicer.begin_segment();
        // 主播重推流：时间戳从 0 开始。
        let out = splicer.translate(&stream(&[video(1, 0), video(2, 40)]));
        let mut offset = 0;
        let mut stamps = Vec::new();
        while let Some((_, ts, _, total)) = tag_at(&out[offset..]) {
            stamps.push(ts);
            offset += total;
        }
        assert_eq!(stamps, vec![9_060, 9_100]);
    }

    #[test]
    fn 序列头不会被当成起点() {
        let mut splicer = FlvSplicer::new();
        splicer.observe(&stream(&[video(1, 1_000), video(2, 1_040)]));
        splicer.begin_segment();
        // 真实直链开头：AVC 序列头（frameType 也是 1）+ 真正的关键帧。
        let mut sequence = vec![(1u8 << 4) | 7, 0];
        sequence.extend_from_slice(&[0u8; 48]);
        let fresh = stream(&[
            tag(TAG_VIDEO, 5, &sequence),
            video(1, 25_812_467),
            video(2, 25_812_500),
        ]);
        let out = splicer.translate(&fresh);
        let (_, ts, _, _) = tag_at(&out).expect("应当输出关键帧");
        // up to 上一路末尾 1040 + 空隙 20。
        assert_eq!(ts, 1_060);
    }

    #[test]
    fn tag被拆在两次读取之间也能拼上() {
        let mut splicer = FlvSplicer::new();
        splicer.observe(&stream(&[video(1, 1_000)]));
        splicer.begin_segment();
        let fresh = stream(&[video(1, 50), video(2, 90)]);
        // 逐字节喂进去，模拟 TCP 分片。
        let mut out = Vec::new();
        for byte in &fresh {
            out.extend_from_slice(&splicer.translate(std::slice::from_ref(byte)));
        }
        let mut offset = 0;
        let mut count = 0;
        while let Some((_, _, _, total)) = tag_at(&out[offset..]) {
            count += 1;
            offset += total;
        }
        assert_eq!(count, 2);
        assert_eq!(offset, out.len());
    }
}
