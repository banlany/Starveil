// 弹幕层：封装 fly-barrage（canvas 渲染 + 虚拟轨道避让），对外只暴露项目需要的接口。
//
// 设计要点：
// 1. **弹幕流与直播流彻底解耦**：库每帧读一次「进度」来算弹幕位置，这个进度由
//    我们喂进去的时钟源提供。这里用的是**单调墙钟**（createMonotonicClock），
//    不读 `video.currentTime`、也不理会 `video.paused`——直播流暂停、缓冲、
//    断流重连、还没开播，弹幕都照常流动。早期版本直接绑视频时间，上面任何一种情况
//    都会让整层弹幕冻住，而聊天栏还在刷新，看着就像弹幕流被直播流拖死了。
// 2. 库内部不回收已下屏的弹幕实例，长时间观看会持续增长；
//    超过阈值时走 `prune()` 摘掉滚出屏幕的实例，屏上正在滚的不受影响。
// 3. 库没有「满轨排队」：轨道占满时它会把弹幕随便塞进一条轨道（叠字）。
//    这里用发送队列限速；被判定满轨的**退回队尾稍后重试**，而不是当场丢掉。
//    真正允许丢弃的只有一种情况：这条在队列里等得比 QUEUE_MAX_AGE 还久
//    （轨道容量是物理上限，等太久的弹幕再放出来也只是错位的旧话）。
// 4. **尺寸变化不重建渲染器**：进出全屏、窗口缩放、聊天栏收起都只走库自己的
//    `resize()` + `setRenderConfig()`，弹幕实例、待发队列和计数全部保留。
//    早期版本这里直接 `rebuild()`，结果每切一次全屏弹幕就「重新加载」一次。
// 5. **时钟要单调且平滑**：墙钟本身每帧都在变，不需要再做帧间预测；
//    它也不会因为视频时间跳变（换线、跳帧）而整体回退。

import { IS_MOBILE } from './platform.js';

const RENDERER_KEY = 'FlyBarrage';

/// 库里 `lineHeight` 是**行高倍数**（内部按 `fontSize * lineHeight` 算高度），不是像素。
/// 算显示区域和生成弹幕实例必须是同一个数，否则轨道会比区域高一点。
const LINE_HEIGHT_RATIO = 1.35;

/// 兜底默认值与 store.js 的 `DEFAULTS.danmaku` 保持一致。
/// 配置还没加载时如果两处不同，弹幕会先按另一套字号/粗细画一遍再跳变。
const FALLBACK_CONFIG = {
  font: 20,
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

/// 大表情（收藏集/房间表情，只能整条单独发送）能选几种大小。
/// 单位是「行」而不是像素：一行 = 一个弹幕轨道高，所以「占 2 行」既是画多大、
/// 也是轨道算法要给它留几条轨道（见 syncMaxGrade）。设置页与直播间弹幕设置共用这份表。
export const BIG_EMOJI_LINE_OPTIONS = [1, 2, 3, 4, 5];

const DEFAULT_BIG_EMOJI_LINES = 2;

/// 性能档位：只改**绘制成本**与实例上限，不动用户设定的字号、颜色、区域。
/// canvas 上最贵的是阴影和描边，所以档位越高越倾向把它们关掉；
/// DPR 是第二贵的因素（画布面积按 dpr² 增长），极速档把它压到 1；
/// sendScale < 1 表示「发送间隔放大」，档位越高每秒进的弹幕越少，绘制压力更小。
///
/// 移动端默认就把 DPR 压到 2：安卓手机的 devicePixelRatio 常见 2.75~3，
/// 而库每帧要「清离屏画布 → 画弹幕 → 清主画布 → 整屏合成」，
/// 填充量按 dpr² 走，3 降到 2 直接省掉一半多，20px 的字在 2 倍下依然锐利。
const PERF_PROFILES = {
  balanced: { maxStored: 1500, dprCap: IS_MOBILE ? 2 : 0, shadowBlur: 2, minSpace: 26, sendScale: 1, noStroke: false },
  smooth: { maxStored: 1000, dprCap: 1.75, shadowBlur: 0, minSpace: 22, sendScale: 0.8, noStroke: false },
  ultra: { maxStored: 700, dprCap: 1.25, shadowBlur: 0, minSpace: 18, sendScale: 0.6, noStroke: true },
};

/// 性能档位与帧率上限的选项表。
/// 设置页与直播间弹幕设置弹层都从这里取，避免两处各写一份导致取值/文案不一致。
export const PERF_OPTIONS = [
  { value: 'balanced', label: '平衡（默认）', desc: '保留阴影与描边' },
  { value: 'smooth', label: '流畅', desc: '关阴影，降低画布精度' },
  { value: 'ultra', label: '极速', desc: '再关描边，每秒进入的弹幕更少' },
];

export const FPS_OPTIONS = [
  { value: 0, label: '跟随屏幕', desc: '不限制重绘频率' },
  { value: 60, label: '60 帧', desc: '常规上限' },
  { value: 30, label: '30 帧', desc: '省电档' },
];

/// 单次 drain 最多补发几条。批量发送时不能一口气全塞进去，
/// 否则一帧里创建大量实例，正好撞上掉帧。
const MAX_PER_DRAIN = 3;

/// 待发队列的两个上限。
/// 超过软上限就开始**压缩发送间隔**，优先把积压消化掉——刷屏时本来也分不清快慢，
/// 但少丢一条是一条。硬上限只是防内存失控的兜底（40 条/秒也要堆两分钟才到），
/// 到了这一步说明无论如何都发不完，才丢最旧的。
const QUEUE_SOFT_LIMIT = 80;
const QUEUE_HARD_LIMIT = 4000;

/// 一条弹幕最多在队列里等多久（毫秒）。
///
/// 轨道容量是物理上限（十来个轨道 × 每条滚 N 秒 ≈ 每秒几条），刷屏时进得比出得快，
/// 硬排队只会让队列越拖越长：观众看到的是几十秒前的话，直播间早就翻篇了。
/// 所以等太久的一律按「显示不下」处理——超过这个时间还没轮到的，允许丢。
/// 反过来，一两百毫秒的瞬时爆发（比如一堆人同时刷「哈哈」）完全在这个窗口里，一条都不会少。
const QUEUE_MAX_AGE = 3000;

/// 已经预热过的表情图（url → Image）。持有引用是为了避免图片还没下载完就被回收，
/// 命中之后浏览器缓存会接管，弹幕库自己再取一次就是同步的。
const preloadedEmoticons = new Map();

function preloadEmoticon(url) {
  if (!url || preloadedEmoticons.has(url)) return;
  const image = new Image();
  image.decoding = 'async';
  // 加载失败的从表里删掉，下次同一张图还有机会重试。
  image.onerror = () => preloadedEmoticons.delete(url);
  image.src = url;
  preloadedEmoticons.set(url, image);
}

function rendererClass() {
  const lib = window[RENDERER_KEY];
  return lib?.BarrageRenderer || lib?.default || null;
}

/// 弹幕时钟（秒），给弹幕库当进度源。
///
/// **只用单调墙钟，完全不看视频**。理由：
/// - 库每画一帧读一次进度算位置。早期版本绑 `video.currentTime`，而这个值在 WebView 里
///   不保证每帧都变（安卓上常见十几到几十毫秒跳一次），弹幕就会一段一段往前挪；
/// - 更糟的是它跟着视频走：暂停、缓冲（readyState 掉下来）、断流、还没开播，
///   进度一律不动 → 整层弹幕冻住，而聊天栏还在刷新，看起来就是「弹幕流挂了」。
///
/// 直播里弹幕的语义本来就是「此刻发的」，跟真实时间走才对。墙钟（`performance.now()`）
/// 单调递增、不受系统时间调整影响，视频卡多久都不影响它；换线重连也不会回退。
/// 代价是弹幕与画面不再逐帧对齐，但直播流本身就有秒级延迟，这点偏差看不出来。
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
  // 时钟对象要**始终是同一个引用**：库在构造时按引用把它存下来，
  // 之后 rebuild 只是重建渲染器，时钟继续往前跑，弹幕不会因为重建而集体「归零重放」。
  const clockSource = {
    get currentTime() {
      return clock.currentTime;
    },
    // 永远返回「在播放」：库的 `play()` 看到 paused 为真就只画一帧、不启动渲染循环，
    // 这会直接表现成「弹幕层空着不动」。弹幕是否流动只由我们自己的开关决定。
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
    // 弹幕实例 id 的独立自增序号：回收实例时 `sent` 会归零，但 id 绝不能复用
    // （库的预渲染缓存按 id 存 ImageBitmap，复用会让新弹幕画出上一条的图）。
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
    // 表情图：`images` 直接交给库（构造时按引用持有，push 之后新弹幕立刻能用），
    // 两个 Map 负责 url ↔ id 双向去重，避免同张图反复登记。
    images: [],
    imageIdByUrl: new Map(),
    imageUrlById: new Map(),
    imageSeq: 0,
    // 轨道避让表（vtToVtsMap）是按「大表情占几行」建的；这里记住建表时的行数，
    // 免得库自己改过 maxGrade 之后我们误判成「已经是最新的」。
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

  function build() {
    if (!Renderer) return;
    session.renderer = new Renderer({
      container: host,
      video: clockSource,
      renderConfig: buildRenderConfig(),
      // 库把这份数组按引用存下来，之后 push 新表情不需要重建渲染器。
      barrageImages: session.images,
    });
    session.sent = 0;
    primeTracks();
    // 弹幕关闭状态下建渲染器不要自己开播，否则会出现「关掉了还在刷」。
    if (session.enabled) session.renderer.play();
    else session.renderer.switch(false);
    applyPerf();
  }

  /// 库的 send() 依赖虚拟轨道已经建好（要读 virtualTrack.top），
  /// 而轨道只在 setBarrages()/resize 时才会初始化；直播场景是逐条 send，
  /// 所以这里显式初始化一次，否则每条 send 都会抛 “reading 'top'”。
  function primeTracks() {
    const calculate = session.renderer?.barrageLayoutCalculate;
    const algorithm = calculate?.virtualTrackAlgorithm;
    if (!algorithm) return;
    if (algorithm.realTracks?.length && algorithm.virtualTracks?.length) return;
    const config = session.config || FALLBACK_CONFIG;
    try {
      // initTracks 会顺手按**当时的** maxGrade 建避让表，所以先抬到「大表情占几行」。
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

  /// **让库把「大表情占几行」算进避让范围。**
  ///
  /// 库的 `vtToVtsMap`（轨道 → 与它交叉、需要一起检查的高轨道）只在 `initTracks` 里
  /// 按当时的 `maxGrade` 建一次。建表时 `maxGrade = 1` 等于告诉库「每条弹幕只占一行」：
  /// 一条两行高的大表情被放进 2~3 号轨道后，后面来的小弹幕只检查自己那一条轨道，
  /// 完全看不见它 → 直接压上去。所以大表情能用几行，`maxGrade` 就得是几。
  ///
  /// 只重建这张表、不动轨道本身：屏上的弹幕实例（含它们的 top）都还在。
  function syncMaxGrade(extra = 0) {
    const algorithm = session.renderer?.barrageLayoutCalculate?.virtualTrackAlgorithm;
    if (!algorithm?.virtualTracks?.length) return;
    const grade = Math.max(bigEmojiLines(), Number(extra) || 0, 1);
    // 用自己记的「这张表是按几行建的」判断，而不是 maxGrade：
    // 库的 layoutScrollBarrages 会改 maxGrade 却不重建表，两者可能对不上。
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

  /// 轨道兜底：库在 `setRenderConfig` / `resize` 重排时会先清空轨道表，
  /// 之后若没人再触发布局，新弹幕就拿不到 `top`（`show` 是 true 但 `top` 是 undefined），
  /// 表现是**弹幕整个不显示**、且不会报错。
  /// 这里在发送前检查一次，轨道没了就重建并把已有实例重新排一遍。
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

  /// 把刚放进轨道的那条弹幕，补登记到**所有轨道范围与它相交**的虚拟轨道里。
  ///
  /// 库的增量插入（`avoidOverlapInsert`）对「空虚拟轨道」有一条捷径：
  /// 只要这条虚拟轨道自己的 `barrages` 是空的就直接放进去，不检查与它相交的其他轨道。
  /// 而它登记时只写进被选中的那一条虚拟轨道——一条两行高的大表情只属于某个 grade 2 轨道，
  /// 于是「1 号实际轨道」那条 grade 1 虚拟轨道仍然是空的，下一条普通弹幕走捷径直接压上去。
  /// 反过来也一样（先有普通弹幕、再来大表情）。
  ///
  /// 这里按实际占用的轨道区间补一遍登记，`isEmpty` 和 `getLastBarrage()` 才名副其实。
  /// 新增的实例总是最后一个，所以数组仍是按时间顺序，插入位置的计算不受影响。
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

  /// 清空已登记的表情图（连同 url ↔ id 去重表）。
  /// 库是按 `[图片id]` 匹配正文的：只把正文写回文字而留着旧图，
  /// 弹幕层会继续把 `[热]` 画成表情（聊天栏是纯 DOM，所以才出现「聊天生效、弹幕不生效」）。
  function clearImages() {
    session.images.length = 0;
    session.imageIdByUrl.clear();
    session.imageUrlById.clear();
  }

  /// 摘掉已经滚出屏幕（`endTime` 已过）的弹幕实例，返回清掉的条数。
  ///
  /// 库只按 `time <= endTime` 决定画不画：实例本身永远留在
  /// `scrollBarrageInstances` / `canShowScrollBarrageInstances` 和每条虚拟轨道的
  /// `barrages` 里，数组只增不减 —— 每帧渲染都要对这个越来越长的集合做一次 filter，
  /// 预渲染缓存还按条存着一张 ImageBitmap。所以长时间观看必须回收。
  ///
  /// 回收是就地剔除而不是重建渲染器：仍在屏上的实例 `endTime > now`，一条都不动，
  /// 所以画面不会闪、不会跳位；顺手把它们的位图从预渲染缓存里删掉。
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

  /// 整体重建渲染器。只在两种情况下用：
  /// 直播流重连（时间轴归零）、字号变化（每条弹幕实例的宽高是创建时固定的）。
  function rebuild() {
    if (session.destroyed || !Renderer) return;
    // **不清队列**：待发的弹幕还没上过屏，重建只是换了个画布，它们照旧可以显示。
    // 清理定时器只是让它按新配置重新起一轮节奏。
    clearTimeout(session.queueTimer);
    session.queueTimer = 0;
    // 表情尺寸是按字号算的，重建后（字号/档位变了）必须重新量一遍；
    // 已经上屏的实例随 dispose 一起没了，不存在「旧图新尺寸」的问题。
    clearImages();
    dispose();
    measure();
    build();
  }

  function lineHeightFor(font) {
    return Math.max(18, Math.round(font * LINE_HEIGHT_RATIO));
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
    // 极速档无视用户的描边开关：描边 + 阴影是弹幕卡顿的主因。
    const strokeWidth = perf.noStroke ? 0 : config.stroke ? Math.max(0, Number(config.strokeWidth) || 0) : 0;
    // 用户设定的「滚动速度」是**弹幕持续秒数**（越小越快）。
    // 固定时长模式：所有弹幕都用这段时间穿过画面，(画布宽 + 弹幕宽) / 时长 得到每条的速度，
    // 长弹幕自动更快、短弹幕更慢，不会出现「长弹幕挂半天不走」。防追尾由库按每条弹幕的
    // 基准速度再动态减速。
    const durationSeconds = Math.max(3, Math.min(20, Number(config.speed) || 8));
    return {
      scrollDuration: durationSeconds * 1000,
      // 兜底用的固定像素速度：库在没有 scrollDuration 时才用它，口径与上面一致。
      speed: Math.max(60, (session.width || container.clientWidth || 960) / durationSeconds),
      opacity: Math.max(0.2, Math.min(1, (config.opacity ?? 95) / 100)),
      renderRegion: Math.max(0.1, Math.min(1, regionPx / height)),
      fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      fontWeight: String(config.weight || FALLBACK_CONFIG.weight),
      heightReduce: 0,
      avoidOverlap: true,
      minSpace: perf.minSpace,
      strokeStyle: 'rgba(0, 0, 0, 0.85)',
      lineWidth: strokeWidth,
      lineCap: 'round',
      lineJoin: 'round',
      miterLimit: 10,
      shadowColor: 'rgba(0, 0, 0, 0.45)',
      shadowBlur: strokeWidth > 0 ? perf.shadowBlur : 0,
      shadowOffsetX: 0,
      shadowOffsetY: 1,
    };
  }

  /// 把性能档位落到渲染器实例上：DPR 上限 + 帧率上限。
  /// 这两项都不在库的 renderConfig 里，只能改实例字段。
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

  /// 帧率上限：库的渲染循环是裸 rAF，没有节流开关，这里包一层 `_render`。
  /// 跳帧时必须自己把下一帧排上，否则链条会断（续帧写在原函数末尾）。
  ///
  /// 判定要留余量：60Hz 屏的 rAF 间隔本来就在 16.67ms 上下抖，若写成
  /// 「小于 interval 就跳过」，几乎每帧都会被判成太早，于是隔一帧画一次，
  /// 实际帧率掉到一半（60 档变 30、30 档变 20，看着就是「一卡一卡」）。
  /// 留 1/4 帧容差后，与屏幕同频的档位是满帧，跨档位（120Hz 屏选 60）才真正抽帧。
  function applyFrameLimit() {
    const renderer = session.renderer;
    if (!renderer) return;
    const fps = Number((session.config || FALLBACK_CONFIG).fps) || 0;
    if (!fps) {
      // 跟随屏幕：把包过的函数还原成原型上的原版。
      if (renderer.__starveilRender) {
        try {
          delete renderer._render;
        } catch {
          /* 忽略 */
        }
      }
      return;
    }
    const original = renderer.__starveilRender || renderer._render;
    renderer.__starveilRender = original;
    const interval = 1000 / Math.max(10, fps);
    const threshold = interval * 0.75;
    let last = 0;
    renderer._render = function throttledRender() {
      const now = performance.now();
      if (now - last < threshold) {
        requestAnimationFrame(() => this._render());
        return;
      }
      last = now;
      return original.call(this);
    };
  }

  function measure() {
    session.width = host.clientWidth;
    session.height = host.clientHeight;
  }

  /// 把当前设置同步给渲染器。
  /// 只在真正影响渲染的字段变化时才调用，否则库会做一次没必要的重排。
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

  /// 重排之后确认「可渲染集合」没有异常清空。
  /// 集合空了的表现是画面突然一片空白；这里发现为空就再排一次轨道。
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
    // 尺寸变化不应该停掉动画，但保险起见确认渲染循环还在跑。
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

  /// 两条弹幕之间的最小间隔（毫秒）：按「轨道实际能吸收的速率」算，而不是拍一个固定值。
  ///
  /// 一条弹幕要等前一条的右边缘让出 `宽 + 间距`，它才能在右边缘入场；
  /// 固定时长模式下速度是 (画布宽 + 宽) / 时长，于是单轨每
  ///   `(宽 + 间距) × 时长 / (画布宽 + 宽)`
  /// 毫秒才能放一条，再除以轨道数就是整体的入场速率。宽度用实测的移动平均值估算。
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
    // 积压越多发得越快（最多压到 1/4 间隔）：宁可这一屏挤一点，也别把弹幕存在队列里
    // 越攒越旧——观众看到的是「三分钟前的话」，还不如早点放出来。
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
    // 先把等太久的清掉：它们的「出现时刻」已经过去，补放出来只是错位的旧话。
    // 这一步算「显示不下」，会计入 dropped；队列里剩下的都是还来得及显示的。
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
    // 一次最多补发 MAX_PER_DRAIN 条：时间戳间隔检查在循环里只能发出 1~2 条，
    // 但 lastSendAt 很久没更新时（切标签页、窗口刚恢复）会一次塞进整批。
    let attempts = 0;
    while (session.queue.length && attempts < MAX_PER_DRAIN) {
      if (performance.now() - session.lastSendAt < gap) break;
      const entry = session.queue.shift();
      const result = emit(entry.msg);
      session.lastSendAt = performance.now();
      attempts += 1;
      if (result === 'full') {
        // 放回**队尾**，下一轮再看轨道有没有空出来：既不能插队，也不能赖在队头
        // 把后面所有人堵死——那样刷屏过后队列会拖几十秒，新弹幕还被压在
        // 一堆注定要丢的旧弹幕后面。多久算「等太久」由 QUEUE_MAX_AGE 统一裁决。
        session.queue.push(entry);
        continue;
      }
      if (result === 'dropped') session.dropped += 1;
    }
    if (session.queue.length) scheduleDrain();
  }

/// 表情图尺寸对齐。
///
/// **大表情**（`lines > 0`，行数由设置项 `danmaku.bigEmojiLines` 决定）：
/// 高 = 行数 × 行高。行高就是轨道高度，所以高 2 行 = 轨道算法里的 grade 2，
/// 占位和尺寸天然一致——想让它真占两条轨道，不用另做一套布局。
/// **小表情**（`lines = 0`，正文里的 `[热]`）：等比缩到「一个行高」附近，
/// 它要和同一行的文字齐平，撑高轨道反而挤掉正常弹幕。
function fitEmoticon(width, height, fontSize, lines = 0) {
  const rawWidth = Math.max(1, Number(width) || 20);
  const rawHeight = Math.max(1, Number(height) || 20);
  const big = Number(lines) > 0;
  const nextHeight = big
    ? lineHeightFor(fontSize) * Number(lines)
    : Math.max(12, Math.round(fontSize * LINE_HEIGHT_RATIO * 0.92));
  let nextWidth = (rawWidth / rawHeight) * nextHeight;
  // 横条表情（收藏集里常见）限宽：大表情按 10 个字宽，小表情 8 个字符宽，
  // 否则一条就能占掉半屏、把后面的弹幕全挤掉。
  // 被限宽时**等比缩回去**，高度跟着变——grade 由真实高度算，不会出现「说占两行其实只占一行」。
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

  /// 登记一张表情图，返回库用的图片 id（正文里会写成 `[id]`，所以不能带中括号）。
  /// 同一张图重复出现时复用已有 id；同名但不同图（不同房间的 `[热]`）另起一个。
  function registerImage(url, size, preferredId) {
    const known = session.imageIdByUrl.get(url);
    if (known) return known;
    let id = String(preferredId || '').replace(/[[\]]/g, '');
    if (!id || session.imageUrlById.has(id)) id = `e${++session.imageSeq}`;
    session.imageUrlById.set(id, url);
    session.imageIdByUrl.set(url, id);
    session.images.push({ id, url, width: size.width, height: size.height });
    preloadEmoticon(url);
    return id;
  }

  /// 把正文里的表情片段换成库认识的 `[图片id]` 占位符。
  ///
  /// 两种形态（见 `live_core` 的 `Emoticon`）：
  /// - 内嵌小表情：正文本来就是 `[热]`，图片 id 取「热」后无需改动正文；
  /// - 大表情：正文是表情名（`冲鸭`，收藏集那类自带中括号），必须整段替换成占位符，
  ///   否则库只会把它当普通文字画出来。
  ///
  /// 关掉「显示弹幕表情」时原样返回文字：`[大哭]`、`[热]`、`[下次一定]` 这些占位符照旧画出来，
  /// 大表情的正文本来就是可读的词，也不动。图片一张都不登记。
  function applyEmoticons(message, fontSize) {
    // 不要写成 `message.text || ''`：数字 0 之类的假值会被吞掉。
    let text = message.text == null ? '' : String(message.text);
    const list = Array.isArray(message.emoticons) ? message.emoticons : null;
    if (!list || !list.length) return text;
    if ((session.config || FALLBACK_CONFIG).emoji === false) return text;
    for (const emoticon of list) {
      const key = typeof emoticon?.key === 'string' ? emoticon.key : '';
      const url = typeof emoticon?.url === 'string' ? emoticon.url : '';
      if (!key || !url || !text.includes(key)) continue;
      const bracketed = key.startsWith('[') && key.endsWith(']');
      // 大表情的高 = 设置里的行数 × 行高；小表情仍是「一个行高」量级。
      const size = fitEmoticon(emoticon.width, emoticon.height, fontSize, emoticon.big ? bigEmojiLines() : 0);
      const id = registerImage(url, size, bracketed ? key.slice(1, -1) : key);
      text = text.split(key).join(`[${id}]`);
    }
    return text;
  }

  /// 试着把一条弹幕送进库里。
  /// 返回 `'shown'` 成功上屏、`'full'` 当下没有空轨道（可以稍后重试）、
  /// `'dropped'` 参数不合法等没法显示的原因（重试也没用）。
  function emit(message) {
    const config = session.config || FALLBACK_CONFIG;
    const renderer = session.renderer;
    if (!renderer) return 'full';
    const fontSize = Math.max(12, Math.min(48, Number(config.font) || FALLBACK_CONFIG.font));
    // 颜色统一截到 RGB888：平台偶尔会下发 32 位带 alpha 的值，
    // `padStart(6)` 不会截断，会拼出 `#xxxxxxxx` 这种非法 hex —— canvas 直接不画，
    // 表现就是「彩色弹幕不渲染」。
    const color =
      message.color == null
        ? '#ffffff'
        : `#${(Number(message.color) & 0xffffff).toString(16).padStart(6, '0')}`;
    const position = Number(message.position) || 0;
    const barrageType = position === 1 ? 'top' : position === 2 ? 'bottom' : 'scroll';
    // 速度策略：不在这里传 addition.speed，让库走**固定时长模式**——
    // 每条弹幕按 (画布宽 + 自身宽) / scrollDuration 单独算速度，长弹幕更快、短弹幕更慢，
    // 所有弹幕「同时开始、同时结束」。追尾由库的轨道分配器按每条弹幕的基准速度动态减速。
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
    // 大表情占几行：把避让表抬到它的实际 grade。
    // 正常情况配置已经抬好了（primeTracks/syncMaxGrade），这里兜住
    // 「横条表情被限宽后变矮」之外的极端情况（比如轨道数刚变过）。
    if (Number(created.grade) > (session.gradeMapGrade || 1)) syncMaxGrade(Number(created.grade));
    // 用实测宽度修正发送速率（EMA），下一次 sendGap() 会更接近真实轨道容量。
    // 高轨道弹幕（大表情）不算进来：它一条顶几条的高度，混进平均会把正常弹幕的节奏拖慢。
    if (!(Number(created.grade) > 1)) {
      session.widthAvg = session.widthAvg
        ? session.widthAvg * 0.85 + created.width * 0.15
        : created.width;
    }
    // 满轨：库把它丢到随机轨道上，直接画就是叠字。这条先从库里撤下来，
    // 交给 drain 退回队列重试——满轨是**这一刻**没位置，不是永远显示不下。
    if (created.fallbackTrack) {
      dropInstance(created);
      return 'full';
    }
    // 交叉登记：一条弹幕占了几条实际轨道，就写进这几条轨道上所有虚拟轨道的占用表。
    // 不做这一步，两行高的大表情和普通弹幕会互相看不见（见 registerOccupancy 注释）。
    if (barrageType === 'scroll') registerOccupancy(created);
    // 回收阈值用的计数（id 走 seq，两者必须分开）。只统计真正上屏的，
    // 满轨重试的那几次不该被算成「已发送」。
    session.sent += 1;
    return 'shown';
  }

  /// 把刚创建但放不下的实例从库里摘干净。
  /// 它没有被塞进任何虚拟轨道，只要从两个实例数组里删掉就不会再参与渲染与布局。
  function dropInstance(instance) {
    const calc = session.renderer?.barrageLayoutCalculate;
    if (!calc) return;
    // 这里不记 `dropped`：撤下只是因为这一轮满轨，drain 会决定是重试还是最终丢弃。
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

  // 只**重新拉起**渲染循环，不在暂停时停它。
  // 早期这里还挂了 `pause → renderer.pause()`，于是点一下暂停（或直播流缓冲、
  // 自动重连时短暂 paused）整层弹幕就冻住，看起来就像弹幕流跟着直播流一起死了。
  // 弹幕要不要流动只由弹幕开关决定，与视频状态无关。
  video.addEventListener('play', () => {
    if (session.enabled) session.renderer?.play();
  });
  // 同理：断流重连、未开播时渲染循环也可能被别处停掉，这里定时补一脚，
  // 保证「弹幕在流动」这件事不依赖任何外部事件。空转开销可以忽略（每 5 秒一次）。
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
      // 关掉表情要把已登记的图片撤干净：库里只认 `[图片id]`，
      // 旧图留着就会继续命中正文里的 `[赞]`／`[热]`，表现是「聊天栏关掉了、弹幕层还画表情」。
      if (session.config.emoji === false) clearImages();
      if (!session.renderer) return;
      // 字号或性能档位变了只能重建：字号决定每条实例的宽高，
      // 性能档位可能改 DPR（画布尺寸），两者都无法在现有实例上热改。
      if (!previous || previous.font !== session.config.font || previous.perf !== session.config.perf) {
        rebuild();
        return;
      }
      // 行数/区域/速度只影响渲染配置，库内部重排轨道并保留现有弹幕实例。
      syncRenderConfig();
      // 大表情大小变了：已登记的图是旧尺寸，清掉让后面的弹幕重新登记；
      // 屏上的旧实例宽高在创建时就定死了，随它滚过去，不必整层重建。
      // 同时把避让表按新行数重建，否则「改成 3 行」之后小弹幕还是看不见它。
      if (previous && previous.bigEmojiLines !== session.config.bigEmojiLines) {
        clearImages();
        syncMaxGrade();
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
      // 只有堆到硬上限才挤掉最旧的，正常直播碰不到这一步（见 QUEUE_HARD_LIMIT）。
      // 早期版本这里写的是 300 条，一场热闹的直播里会不声不响地丢掉大量弹幕。
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
