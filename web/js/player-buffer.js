// 播放缓冲档位：FLV（mpegts.js）与 HLS（hls.js）的缓冲参数，房间页与同屏页共用。
import { state } from './store.js';

/// `label` / `desc` 只给设置页用；`flv` 摊进 `mpegts.createPlayer` 的第二个参数。
export const BUFFER_PRESETS = {
  low: {
    label: '低延迟',
    desc: '几乎不留缓冲，落后就往前追，画面尽量贴着直播；网络抖动时更容易卡顿',
    flv: {
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

function bufferPreset() {
  const key = state?.settings?.player?.buffer;
  return BUFFER_PRESETS[key] || BUFFER_PRESETS.normal;
}

/// `mpegts.js` 的缓冲参数。
/// `allowChase = false` 用于「延迟播放」：关掉追帧，避免吃掉用户设定的延迟。
export function flvBufferOptions(allowChase = true) {
  const options = { ...bufferPreset().flv };
  if (!allowChase) {
    options.liveBufferLatencyChasing = false;
    options.enableStashBuffer = true;
    options.stashInitialSize = Math.max(1024, Number(options.stashInitialSize) || 0);
  }
  return options;
}

/// `hls.js` 的缓冲参数（`liveSyncDuration*` 由调用方按「延迟播放」再覆盖）。
export function hlsBufferOptions() {
  return { ...bufferPreset().hls };
}
