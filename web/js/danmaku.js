// 弹幕层：封装 fly-barrage（canvas + 虚拟轨道避让）。
// 时钟用单调墙钟，与视频状态解耦；实例超过阈值时用 prune() 回收；
// 满轨的弹幕退回队列重试；尺寸变化只 resize，不重建。

import { IS_MOBILE } from './platform.js';

const RENDERER_KEY = 'FlyBarrage';

/// lineHeight 是行高倍数；计算区域与创建实例必须用同一个值。
const LINE_HEIGHT_RATIO = 1.35;

/// 兜底默认值，与 store.js 的 DEFAULTS.danmaku 一致。
const FALLBACK_CONFIG = {
  font: 20,
  // 空串表示跟随界面字体（取 body 计算值）。
  fontFamily: '',
  weight: 700,
  opacity: 95,
  area: 40,
  lines: 10,
  speed: 8,
  stroke: true,
  strokeWidth: 2,
  fps: 60,
  perf: 'balanced',
  bigEmojiLines: 2,
};

/// 大表情可选行数（1 行 = 一个轨道高），设置页与直播间共用。
const BIG_EMOJI_LINE_OPTIONS = [1, 2, 3, 4, 5];

const DEFAULT_BIG_EMOJI_LINES = 2;

/// 性能档位：只调整绘制成本与实例上限，不改字号、颜色、区域。
/// 阴影一律关闭；移动端 DPR 上限 2。
const PERF_PROFILES = {
  balanced: { maxStored: 1500, dprCap: IS_MOBILE ? 2 : 0, minSpace: 26, sendScale: 1, noStroke: false },
  smooth: { maxStored: 1000, dprCap: 1.75, minSpace: 22, sendScale: 0.8, noStroke: false },
  ultra: { maxStored: 700, dprCap: 1.25, minSpace: 18, sendScale: 0.6, noStroke: true },
};

/// 性能档位与帧率选项表，设置页与直播间共用。
export const PERF_OPTIONS = [
  { value: 'balanced', label: '平衡（默认）', desc: '保留描边' },
  { value: 'smooth', label: '流畅', desc: '降低画布精度' },
  { value: 'ultra', label: '极速', desc: '再关描边，每秒进入的弹幕更少' },
];

export const FPS_OPTIONS = [
  { value: 0, label: '跟随屏幕', desc: '不限制重绘频率' },
  { value: 60, label: '60 帧', desc: '按屏幕刷新率间隔抽帧' },
];

/// 弹幕数值档位表，设置页与直播间「设置」页签共用。
export const DANMAKU_PRESETS = {
  opacity: [20, 30, 40, 50, 60, 70, 80, 90, 100],
  area: [15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100],
  lines: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
  // 大表情大小：单位是「行」，与弹幕层的轨道口径一致。
  bigEmoji: BIG_EMOJI_LINE_OPTIONS,
  font: [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40],
  speed: [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20],
  strokeWidth: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5],
  safe: [0, 4, 8, 12, 16, 20, 24, 30, 40, 50, 60],
  dedupeWindow: [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60],
  dedupeStep: [1, 2, 3, 4, 5, 6, 8, 10],
};

/// 单次 drain 最多补发的条数。
const MAX_PER_DRAIN = 3;

/// 待发队列的软/硬上限：软上限触发压缩发送间隔，硬上限丢弃最旧。
const QUEUE_SOFT_LIMIT = 80;
const QUEUE_HARD_LIMIT = 4000;

/// 弹幕在队列中的最长等待毫秒数，超时按「显示不下」丢弃。
const QUEUE_MAX_AGE = 3000;

/// 已预热的表情图缓存（url → Image）。
const preloadedEmoticons = new Map();
/// 缓存上限：跨房间只增不减会一直占着解码后的位图。
const PRELOAD_LIMIT = 300;

function preloadEmoticon(url) {
  if (!url || preloadedEmoticons.has(url)) return;
  const image = new Image();
  image.decoding = 'async';
  // 加载失败的从表里删掉，下次同一张图还有机会重试。
  image.onerror = () => preloadedEmoticons.delete(url);
  image.src = url;
  preloadedEmoticons.set(url, image);
  // Map 按插入顺序迭代，超限时丢掉最早的一张。
  if (preloadedEmoticons.size > PRELOAD_LIMIT) {
    preloadedEmoticons.delete(preloadedEmoticons.keys().next().value);
  }
}

function rendererClass() {
  const lib = window[RENDERER_KEY];
  return lib?.BarrageRenderer || lib?.default || null;
}

/// 弹幕时钟（秒）：只用单调墙钟，不读 video.currentTime。
function createMonotonicClock(origin = performance.now()) {
  return {
    get currentTime() {
      return (performance.now() - origin) / 1000;
    },
  };
}

export function flyBarrageAvailable() {
  return typeof rendererClass() === 'function';
}

/**
 * 创建一个弹幕层。
 * @param {HTMLElement} container 弹幕容器（.danmaku-layer）
 * @param {HTMLVideoElement} video 播放器元素，仅用于读取播放进度
 * @param {object} config 初始弹幕设置，避免建好再重建一次
 */
export function createDanmakuLayer(container, video, config = null) {
  const host = document.createElement('div');
  host.className = 'danmaku-canvas-host';
  container.appendChild(host);

  const Renderer = rendererClass();
  // 整层共用一个时钟（不是每次 rebuild 新建），见 createMonotonicClock。
  const clock = createMonotonicClock();
  // 时钟对象始终保持同一引用，重建渲染器时不归零。
  const clockSource = {
    get currentTime() {
      return clock.currentTime;
    },
    // 始终返回播放中，避免库因 paused 停止渲染循环。
    get paused() {
      return false;
    },
  };
  const session = {
    renderer: null,
    config: { ...FALLBACK_CONFIG, ...(config || {}) },
    queue: [],
    queueTimer: 0,
    sent: 0,
    // 实例 id 自增且不复用（预渲染缓存按 id 存位图）。
    seq: 0,
    lastSendAt: 0,
    // 实测宽度的移动平均，用于估算轨道容量（见 sendGap）
    widthAvg: 0,
    // 满轨被丢弃的条数，调试用
    dropped: 0,
    // 累计回收掉的实例数，调试用
    pruned: 0,
    destroyed: false,
    observer: null,
    resizeHandle: 0,
    // 定时确认渲染循环还在跑（见下方 keepAlive）
    keepAliveTimer: 0,
    enabled: true,
    width: 0,
    height: 0,
    // images 按引用交给库；两个 Map 负责 url ↔ id 去重。
    images: [],
    imageIdByUrl: new Map(),
    imageUrlById: new Map(),
    imageSeq: 0,
    // 轨道避让表建立时的行数，用于判断是否需要重建。
    gradeMapGrade: 0,
  };

  /// 当前性能档位配置（缺省回落到「平衡」）。
  function profile() {
    return PERF_PROFILES[session.config?.perf] || PERF_PROFILES.balanced;
  }

  function dispose() {
    try {
      session.renderer?.pause();
      session.renderer?.switch(false);
    } catch {
      /* 忽略销毁异常 */
    }
    session.renderer = null;
    host.innerHTML = '';
  }

  /// 实际帧间隔（毫秒），由相邻两帧首条的间隔滑动平均得到。
  let framePeriod = 1000 / 60;
  let snapStamp = 0;

  /// 把绘制位置吸附到设备像素栅格，避免位图重采样导致文字发虚。
  /// 每帧位移不足 1.5 设备像素时跳过：量化会造成隔帧跳动。
  function snapToDevicePixels({ br, barrage }) {
    const dpr = Number(br?.dpr) || 1;
    const now = performance.now();
    // 同一帧内多条弹幕的间隔在微秒级，超过 3ms 视为进入下一帧。
    const delta = now - snapStamp;
    if (snapStamp && delta > 3 && delta < 100) framePeriod = framePeriod * 0.8 + delta * 0.2;
    snapStamp = now;
    const speed = Number(barrage?.speed);
    if (Number.isFinite(speed) && speed > 0 && (speed * dpr * framePeriod) / 1000 < 1.5) return;
    if (typeof barrage?.left === 'number') barrage.left = Math.round(barrage.left * dpr) / dpr;
    if (typeof barrage?.top === 'number') barrage.top = Math.round(barrage.top * dpr) / dpr;
  }

  function build() {
    if (!Renderer) return;
    session.renderer = new Renderer({
      container: host,
      video: clockSource,
      renderConfig: buildRenderConfig(),
      // 库把这份数组按引用存下来，之后 push 新表情不需要重建渲染器。
      barrageImages: session.images,
      beforeBarrageRender: snapToDevicePixels,
    });
    session.sent = 0;
    primeTracks();
    // 弹幕关闭状态下建渲染器不要自己开播，否则会出现「关掉了还在刷」。
    if (session.enabled) session.renderer.play();
    else session.renderer.switch(false);
    applyPerf();
  }

  /// send() 依赖虚拟轨道已初始化，发送前显式初始化一次。
  function primeTracks() {
    const calculate = session.renderer?.barrageLayoutCalculate;
    const algorithm = calculate?.virtualTrackAlgorithm;
    if (!algorithm) return;
    if (algorithm.realTracks?.length && algorithm.virtualTracks?.length) return;
    const config = session.config || FALLBACK_CONFIG;
    try {
      // initTracks 按当前 maxGrade 建避让表，故先抬到「大表情占几行」。
      algorithm.maxGrade = bigEmojiLines();
      algorithm.initTracks(lineHeightFor(Number(config.font) || FALLBACK_CONFIG.font));
    } catch {
      /* 初始化失败时弹幕不显示，但不影响播放 */
    }
    // 轨道数不够时（区域小 / 字号大）再压回来，否则 grade 超过轨道数就永远放不下。
    syncMaxGrade();
  }

  /// 当前设置下大表情占几行（1~5，再按可用轨道数收窄）。
  function bigEmojiLines() {
    const raw = Number((session.config || FALLBACK_CONFIG).bigEmojiLines);
    const lines = Math.max(1, Math.min(BIG_EMOJI_LINE_OPTIONS.length, Number.isFinite(raw) ? Math.round(raw) : DEFAULT_BIG_EMOJI_LINES));
    const realTrackNum = Number(session.renderer?.barrageLayoutCalculate?.virtualTrackAlgorithm?.realTrackNum);
    if (!realTrackNum) return lines;
    return Math.max(1, Math.min(lines, realTrackNum));
  }

  /// 让库按大表情行数建立轨道避让表（maxGrade）。
  function syncMaxGrade(extra = 0) {
    const algorithm = session.renderer?.barrageLayoutCalculate?.virtualTrackAlgorithm;
    if (!algorithm?.virtualTracks?.length) return;
    const grade = Math.max(bigEmojiLines(), Number(extra) || 0, 1);
    // 用建表时记录的行数判断，而不是 maxGrade。
    if (session.gradeMapGrade === grade && algorithm.vtToVtsMap.size) return;
    algorithm.maxGrade = grade;
    algorithm.vtToVtsMap.clear();
    for (const track of algorithm.virtualTracks) {
      algorithm.vtToVtsMap.set(
        track,
        algorithm.virtualTracks.filter(
          (item) => item.grade <= grade && track.rtIdArr.some((id) => item.rtIdSet.has(id)),
        ),
      );
    }
    session.gradeMapGrade = grade;
  }

  /// 发送前确认轨道已初始化，缺失时重建并重排已有实例。
  function ensureTracks() {
    const calculate = session.renderer?.barrageLayoutCalculate;
    const algorithm = calculate?.virtualTrackAlgorithm;
    if (!algorithm) return;
    if (algorithm.realTracks?.length && algorithm.virtualTracks?.length) return;
    primeTracks();
    const instances = calculate.scrollBarrageInstances || [];
    if (!instances.length) return;
    try {
      algorithm.layoutScrollBarrages(instances);
    } catch (error) {
      console.warn('弹幕轨道重建失败', error);
    }
  }

  /// 把实例补登记到所有相交的虚拟轨道，保证避让判断完整。
  function registerOccupancy(instance) {
    const algorithm = session.renderer?.barrageLayoutCalculate?.virtualTrackAlgorithm;
    if (!algorithm?.virtualTracks?.length) return;
    const trackHeight = Number(algorithm.realTrackHeight);
    const top = Number(instance?.top);
    const height = Number(instance?.height);
    if (!trackHeight || !Number.isFinite(top) || !Number.isFinite(height)) return;
    // 实例占用的实际轨道（1 起，闭区间）：top / 行高 得到起始轨道。
    const first = Math.floor(top / trackHeight) + 1;
    const last = first + Math.max(1, Math.ceil(height / trackHeight)) - 1;
    for (const track of algorithm.virtualTracks) {
      const ids = track.rtIdArr;
      if (!ids?.length) continue;
      // 两条闭区间不相交就跳过
      if (ids[ids.length - 1] < first || ids[0] > last) continue;
      if (!track.barrages.includes(instance)) track.barrages.push(instance);
    }
  }

  /// 清空已登记的表情图与 url ↔ id 去重表。
  function clearImages() {
    session.images.length = 0;
    session.imageIdByUrl.clear();
    session.imageUrlById.clear();
  }

  /// 摘掉已经滚出屏幕的实例，返回清理条数。
  function pruneEnded() {
    const renderer = session.renderer;
    const calc = renderer?.barrageLayoutCalculate;
    if (!calc) return 0;
    // 和 emit()/库渲染用同一个时钟（单调墙钟），否则回收判断会和实际显示错位。
    const now = Math.max(0, Number(clockSource.currentTime) || 0) * 1000;
    const removed = new Set();
    const keep = (barrage) => {
      // 没有 endTime 的实例（目前只有极少数类型）保守留着，不能误删。
      if (!barrage || typeof barrage.endTime !== 'number' || barrage.endTime > now) return true;
      removed.add(barrage);
      return false;
    };

    for (const key of [
      'allBarrageInstances',
      'scrollBarrageInstances',
      'fixedBarrageInstances',
      'seniorBarrageInstances',
      'canShowScrollBarrageInstances',
    ]) {
      if (Array.isArray(calc[key])) calc[key] = calc[key].filter(keep);
    }
    // 每条虚拟轨道里也挂着引用（只 push，只有全量重排才清空），一起摘掉。
    for (const track of calc.virtualTrackAlgorithm?.virtualTracks || []) {
      if (Array.isArray(track.barrages)) track.barrages = track.barrages.filter(keep);
    }
    // 固定弹幕布局维护着两份「正在渲染」列表。
    const fixedLayout = calc.fixedBarrageLayout;
    if (fixedLayout) {
      if (Array.isArray(fixedLayout.topRenderBarrages)) {
        fixedLayout.topRenderBarrages = fixedLayout.topRenderBarrages.filter(keep);
      }
      if (Array.isArray(fixedLayout.bottomRenderBarrages)) {
        fixedLayout.bottomRenderBarrages = fixedLayout.bottomRenderBarrages.filter(keep);
      }
    }
    // 预渲染缓存：一条实例一张 ImageBitmap，实例没了它就是纯占内存。
    const bitmaps = renderer.preRenderOptimizer?.imageBitmapCache;
    if (bitmaps && removed.size) {
      for (const barrage of removed) {
        const bitmap = bitmaps.get(barrage.id);
        if (!bitmap) continue;
        bitmaps.delete(barrage.id);
        try {
          bitmap.close?.();
        } catch {
          /* 位图已被释放 */
        }
      }
    }
    // 计数归零，下一轮重新累计（id 走 session.seq，不会因此重复）。
    session.sent = 0;
    session.pruned += removed.size;
    return removed.size;
  }

  /// 重建渲染器：仅用于字号变化或直播流重连。
  function rebuild() {
    if (session.destroyed || !Renderer) return;
    // 不清空待发队列。
    clearTimeout(session.queueTimer);
    session.queueTimer = 0;
    // 重建后按新字号重新量表情尺寸。
    clearImages();
    dispose();
    measure();
    build();
  }

  function lineHeightFor(font) {
    return Math.max(18, Math.round(font * LINE_HEIGHT_RATIO));
  }

  /// 弹幕字体：用户指定的家族名在前，界面字体栈兜底，跟随皮肤与界面字体设置。
  function fontFamilyFor(config) {
    const family = String(config.fontFamily || '').trim();
    const fallback = themeFontFamily();
    return family ? `"${family}", ${fallback}` : fallback;
  }

  /// 界面字体取自 body 计算后的 font-family。
  function themeFontFamily() {
    try {
      const value = getComputedStyle(document.body).fontFamily;
      if (value && value.trim()) return value;
    } catch {
      /* 取不到就用下面的兜底 */
    }
    return '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif';
  }

  function buildRenderConfig() {
    const config = session.config || FALLBACK_CONFIG;
    const perf = profile();
    const height = host.clientHeight || 1;
    const lineHeight = lineHeightFor(Number(config.font) || FALLBACK_CONFIG.font);
    // lines 是“最多几行”：区域高度按行数上限收窄，剩下的交给库自己排轨道。
    const regionPx = Math.min(
      height * Math.max(10, Math.min(100, Number(config.area) || 40)) / 100,
      Math.max(lineHeight, (Number(config.lines) || 10) * lineHeight)
    );
    // 极速档无视用户的描边开关：描边是剩下最贵的一项（阴影已经全局关掉）。
    const strokeWidth = perf.noStroke ? 0 : config.stroke ? Math.max(0, Number(config.strokeWidth) || 0) : 0;
    // 固定时长模式：每条速度 = (画布宽 + 自身宽) / 时长。
    const durationSeconds = Math.max(3, Math.min(20, Number(config.speed) || 8));
    return {
      scrollDuration: durationSeconds * 1000,
      // 兜底用的固定像素速度：库在没有 scrollDuration 时才用它，口径与上面一致。
      speed: Math.max(60, (session.width || container.clientWidth || 960) / durationSeconds),
      opacity: Math.max(0.2, Math.min(1, (config.opacity ?? 95) / 100)),
      renderRegion: Math.max(0.1, Math.min(1, regionPx / height)),
      fontFamily: fontFamilyFor(config),
      fontWeight: String(config.weight || FALLBACK_CONFIG.weight),
      heightReduce: 0,
      avoidOverlap: true,
      minSpace: perf.minSpace,
      strokeStyle: 'rgba(0, 0, 0, 0.85)',
      lineWidth: strokeWidth,
      lineCap: 'round',
      lineJoin: 'round',
      miterLimit: 10,
      // 阴影显式置 0：库会把 undefined 直接赋给 ctx.shadow*。
      shadowColor: 'rgba(0, 0, 0, 0)',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
    };
  }

  /// 应用性能档位：DPR 上限与帧率上限。
  function applyPerf() {
    const renderer = session.renderer;
    if (!renderer) return;
    const cap = profile().dprCap;
    if (cap > 0) {
      const dpr = Math.min(window.devicePixelRatio || 1, cap);
      if (renderer.dpr !== dpr) {
        try {
          // dpr 是实例字段（库在 resize 时按 canvas.width = 宽 * dpr 重设画布）。
          renderer.dpr = dpr;
          renderer.resize();
        } catch (error) {
          console.warn('弹幕 DPR 调整失败', error);
        }
      }
    }
    applyFrameLimit();
  }

  /// 帧率上限：包一层 _render，按 vsync 计数跳帧，并自行续帧。
  function applyFrameLimit() {
    const renderer = session.renderer;
    if (!renderer) return;
    const original = renderer.__starveilRender || renderer._render;
    renderer.__starveilRender = original;
    const fps = Number((session.config || FALLBACK_CONFIG).fps) || 0;
    const interval = fps >= 10 ? 1000 / fps : 0;
    // 刷新周期取 rAF 间隔的滑动平均。
    let period = 0;
    let lastCall = 0;
    let skip = 0;
    renderer._render = function limitedRender() {
      const now = performance.now();
      if (!interval) {
        lastCall = now;
        return original.call(this);
      }
      if (lastCall) {
        const delta = now - lastCall;
        if (delta > 0 && delta < 100) period = period ? period * 0.8 + delta * 0.2 : delta;
      }
      lastCall = now;
      // 还量不到刷新周期时先按 60Hz 估，抽帧逻辑不会因此跑偏太多。
      const refresh = period || 1000 / 60;
      const step = Math.max(1, Math.round(interval / refresh));
      if (step > 1) {
        skip += 1;
        if (skip < step) {
          requestAnimationFrame(() => this._render());
          return;
        }
        skip = 0;
      }
      return original.call(this);
    };
  }

  function measure() {
    session.width = host.clientWidth;
    session.height = host.clientHeight;
  }

  /// 同步渲染配置；仅在影响渲染的字段变化时调用。
  function syncRenderConfig() {
    const renderer = session.renderer;
    if (!renderer) return;
    const next = buildRenderConfig();
    const current = renderer.renderConfig || {};
    const keys = [
      // scrollDuration 变了等同于速度变了：库会重算每条弹幕的速度与结束时间再重排。
      'scrollDuration',
      'speed',
      'renderRegion',
      'opacity',
      'fontFamily',
      'fontWeight',
      'strokeStyle',
      'lineWidth',
      'shadowColor',
      'shadowBlur',
      'avoidOverlap',
      'minSpace',
    ];
    if (!keys.some((key) => next[key] !== current[key])) return;
    try {
      // 库内部会按变化的字段决定要不要重排轨道，弹幕实例始终保留。
      renderer.setRenderConfig(next);
    } catch (error) {
      console.warn('弹幕渲染配置同步失败', error);
    }
  }

  /// 重排后检查可渲染集合，为空时重新排轨道。
  function ensureLayout() {
    const calculate = session.renderer?.barrageLayoutCalculate;
    if (!calculate) return;
    const instances = calculate.scrollBarrageInstances || [];
    if (!instances.length) return;
    if ((calculate.canShowScrollBarrageInstances || []).length) return;
    try {
      const algorithm = calculate.virtualTrackAlgorithm;
      algorithm.resetTracks();
      algorithm.layoutScrollBarrages(instances);
    } catch (error) {
      console.warn('弹幕轨道重排失败', error);
    }
  }

  /// 尺寸变了：交给库自己重排，弹幕实例与队列都留着。
  function applyResize() {
    if (session.destroyed || !session.renderer) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    if (width === session.width && height === session.height) return;
    session.width = width;
    session.height = height;
    try {
      // 库自带的尺寸重排：重算画布、轨道和弹幕落点，实例保留。
      session.renderer.resize();
    } catch (error) {
      console.warn('弹幕尺寸重排失败', error);
    }
    // 区域比例和滚动速度都跟尺寸有关，重排后同步一次渲染配置。
    syncRenderConfig();
    // 重排可能把轨道表清掉（库的行为），先补轨道再看可显示集合。
    ensureTracks();
    ensureLayout();
    // 尺寸变化不停动画，确认渲染循环仍在跑。
    if (session.enabled && !session.renderer.animationHandle) session.renderer.play();
  }

  /// 全屏动画期间尺寸事件是连续触发的，用 rAF 合并成一次重排。
  function scheduleResize() {
    if (session.resizeHandle || session.destroyed) return;
    session.resizeHandle = requestAnimationFrame(() => {
      session.resizeHandle = 0;
      applyResize();
    });
  }

  /// 两条弹幕的最小间隔，按轨道实际吞吐计算，宽度用移动平均值估算。
  function sendGap() {
    const config = session.config || FALLBACK_CONFIG;
    const lanes = Math.max(2, Math.min(20, Number(config.lines) || 10));
    // 实际轨道数按库算出来的为准：区域高度不够时轨道会比「显示几行」少。
    const realTracks = session.renderer?.barrageLayoutCalculate?.virtualTrackAlgorithm?.realTrackNum;
    const tracks = Math.max(1, Number(realTracks) || lanes);
    const canvasWidth = session.width || container.clientWidth || 960;
    const durationMs = Math.max(3, Math.min(20, Number(config.speed) || 8)) * 1000;
    // 没量到过宽度时按「约 12 个字符」估一下，之后用实测值修正。
    const width = session.widthAvg || Math.min(canvasWidth * 0.4, 200);
    const perTrack = ((width + profile().minSpace) * durationMs) / (canvasWidth + width);
    // 上限 400ms：再慢就变成明显延迟了。
    const gap = Math.min(400, perTrack / tracks);
    // 积压越多发送越快，最多压到 1/4 间隔。
    const backlog = session.queue.length;
    const compress = backlog > QUEUE_SOFT_LIMIT
      ? Math.min(4, 1 + (backlog - QUEUE_SOFT_LIMIT) / 60)
      : 1;
    return Math.max(16, Math.round(gap / (profile().sendScale * compress)));
  }

  function scheduleDrain() {
    if (session.queueTimer || session.destroyed) return;
    session.queueTimer = setTimeout(() => {
      session.queueTimer = 0;
      drain();
    }, Math.max(16, sendGap()));
  }

  function drain() {
    if (session.destroyed || !session.renderer || !session.queue.length) return;
    // 先丢弃等待过久的弹幕。
    const now = performance.now();
    while (session.queue.length && now - session.queue[0].at > QUEUE_MAX_AGE) {
      session.queue.shift();
      session.dropped += 1;
    }
    if (!session.queue.length) return;
    const gap = sendGap();
    if (performance.now() - session.lastSendAt < gap) {
      scheduleDrain();
      return;
    }
    // 单次最多补发 MAX_PER_DRAIN 条。
    let attempts = 0;
    while (session.queue.length && attempts < MAX_PER_DRAIN) {
      if (performance.now() - session.lastSendAt < gap) break;
      const entry = session.queue.shift();
      const result = emit(entry.msg);
      session.lastSendAt = performance.now();
      attempts += 1;
      if (result === 'full') {
        // 满轨的弹幕放回队尾，下一轮重试。
        session.queue.push(entry);
        continue;
      }
      if (result === 'dropped') session.dropped += 1;
    }
    if (session.queue.length) scheduleDrain();
  }

/// 表情尺寸：大表情高 = 行数 × 行高；小表情缩到一个行高内。
function fitEmoticon(width, height, fontSize, lines = 0) {
  const rawWidth = Math.max(1, Number(width) || 20);
  const rawHeight = Math.max(1, Number(height) || 20);
  const big = Number(lines) > 0;
  const nextHeight = big
    ? lineHeightFor(fontSize) * Number(lines)
    : Math.max(12, Math.round(fontSize * LINE_HEIGHT_RATIO * 0.92));
  let nextWidth = (rawWidth / rawHeight) * nextHeight;
  // 横条表情限宽：大表情 10 字宽、小表情 8 字宽，超出时等比缩小。
  const maxWidth = fontSize * (big ? 10 : 8);
  if (nextWidth > maxWidth) {
    const scale = maxWidth / nextWidth;
    return {
      width: Math.max(1, Math.round(maxWidth)),
      height: Math.max(1, Math.round(nextHeight * scale)),
    };
  }
  return {
    width: Math.max(1, Math.round(nextWidth)),
    height: Math.max(1, Math.round(nextHeight)),
  };
}

  /// 登记表情图并返回图片 id；复用条件是 url 与尺寸都相同。
  function registerImage(url, size, preferredId) {
    const key = `${url}@${size.width}x${size.height}`;
    const known = session.imageIdByUrl.get(key);
    if (known) return known;
    let id = String(preferredId || '').replace(/[[\]]/g, '');
    if (!id || session.imageUrlById.has(id)) id = `e${++session.imageSeq}`;
    session.imageUrlById.set(id, url);
    session.imageIdByUrl.set(key, id);
    session.images.push({ id, url, width: size.width, height: size.height });
    preloadEmoticon(url);
    return id;
  }

  /// 把正文中的表情替换成 `[图片id]` 占位符；关闭表情时原样返回。
  function applyEmoticons(message, fontSize) {
    // 不要写成 `message.text || ''`：数字 0 之类的假值会被吞掉。
    let text = message.text == null ? '' : String(message.text);
    const list = Array.isArray(message.emoticons) ? message.emoticons : null;
    if (!list || !list.length) return text;
    if ((session.config || FALLBACK_CONFIG).emoji === false) return text;
    // 原始正文（后面 text 会被一条条替换掉，判「整条是不是一个表情」得看原文）。
    const whole = text.trim();
    for (const emoticon of list) {
      const key = typeof emoticon?.key === 'string' ? emoticon.key : '';
      const url = typeof emoticon?.url === 'string' ? emoticon.url : '';
      if (!key || !url || !text.includes(key)) continue;
      const bracketed = key.startsWith('[') && key.endsWith(']');
      // 仅当正文只有该表情时才按大表情处理。
      const big = Boolean(emoticon.big) && whole === key.trim();
      // 大表情的高 = 设置里的行数 × 行高；小表情仍是「一个行高」量级。
      const size = fitEmoticon(emoticon.width, emoticon.height, fontSize, big ? bigEmojiLines() : 0);
      const id = registerImage(url, size, bracketed ? key.slice(1, -1) : key);
      text = text.split(key).join(`[${id}]`);
    }
    return text;
  }

  /// 尝试上屏，返回 'shown' / 'full'（可重试）/ 'dropped'。
  function emit(message) {
    const config = session.config || FALLBACK_CONFIG;
    const renderer = session.renderer;
    if (!renderer) return 'full';
    const fontSize = Math.max(12, Math.min(48, Number(config.font) || FALLBACK_CONFIG.font));
    // 颜色截断为 RGB888，避免带 alpha 的值拼出非法 hex。
    const color =
      message.color == null
        ? '#ffffff'
        : `#${(Number(message.color) & 0xffffff).toString(16).padStart(6, '0')}`;
    const position = Number(message.position) || 0;
    const barrageType = position === 1 ? 'top' : position === 2 ? 'bottom' : 'scroll';
    // 不传 speed，由库按固定时长模式计算速度。
    const option = {
      id: `d${++session.seq}`,
      time: Math.max(0, clockSource.currentTime * 1000),
      text: applyEmoticons(message, fontSize),
      fontSize,
      // 行高是倍数，与算显示区域用的是同一个常量。
      lineHeight: LINE_HEIGHT_RATIO,
      color,
      barrageType,
      addition: { user: message.user || '' },
    };
    if (barrageType !== 'scroll') option.duration = 4200;
    const calc = renderer.barrageLayoutCalculate;
    const before = calc?.scrollBarrageInstances.length || 0;
    // 轨道被重排清空时先补回来，否则这条弹幕拿到 undefined 的 top、整层都看不见。
    ensureTracks();
    let created = null;
    try {
      renderer.send(option);
      const instances = calc?.scrollBarrageInstances;
      if (instances && instances.length > before) created = instances[instances.length - 1];
    } catch {
      /* 库对个别非法参数会抛错，忽略单条不影响其他弹幕 */
      return 'dropped';
    }
    if (!created) return 'dropped';
    // 发送前确保避让表已抬到该弹幕的 grade。
    if (Number(created.grade) > (session.gradeMapGrade || 1)) syncMaxGrade(Number(created.grade));
    // 用实测宽度修正发送间隔（EMA）；高轨道弹幕不计入。
    if (!(Number(created.grade) > 1)) {
      session.widthAvg = session.widthAvg
        ? session.widthAvg * 0.85 + created.width * 0.15
        : created.width;
    }
    // 满轨时先撤下实例，交给 drain 重试。
    if (created.fallbackTrack) {
      dropInstance(created);
      return 'full';
    }
    // 补登记相交轨道的占用表。
    if (barrageType === 'scroll') registerOccupancy(created);
    // 上屏计数与实例 id 分开，仅统计真正上屏的。
    session.sent += 1;
    return 'shown';
  }

  /// 把放不下的实例从库中移除。
  function dropInstance(instance) {
    const calc = session.renderer?.barrageLayoutCalculate;
    if (!calc) return;
    // 不记 `dropped`：撤下只因本轮满轨，最终丢弃由 drain 决定。
    for (const list of [calc.scrollBarrageInstances, calc.canShowScrollBarrageInstances]) {
      const index = list.indexOf(instance);
      if (index >= 0) list.splice(index, 1);
    }
    // 交叉登记也写了虚拟轨道的占用表，撤下时要一并清掉，否则它会一直挡着后来的弹幕。
    for (const track of calc.virtualTrackAlgorithm?.virtualTracks || []) {
      const index = Array.isArray(track.barrages) ? track.barrages.indexOf(instance) : -1;
      if (index >= 0) track.barrages.splice(index, 1);
    }
  }

  // 尺寸变化（进出全屏、窗口缩放、聊天栏收起）后要让库重新计算画布与轨道。
  session.observer = new ResizeObserver(scheduleResize);
  session.observer.observe(host);

  measure();
  build();
  syncRenderConfig();

  // 只重新拉起渲染循环，暂停时不停止它。
  video.addEventListener('play', () => {
    if (session.enabled) session.renderer?.play();
  });
  // 定时兜底拉起渲染循环。
  session.keepAliveTimer = setInterval(() => {
    if (session.destroyed || !session.enabled) return;
    const renderer = session.renderer;
    if (renderer && !renderer.animationHandle) renderer.play();
  }, 5000);

  // 调试句柄：在控制台里可以查 sent / queued / renderer 状态，也能手动塞一条弹幕试样式。
  const api = {
    /** 应用新的弹幕设置（字号/速度/区域/行数/不透明度/描边/性能档位等） */
    update(config) {
      const previous = session.config;
      session.config = { ...FALLBACK_CONFIG, ...(config || {}) };
      // 关闭表情时清空已登记图片。
      if (session.config.emoji === false) clearImages();
      if (!session.renderer) return;
      // 字号或性能档位变化需重建。
      if (
        !previous ||
        previous.font !== session.config.font ||
        previous.perf !== session.config.perf ||
        previous.fontFamily !== session.config.fontFamily
      ) {
        rebuild();
        return;
      }
      // 行数/区域/速度只影响渲染配置，库内部重排轨道并保留现有弹幕实例。
      syncRenderConfig();
      // 大表情行数变化：图片尺寸与避让表都要按新档位重算。
      // 只清图片会让屏上实例引用到不存在的图，重建一次最干净。
      if (previous && previous.bigEmojiLines !== session.config.bigEmojiLines) {
        rebuild();
        return;
      }
      // 帧率上限不受重建影响，改完立即生效。
      applyFrameLimit();
      ensureTracks();
      syncMaxGrade();
      ensureLayout();
    },
    /** 立刻显示一条弹幕；超出发送速率时先入队，排队期间一条都不会被悄悄丢掉 */
    send(message) {
      if (session.destroyed || !session.renderer) return;
      // 仅在堆到硬上限时挤掉最旧的一条。
      if (session.queue.length >= QUEUE_HARD_LIMIT) {
        session.queue.shift();
        session.dropped += 1;
      }
      session.queue.push({ msg: message, tries: 0, at: performance.now() });
      if (performance.now() - session.lastSendAt >= sendGap()) drain();
      else scheduleDrain();
    },
    /** 开关弹幕（保留已排队的消息，重新打开后继续） */
    setEnabled(enabled) {
      session.enabled = Boolean(enabled);
      session.renderer?.switch(session.enabled);
      if (!session.enabled) {
        session.queue.length = 0;
        clearTimeout(session.queueTimer);
        session.queueTimer = 0;
      }
    },
    /** 清空当前屏上的弹幕和队列 */
    clear() {
      session.queue.length = 0;
      clearTimeout(session.queueTimer);
      session.queueTimer = 0;
      if (!session.renderer) return;
      try {
        session.renderer.setBarrages([]);
        session.renderer.renderFrame();
      } catch {
        /* 忽略 */
      }
    },
    /** 重建渲染器：直播流重连、时间轴归零时调用（会整层清空，别用它做日常回收） */
    reset() {
      rebuild();
    },
    /** 摘掉已经滚出屏幕的实例，返回清掉的条数；屏上正在滚的不受影响 */
    prune() {
      return pruneEnded();
    },
    /** 已收下的弹幕数量，用于判断是否需要回收 */
    get sent() {
      return session.sent;
    },
    /** 回收阈值随性能档位变化：越极速越早清理，控制每帧遍历的实例数 */
    get limit() {
      return profile().maxStored;
    },
    destroy() {
      session.destroyed = true;
      session.queue.length = 0;
      clearTimeout(session.queueTimer);
      clearInterval(session.keepAliveTimer);
      session.keepAliveTimer = 0;
      if (session.resizeHandle) cancelAnimationFrame(session.resizeHandle);
      session.resizeHandle = 0;
      session.observer?.disconnect();
      dispose();
      host.remove();
    },
  };

  host.__danmaku = {
    get sent() {
      return session.sent;
    },
    get queued() {
      return session.queue.length;
    },
    get dropped() {
      return session.dropped;
    },
    get pruned() {
      return session.pruned;
    },
    get renderer() {
      return session.renderer;
    },
    get config() {
      return session.config;
    },
    /** 手动塞一条弹幕（调试表情/颜色时省得等真实弹幕） */
    send(message) {
      api.send(message);
    },
    /** 手动触发一次回收（调试用：看清掉多少条、屏上是否稳定） */
    prune() {
      return pruneEnded();
    },
  };

  return api;
}
