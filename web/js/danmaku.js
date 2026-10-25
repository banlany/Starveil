// 弹幕层：封装 fly-barrage（canvas 渲染 + 虚拟轨道避让），对外只暴露项目需要的接口。
//
// 设计要点：
// 1. fly-barrage 的进度来自 `video.currentTime`，直播流每次重连都会归零，
//    所以重连/换线后必须 `reset()` 重建渲染器，否则旧弹幕的时间轴和新时间轴对不上。
// 2. 库内部不回收已下屏的弹幕实例，长时间观看会持续增长；
//    超过阈值时同样走 `reset()`，代价只是清空当前屏上的弹幕。
// 3. 库没有“满轨排队”，这里保留一个轻量发送队列做限速，
//    避免瞬时爆发的一批弹幕被轨道算法整批丢弃。

const RENDERER_KEY = 'FlyBarrage';
const MAX_STORED = 1500;

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
 */
export function createDanmakuLayer(container, video) {
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
    config: null,
    queue: [],
    queueTimer: 0,
    sent: 0,
    lastSendAt: 0,
    destroyed: false,
    observer: null,
    width: 0,
    height: 0,
  };

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
    // fly-barrage 内部的热重排（resize / 改布局参数）会把“可渲染集合”清空导致黑屏，
    // 所以尺寸或布局参数变化时直接重建渲染器，而不是调用它的 resize()/setRenderConfig()。
    session.renderer = new Renderer({
      container: host,
      video: clockSource,
      renderConfig: buildRenderConfig(),
    });
    session.sent = 0;
    primeTracks();
    session.renderer.play();
  }

  /// 库的 send() 依赖虚拟轨道已经建好（要读 virtualTrack.top），
  /// 而轨道只在 setBarrages()/resize 时才会初始化；直播场景是逐条 send，
  /// 所以这里显式初始化一次，否则每条 send 都会抛 “reading 'top'”。
  function primeTracks() {
    const calculate = session.renderer?.barrageLayoutCalculate;
    const algorithm = calculate?.virtualTrackAlgorithm;
    if (!algorithm || algorithm.virtualTracks?.length) return;
    const config = session.config || {};
    try {
      algorithm.maxGrade = 1;
      algorithm.initTracks(lineHeightFor(Number(config.font) || 24));
    } catch {
      /* 初始化失败时弹幕不显示，但不影响播放 */
    }
  }

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
    return Math.max(18, Math.round(font * 1.4));
  }

  function buildRenderConfig() {
    const config = session.config || { font: 24, weight: 600, opacity: 95, area: 40, lines: 8, speed: 8, stroke: true, strokeWidth: 2 };
    const height = host.clientHeight || 1;
    const lineHeight = lineHeightFor(config.font);
    // lines 是“最多几行”：区域高度按行数上限收窄，剩下的交给库自己排轨道。
    const regionPx = Math.min(
      height * Math.max(10, Math.min(100, config.area)) / 100,
      Math.max(lineHeight, config.lines * lineHeight)
    );
    return {
      speed: Math.max(60, (session.width || container.clientWidth || 960) / Math.max(3, config.speed)),
      opacity: Math.max(0.2, Math.min(1, (config.opacity ?? 95) / 100)),
      renderRegion: Math.max(0.1, Math.min(1, regionPx / height)),
      fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      fontWeight: String(config.weight || 600),
      heightReduce: 0,
      avoidOverlap: true,
      minSpace: 26,
      strokeStyle: 'rgba(0, 0, 0, 0.85)',
      lineWidth: config.stroke ? Math.max(0, Number(config.strokeWidth) || 0) : 0,
      lineCap: 'round',
      lineJoin: 'round',
      miterLimit: 10,
      shadowColor: 'rgba(0, 0, 0, 0.45)',
      shadowBlur: config.stroke ? 2 : 0,
      shadowOffsetX: 0,
      shadowOffsetY: 1,
    };
  }

  function measure() {
    session.width = host.clientWidth;
    session.height = host.clientHeight;
  }

  function applyConfig() {
    session.renderer?.setRenderConfig(buildRenderConfig());
  }

  function scheduleDrain() {
    if (session.queueTimer || session.destroyed) return;
    const config = session.config || {};
    const lanes = Math.max(2, Math.min(20, Number(config.lines) || 8));
    const gap = Math.max(16, Math.round(900 / (lanes * 2)));
    session.queueTimer = setTimeout(() => {
      session.queueTimer = 0;
      drain();
    }, gap);
  }

  function drain() {
    if (session.destroyed || !session.renderer) return;
    const config = session.config || {};
    const lanes = Math.max(2, Math.min(20, Number(config.lines) || 8));
    const gap = Math.max(16, Math.round(900 / (lanes * 2)));
    const now = performance.now();
    if (now - session.lastSendAt < gap && session.queue.length) {
      scheduleDrain();
      return;
    }
    while (session.queue.length) {
      if (now - session.lastSendAt < gap) break;
      emit(session.queue.shift());
      session.lastSendAt = performance.now();
    }
    if (session.queue.length) scheduleDrain();
  }

  function emit(message) {
    const config = session.config || {};
    const renderer = session.renderer;
    if (!renderer) return;
    const fontSize = Math.max(12, Math.min(48, Number(config.font) || 24));
    const color = message.color == null ? '#ffffff' : `#${Number(message.color).toString(16).padStart(6, '0')}`;
    const position = Number(message.position) || 0;
    const barrageType = position === 1 ? 'top' : position === 2 ? 'bottom' : 'scroll';
    const option = {
      id: `d${++session.sent}`,
      time: Math.max(0, clockSource.currentTime * 1000),
      text: String(message.text || ''),
      fontSize,
      // 库里的 lineHeight 是行高倍数（内部按 fontSize * lineHeight 算高度），不是像素。
      lineHeight: 1.35,
      color,
      barrageType,
      addition: { user: message.user || '' },
    };
    if (barrageType !== 'scroll') option.duration = 4200;
    try {
      renderer.send(option);
    } catch {
      /* 库对个别非法参数会抛错，忽略单条不影响其他弹幕 */
    }
  }

  // 尺寸变化（进出全屏、窗口缩放、聊天栏收起）后要让库重新计算画布与轨道。
  session.observer = new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    if (width === session.width && height === session.height) return;
    rebuild();
  });
  session.observer.observe(host);

  build();
  measure();
  applyConfig();

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
    get renderer() {
      return session.renderer;
    },
    get config() {
      return session.config;
    },
  };

  return {
    /** 应用新的弹幕设置（字号/速度/区域/行数/不透明度/描边等） */
    update(config, options = {}) {
      const previous = session.config;
      session.config = config;
      if (!session.renderer) return;
      if (options.relayout === false) {
        // 只改了不透明度/描边这类不影响排版的参数。
        if (!(previous && previous.font === config.font && previous.lines === config.lines && previous.area === config.area)) {
          rebuild();
          return;
        }
        applyConfig();
        return;
      }
      const layoutChanged =
        !previous ||
        previous.font !== config.font ||
        previous.lines !== config.lines ||
        previous.area !== config.area ||
        previous.speed !== config.speed ||
        previous.safeTop !== config.safeTop ||
        previous.safeBottom !== config.safeBottom;
      if (layoutChanged) rebuild();
      else applyConfig();
    },
    /** 立刻显示一条弹幕；超出发送速率时先入队 */
    send(message) {
      if (session.destroyed || !session.renderer) return;
      if (session.queue.length > 300) session.queue.shift();
      session.queue.push(message);
      const config = session.config || {};
      const lanes = Math.max(2, Math.min(20, Number(config.lines) || 8));
      const gap = Math.max(16, Math.round(900 / (lanes * 2)));
      if (performance.now() - session.lastSendAt >= gap) drain();
      else scheduleDrain();
    },
    /** 开关弹幕（保留已排队的消息，重新打开后继续） */
    setEnabled(enabled) {
      session.renderer?.switch(Boolean(enabled));
      if (!enabled) {
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
    get limit() {
      return MAX_STORED;
    },
    destroy() {
      session.destroyed = true;
      session.queue.length = 0;
      clearTimeout(session.queueTimer);
      session.observer?.disconnect();
      dispose();
      host.remove();
    },
  };
}
