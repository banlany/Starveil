// 弹幕层：封装 fly-barrage（canvas 渲染 + 虚拟轨道避让），对外只暴露项目需要的接口。
//
// 设计要点：
// 1. fly-barrage 的进度来自 `video.currentTime`，直播流每次重连都会归零，
//    所以重连/换线后必须 `reset()` 重建渲染器，否则旧弹幕的时间轴和新时间轴对不上。
// 2. 库内部不回收已下屏的弹幕实例，长时间观看会持续增长；
//    超过阈值时同样走 `reset()`，代价只是清空当前屏上的弹幕。
// 3. 库没有“满轨排队”，这里保留一个轻量发送队列做限速，
//    避免瞬时爆发的一批弹幕被轨道算法整批丢弃。
// 4. **尺寸变化不重建渲染器**：进出全屏、窗口缩放、聊天栏收起都只走库自己的
//    `resize()` + `setRenderConfig()`，弹幕实例、待发队列和计数全部保留。
//    早期版本这里直接 `rebuild()`，结果每切一次全屏弹幕就「重新加载」一次。

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
};

/// 性能档位：只改**绘制成本**与实例上限，不动用户设定的字号、颜色、区域。
/// canvas 上最贵的是阴影和描边，所以档位越高越倾向把它们关掉；
/// DPR 是第二贵的因素（画布面积按 dpr² 增长），极速档把它压到 1；
/// sendScale < 1 表示「发送间隔放大」，档位越高每秒进的弹幕越少，绘制压力更小。
const PERF_PROFILES = {
  balanced: { maxStored: 1500, dprCap: 0, shadowBlur: 2, minSpace: 26, sendScale: 1, noStroke: false },
  smooth: { maxStored: 1000, dprCap: 2, shadowBlur: 0, minSpace: 22, sendScale: 0.8, noStroke: false },
  ultra: { maxStored: 700, dprCap: 1, shadowBlur: 0, minSpace: 18, sendScale: 0.6, noStroke: true },
};

/// 单次 drain 最多补发几条。批量发送时不能一口气全塞进去，
/// 否则一帧里创建大量实例，正好撞上掉帧。
const MAX_PER_DRAIN = 3;

function rendererClass() {
  const lib = window[RENDERER_KEY];
  return lib?.BarrageRenderer || lib?.default || null;
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
  // 浏览器演示模式下 <video> 没有真实媒体，currentTime 恒为 0，
  // 这里用墙钟兜底，保证弹幕库的进度能推进（真实播放时仍用 currentTime）。
  const bornAt = performance.now();
  const hasMedia = () => video.readyState > 0 || Boolean(video.currentSrc);
  const clockSource = {
    get currentTime() {
      return hasMedia() ? video.currentTime : (performance.now() - bornAt) / 1000;
    },
    get paused() {
      return hasMedia() ? video.paused : false;
    },
  };
  const session = {
    renderer: null,
    config: { ...FALLBACK_CONFIG, ...(config || {}) },
    queue: [],
    queueTimer: 0,
    sent: 0,
    lastSendAt: 0,
    // 实测宽度的移动平均，用于估算轨道容量（见 sendGap）
    widthAvg: 0,
    // 满轨被丢弃的条数，调试用
    dropped: 0,
    destroyed: false,
    observer: null,
    resizeHandle: 0,
    enabled: true,
    width: 0,
    height: 0,
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
    if (!algorithm || algorithm.virtualTracks?.length) return;
    const config = session.config || FALLBACK_CONFIG;
    try {
      algorithm.maxGrade = 1;
      algorithm.initTracks(lineHeightFor(Number(config.font) || FALLBACK_CONFIG.font));
    } catch {
      /* 初始化失败时弹幕不显示，但不影响播放 */
    }
  }

  /// 整体重建渲染器。只在两种情况下用：
  /// 直播流重连（时间轴归零）、字号变化（每条弹幕实例的宽高是创建时固定的）。
  function rebuild() {
    if (session.destroyed || !Renderer) return;
    session.queue.length = 0;
    clearTimeout(session.queueTimer);
    session.queueTimer = 0;
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
  function applyFrameLimit() {
    const renderer = session.renderer;
    if (!renderer) return;
    const fps = Number((session.config || FALLBACK_CONFIG).fps) || 0;
    if (!fps || fps >= 60) {
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
    let last = 0;
    renderer._render = function throttledRender() {
      const now = performance.now();
      if (now - last < interval) {
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
    // 上限 400ms：再慢就变成明显延迟了，宁可后面按「满轨」丢弃。
    const gap = Math.min(400, perTrack / tracks);
    return Math.max(16, Math.round(gap / profile().sendScale));
  }

  function scheduleDrain() {
    if (session.queueTimer || session.destroyed) return;
    session.queueTimer = setTimeout(() => {
      session.queueTimer = 0;
      drain();
    }, sendGap());
  }

  function drain() {
    if (session.destroyed || !session.renderer) return;
    const gap = sendGap();
    const now = performance.now();
    if (now - session.lastSendAt < gap && session.queue.length) {
      scheduleDrain();
      return;
    }
    // 一次最多补发 MAX_PER_DRAIN 条：时间戳间隔检查在循环里只能发出 1~2 条，
    // 但 lastSendAt 很久没更新时（切标签页、窗口刚恢复）会一次塞进整批。
    let sentNow = 0;
    while (session.queue.length && sentNow < MAX_PER_DRAIN) {
      if (performance.now() - session.lastSendAt < gap) break;
      emit(session.queue.shift());
      session.lastSendAt = performance.now();
      sentNow += 1;
    }
    if (session.queue.length) scheduleDrain();
  }

  function emit(message) {
    const config = session.config || FALLBACK_CONFIG;
    const renderer = session.renderer;
    if (!renderer) return;
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
      id: `d${++session.sent}`,
      time: Math.max(0, clockSource.currentTime * 1000),
      // 不要写成 `message.text || ''`：数字 0 之类的假值会被吞掉。
      text: message.text == null ? '' : String(message.text),
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
    let created = null;
    try {
      renderer.send(option);
      const instances = calc?.scrollBarrageInstances;
      if (instances && instances.length > before) created = instances[instances.length - 1];
    } catch {
      /* 库对个别非法参数会抛错，忽略单条不影响其他弹幕 */
      return;
    }
    if (!created) return;
    // 用实测宽度修正发送速率（EMA），下一次 sendGap() 会更接近真实轨道容量。
    session.widthAvg = session.widthAvg
      ? session.widthAvg * 0.85 + created.width * 0.15
      : created.width;
    // 满轨：库只能把它丢到随机轨道上，结果一定是叠字。
    // 这条直接撤下不显示——刷屏时宁可少显示，也不叠成一坨（B 站同样会丢弃满轨的弹幕）。
    if (created.fallbackTrack) dropInstance(created);
  }

  /// 把刚创建但放不下的实例从库里摘干净。
  /// 它没有被塞进任何虚拟轨道，只要从两个实例数组里删掉就不会再参与渲染与布局。
  function dropInstance(instance) {
    const calc = session.renderer?.barrageLayoutCalculate;
    if (!calc) return;
    session.dropped += 1;
    for (const list of [calc.scrollBarrageInstances, calc.canShowScrollBarrageInstances]) {
      const index = list.indexOf(instance);
      if (index >= 0) list.splice(index, 1);
    }
  }

  // 尺寸变化（进出全屏、窗口缩放、聊天栏收起）后要让库重新计算画布与轨道。
  session.observer = new ResizeObserver(scheduleResize);
  session.observer.observe(host);

  measure();
  build();
  syncRenderConfig();

  video.addEventListener('play', () => session.renderer?.play());
  video.addEventListener('pause', () => session.renderer?.pause());

  // 调试句柄：在控制台里可以查 sent / queued / renderer 状态。
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
    get renderer() {
      return session.renderer;
    },
    get config() {
      return session.config;
    },
  };

  return {
    /** 应用新的弹幕设置（字号/速度/区域/行数/不透明度/描边/性能档位等） */
    update(config) {
      const previous = session.config;
      session.config = { ...FALLBACK_CONFIG, ...(config || {}) };
      if (!session.renderer) return;
      // 字号或性能档位变了只能重建：字号决定每条实例的宽高，
      // 性能档位可能改 DPR（画布尺寸），两者都无法在现有实例上热改。
      if (!previous || previous.font !== session.config.font || previous.perf !== session.config.perf) {
        rebuild();
        return;
      }
      // 行数/区域/速度只影响渲染配置，库内部重排轨道并保留现有弹幕实例。
      syncRenderConfig();
      // 帧率上限不受重建影响，改完立即生效。
      applyFrameLimit();
      ensureLayout();
    },
    /** 立刻显示一条弹幕；超出发送速率时先入队 */
    send(message) {
      if (session.destroyed || !session.renderer) return;
      if (session.queue.length > 300) session.queue.shift();
      session.queue.push(message);
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
    /** 重建渲染器：直播流重连、时间轴归零或实例过多时调用 */
    reset() {
      rebuild();
    },
    /** 已收下的弹幕数量，用于判断是否需要重建 */
    get sent() {
      return session.sent;
    },
    /** 实例上限随性能档位变化：越极速越早重建，避免库不回收导致内存增长 */
    get limit() {
      return profile().maxStored;
    },
    destroy() {
      session.destroyed = true;
      session.queue.length = 0;
      clearTimeout(session.queueTimer);
      if (session.resizeHandle) cancelAnimationFrame(session.resizeHandle);
      session.resizeHandle = 0;
      session.observer?.disconnect();
      dispose();
      host.remove();
    },
  };
}
