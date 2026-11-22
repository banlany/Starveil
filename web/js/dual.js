// 同屏播放的 B 路：独立取流与播放，向 A 提供音量、对齐与销毁。
import { api, normalizePlatform } from './api.js';
import { flvBufferOptions, hlsBufferOptions } from './player-buffer.js';
import { state } from './store.js';

/// 直链判断：只认 http(s) 且以 .flv / .m3u8 结尾（允许带查询串）。
const STREAM_URL = /^https?:\/\/\S+\.(flv|m3u8)(\?|#|$)/i;

/// 本应用的代理地址 `/stream/<token>`，无扩展名；带 Referer / UA，可直接用于同屏播放。
const LOCAL_PROXY = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/stream\/[^\s?#/]+(?:[?#]\S*)?$/i;

/// B 默认不用最高档，降低两路同时解码的压力。
const QUALITY_HINT = 1;

/// 缓冲里能退/进多少秒。mpegts 的后向缓冲是 30~60 秒，留一点余量。
const SEEK_LIMIT = 30;

/// 解析用户输入：直播间链接/房间号，或者一条直链。
async function parseDualTarget(currentPlatform, input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('请填写 B 的直播间链接或流地址');
  if (STREAM_URL.test(value) || LOCAL_PROXY.test(value)) {
    return {
      kind: 'stream',
      url: value,
      protocol: /\.m3u8(\?|#|$)/i.test(value) ? 'hls' : 'flv',
    };
  }
  const result = await api.resolveInput(currentPlatform, value);
  if (result?.is_short_link) {
    throw new Error('短链接需要先展开，请粘贴完整直播间地址');
  }
  if (!result?.platform || !result?.room_id) {
    throw new Error(
      /^https?:\/\//i.test(value)
        ? '这个地址播不了：要 .flv / .m3u8 直链，或者「更多 → 复制直播流」给出的本机地址'
        : '没认出这个链接属于哪个平台'
    );
  }
  return {
    kind: 'room',
    platform: normalizePlatform(result.platform),
    roomId: String(result.room_id),
  };
}

/// 在已缓冲范围内前后移动：seconds 正数向前、负数向后，前向最多到缓冲末尾前 0.6 秒。
export function seekInBuffer(video, seconds) {
  const delta = Number(seconds);
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) return 0;
  const ranges = video.buffered;
  if (!ranges || !ranges.length) return 0;
  const start = ranges.start(0);
  const end = ranges.end(0);
  const now = video.currentTime;
  const target = Math.min(Math.max(now + delta, start + 0.1), Math.max(start + 0.1, end - 0.6));
  const moved = target - now;
  if (Math.abs(moved) < 0.05) return 0;
  try {
    video.currentTime = target;
  } catch {
    return 0;
  }
  return moved;
}

/**
 * 建一路独立播放器。
 * @param {HTMLVideoElement} video 专用的 B 画面元素
 * @param {(state: object) => void} onState 状态变化回调（加载/出错/元数据）
 */
export function createDualPlayback(video, onState) {
  const session = {
    open: false,
    loading: false,
    error: '',
    kind: '',
    platform: '',
    roomId: '',
    /// 房间会话 key，切到 B 的弹幕时要用它。
    key: '',
    detail: null,
    title: '',
    qualities: [],
    qualityIndex: 0,
    lines: [],
    lineIndex: 0,
    protocol: '',
    player: null,
    retries: 0,
    retryTimer: 0,
    muted: true,
    destroyed: false,
  };

  function snapshot() {
    return {
      open: session.open,
      loading: session.loading,
      error: session.error,
      kind: session.kind,
      platform: session.platform,
      roomId: session.roomId,
      key: session.key,
      detail: session.detail,
      title: session.title,
      muted: session.muted,
      protocol: session.protocol,
      // 只有真正拿到房间详情、且房间已开播，才有弹幕可连。
      danmaku: Boolean(session.key && session.detail?.live),
    };
  }

  function emit() {
    onState?.(snapshot());
  }

  // 出画即载入成功，重置 loading 与重试计数。
  video.addEventListener('playing', () => {
    if (!session.open) return;
    session.loading = false;
    session.error = '';
    session.retries = 0;
    emit();
  });

  function toLines(payload) {
    const lines = [];
    for (const url of payload.urls || []) lines.push({ url, protocol: 'flv' });
    for (const url of payload.hls_urls || []) lines.push({ url, protocol: 'hls' });
    return lines;
  }

  function destroyPlayer() {
    clearTimeout(session.retryTimer);
    session.retryTimer = 0;
    if (!session.player) {
      session.protocol = '';
      return;
    }
    try {
      if (session.protocol === 'hls' || session.protocol === 'native-hls') {
        session.player.destroy?.();
      } else {
        session.player.pause?.();
        session.player.unload?.();
        session.player.detachMediaElement?.();
        session.player.destroy?.();
      }
    } catch {
      /* 销毁失败不影响后续重建 */
    }
    session.player = null;
    session.protocol = '';
  }

  /// 断流重连：B 是配角，失败两次就把原因交给面板，不在这里无限重试。
  function scheduleRetry() {
    if (session.destroyed || !session.open) return;
    if (session.retries >= 2) {
      session.error = 'B 的画面断开了，重新载入可以恢复';
      session.loading = false;
      emit();
      return;
    }
    session.retries += 1;
    clearTimeout(session.retryTimer);
    session.retryTimer = setTimeout(() => {
      session.retryTimer = 0;
      if (session.destroyed || !session.open) return;
      if (session.kind === 'stream') {
        playLine(0);
      } else {
        refreshRoomStream();
      }
    }, 900 * session.retries);
  }

  function createFlv(line) {
    if (!window.mpegts || !mpegts.isSupported()) {
      throw new Error('当前环境不支持 FLV 播放');
    }
    const source = { type: 'flv', url: line.url, isLive: true, cors: true };
    const player = mpegts.createPlayer(source, {
      // 解封装放 Worker；创建失败时库内部回退主线程。
      enableWorker: true,
      lazyLoad: false,
      // 和主画面共用一份缓冲档位（设置 → 播放缓冲）。
      ...flvBufferOptions(),
      autoCleanupSourceBuffer: true,
      fixAudioTimestampGap: true,
    });
    player.attachMediaElement(video);
    let errored = false;
    player.on(mpegts.Events.ERROR, (_type, detail) => {
      // 一次故障会连发多条错误事件，只认第一条并立刻拆掉实例。
      if (errored) return;
      errored = true;
      console.error('[dual] mpegts error', _type, detail);
      try {
        player.destroy();
      } catch {
        /* 忽略销毁异常 */
      }
      if (session.player === player) {
        session.player = null;
        session.protocol = '';
      }
      scheduleRetry();
    });
    player.on(mpegts.Events.LOADING_COMPLETE, () => {
      if (!session.destroyed && video.paused) scheduleRetry();
    });
    player.load();
    session.player = player;
    session.protocol = 'flv';
    resume();
  }

  function createHls(line) {
    const Hls = window.Hls;
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({
        ...hlsBufferOptions(),
        backBufferLength: 30,
        manifestLoadingTimeOut: 8000,
        fragLoadingTimeOut: 20000,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        console.error('[dual] hls error', data.type, data.details);
        hls.destroy();
        session.player = null;
        scheduleRetry();
      });
      hls.loadSource(line.url);
      hls.attachMedia(video);
      session.player = hls;
      session.protocol = 'hls';
      resume();
      return;
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      session.player = { destroy: () => video.removeAttribute('src') };
      session.protocol = 'native-hls';
      video.src = line.url;
      resume();
      return;
    }
    throw new Error('当前环境不支持 HLS 播放');
  }

  /// B 是自动播放的另一路，先静音起步最稳；用户开声音在面板里点。
  function resume() {
    video.muted = session.muted;
    const promise = video.play();
    promise?.catch?.(() => {
      video.muted = true;
      session.muted = true;
      video.play().catch(() => {});
      emit();
    });
  }

  function playLine(index) {
    const line = session.lines[index];
    if (!line) {
      session.error = 'B 没有可用的播放地址';
      session.loading = false;
      emit();
      return;
    }
    session.lineIndex = index;
    session.error = '';
    session.loading = true;
    emit();
    destroyPlayer();
    try {
      if (line.protocol === 'hls') createHls(line);
      else createFlv(line);
    } catch (error) {
      session.error = String(error?.message || error);
      session.loading = false;
      emit();
    }
  }

  async function refreshRoomStream() {
    if (!session.key) return;
    try {
      const payload = await api.play(session.key, session.qualityIndex, {
        forceHttps: state.settings.player.forceHttps,
      });
      if (session.destroyed || !session.open) return;
      session.lines = toLines(payload);
      playLine(0);
    } catch (error) {
      session.error = `B 取流失败：${error}`;
      session.loading = false;
      emit();
    }
  }

  // 连点载入会并发，只认最后一次的结果。
  let openRequest = 0;

  /// 载入 B：房间走 openRoom + play，直链直接播。
  async function open(input, options = {}) {
    close();
    const request = ++openRequest;
    const target = await parseDualTarget(options.currentPlatform || 'bilibili', input);
    if (session.destroyed || request !== openRequest) return snapshot();
    session.open = true;
    session.loading = true;
    session.error = '';
    session.kind = target.kind;
    session.retries = 0;
    session.muted = options.muted !== false;
    emit();

    if (target.kind === 'stream') {
      session.platform = '';
      session.roomId = '';
      session.title = '外部流';
      session.lines = [{ url: target.url, protocol: target.protocol }];
      playLine(0);
      return snapshot();
    }

    session.platform = target.platform;
    session.roomId = target.roomId;
    const payload = await api.openRoom(target.platform, target.roomId);
    if (session.destroyed || request !== openRequest) return snapshot();
    session.key = payload.key;
    session.detail = payload.detail;
    session.title = payload.detail?.user_name || payload.detail?.title || target.roomId;
    session.qualities = payload.qualities || [];
    if (!payload.detail?.live || !session.qualities.length) {
      session.open = false;
      session.loading = false;
      session.error = payload.detail?.live ? 'B 没有可用的直播流' : 'B 当前未开播';
      emit();
      return snapshot();
    }
    session.qualityIndex = Math.min(QUALITY_HINT, session.qualities.length - 1);
    await refreshRoomStream();
    return snapshot();
  }

  function close() {
    openRequest += 1;
    session.open = false;
    session.loading = false;
    session.error = '';
    session.key = '';
    session.detail = null;
    session.title = '';
    session.lines = [];
    session.qualities = [];
    session.retries = 0;
    destroyPlayer();
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* 忽略 */
    }
    emit();
  }

  function setMuted(muted) {
    session.muted = Boolean(muted);
    video.muted = session.muted;
    emit();
  }

  /// 面板上的 B 音量；不触发事件，避免拖动时重画面板。
  function setVolume(value) {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    video.volume = next;
    session.muted = next <= 0;
    video.muted = session.muted;
  }

  /// 对齐到指定偏移：seconds 正数向前、负数向后，返回实际位移。
  function seekBy(seconds) {
    return seekInBuffer(video, seconds);
  }

  /// 缓冲里还能退多少秒（面板据此提示「最多对齐到 N 秒」）。
  function backwardRoom() {
    if (!session.open || !video.buffered?.length) return 0;
    return Math.min(SEEK_LIMIT, Math.max(0, video.currentTime - video.buffered.start(0)));
  }

  return {
    open,
    close,
    setMuted,
    setVolume,
    seekBy,
    backwardRoom,
    snapshot,
    get state() {
      return session;
    },
    get video() {
      return video;
    },
    destroy() {
      session.destroyed = true;
      close();
    },
  };
}
