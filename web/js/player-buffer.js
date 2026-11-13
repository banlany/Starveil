// 播放缓冲档位。
//
// 直播的「延迟」几乎全看这一项：FLV 走 mpegts.js，`enableStashBuffer` 开着时会先攒一段
// 数据再喂给 MSE，网络抖一下补不回来，画面就越落越远；HLS 走 hls.js，起播点由
// `liveSyncDurationCount`（几个分片）决定，缓冲上限是 `maxBufferLength`。
// 三档都作用在这两个播放器的参数上，所以集中放在这里，房间页和同屏页读同一份。
import { state } from './store.js';

/// `label` 只给设置页用；`flv` 直接摊进 `mpegts.createPlayer` 的第二个参数。
export const BUFFER_PRESETS = {
  low: {
    label: '低延迟',
    desc: '几乎不留缓冲，落后就往前追，画面尽量贴着直播；网络抖动时更容易卡顿',
    flv: {
      // 关掉 stash：库收到数据就写进 MSE，不再自己攒一段。
      enableStashBuffer: false,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.5,
      autoCleanupMaxBackwardDuration: 30,
      autoCleanupMinBackwardDuration: 15,
    },
    hls: { liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 6, maxBufferLength: 10 },
  },
  normal: {
    label: '标准',
    desc: '留 1MB 左右的初始缓冲，不主动追帧；网络一般时最稳',
    flv: {
      enableStashBuffer: true,
      stashInitialSize: 1024,
      liveBufferLatencyChasing: false,
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30,
    },
    hls: { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 8, maxBufferLength: 20 },
  },
  smooth: {
    label: '流畅优先',
    desc: '缓冲更大，起播稍慢但更抗抖动；适合网络差或投屏看',
    flv: {
      enableStashBuffer: true,
      stashInitialSize: 3072,
      liveBufferLatencyChasing: false,
      autoCleanupMaxBackwardDuration: 120,
      autoCleanupMinBackwardDuration: 60,
    },
    hls: { liveSyncDurationCount: 4, liveMaxLatencyDurationCount: 12, maxBufferLength: 40 },
  },
};

export function bufferPreset() {
  const key = state?.settings?.player?.buffer;
  return BUFFER_PRESETS[key] || BUFFER_PRESETS.normal;
}

/// `mpegts.js` 的缓冲参数。
///
/// `allowChase = false` 给「延迟播放」用：那一档是靠刻意落后几秒实现的，
/// 让库再去追帧等于把用户设的延迟一秒秒吃掉。
export function flvBufferOptions(allowChase = true) {
  const options = { ...bufferPreset().flv };
  if (!allowChase) {
    options.liveBufferLatencyChasing = false;
    // 追帧关掉了就没有必要连 stash 也一起关：不追帧又没缓冲=每抖一下就断。
    options.enableStashBuffer = true;
    options.stashInitialSize = Math.max(1024, Number(options.stashInitialSize) || 0);
  }
  return options;
}

/// `hls.js` 的缓冲参数（`liveSyncDuration*` 由调用方按「延迟播放」再覆盖）。
export function hlsBufferOptions() {
  return { ...bufferPreset().hls };
}
