// 直播间：mpegts 播放、滚动弹幕、聊天面板、清晰度/线路、全屏。
import { api, canonicalImage, formatOnline, normalizePlatform, roomUrl } from '../api.js';
import { createDanmakuLayer, DANMAKU_PRESETS, FPS_OPTIONS, flyBarrageAvailable, PERF_OPTIONS } from '../danmaku.js';
import { signDouyinDanmaku } from '../douyin-sign.js';
import { expandDouyinEmoticons } from '../douyin-emoji.js';
import { createDualPlayback, seekInBuffer } from '../dual.js';
import { flvBufferOptions, hlsBufferOptions } from '../player-buffer.js';
import { icon, PLATFORM_META, platformIcon } from '../icons.js';
import { IS_MOBILE } from '../platform.js';
import { bindHorizontalSwipe } from '../swipe.js';
import {
  addWatchTime,
  DEFAULT_SETTINGS,
  isFollowing,
  loadFollow,
  loadLogin,
  recordHistory,
  saveSettings,
  state,
  toggleFollow,
  touchFollowVisit,
  updateFollow,
} from '../store.js';
import {
  avatarHtml,
  bindImageFallback,
  confirmDialog,
  escapeHtml,
  openMenu,
  openModal,
  promptDialog,
  toast,
} from '../ui.js';

const MAX_MESSAGES = 360;
const QUALITY_KEY = 'simple-live.quality.';
// 直播间标题 / 人气 / 看过 / 大航海的刷新周期。取 5 分钟：这几个数字变化不慢，
// 太勤只会白白多打几次平台接口。
const REFRESH_INFO_INTERVAL = 5 * 60 * 1000;

// 直播间右侧「设置」页签里的数值项都用预设值下拉，档位表来自弹幕层
// （DANMAKU_PRESETS），和设置页读的是同一份，不会出现两边档位对不上。
const CS_PRESETS = DANMAKU_PRESETS;

/// 画面尺寸：与设置页「播放 → 画面尺寸」是同一份配置（player.scaleMode）。
const SCALE_MODES = [
  ['contain', '适应'],
  ['cover', '铺满'],
  ['fill', '拉伸'],
];

/// 预设值下接的选项表。当前值不在预设里（老版本存下来的非档位值）时补一项，
/// 否则下拉会自己显示成某个档位，看着像「设置被改了」。
function presetChoices(values, current, format = (value) => String(value)) {
  const list = [...values];
  const value = Number(current);
  if (Number.isFinite(value) && !list.includes(value)) {
    list.push(value);
    list.sort((a, b) => a - b);
  }
  return list.map((item) => ({ value: item, label: format(item), selected: item === value }));
}

/// 固定档位（粗细、性能档、帧率、过滤模式）的选项表。
function fixedChoices(pairs, current) {
  return pairs.map(([value, label]) => ({ value, label, selected: String(value) === String(current) }));
}

export function renderRoom(ctx, params = {}) {
  const platform = params.platform || state.platform;
  const roomId = String(params.roomId || '');
  const page = document.createElement('section');
  page.className = 'room-page is-paused';
  page.innerHTML = `
    <div class="room-main">
      <div class="stage" id="stage">
        <div class="stage-bg" id="stage-bg"></div>
        <video id="player" playsinline preload="none"></video>
        <!-- 同屏播放的第二路。默认隐藏，开启后盖在 #player 上面：
             这时候 #player 只贡献声音（代理层已过滤掉视频），B 的画面在台前。
             放在弹幕层之前，弹幕仍然压在画面之上。 -->
        <video id="player-b" class="player-secondary" playsinline preload="none" muted></video>
        <!-- 只播放音频：这一路没有视频轨（代理层丢掉了视频 tag），
             画面位置留一个能点回来的标记，不然只是一块黑。 -->
        <div class="audio-only-badge" id="audio-only-badge" role="button" tabindex="0">
          ${icon('volume', 18)}<span>只播放音频</span><em>点此恢复画面</em>
        </div>
        <!-- A 的小窗关闭按钮：跟着小窗走，位置由 positionDualPip 同步。
             单独一个元素而不是塞进 video 里——video 不能有子元素。 -->
        <button class="pip-close" id="pip-close" type="button" title="关闭小窗" hidden>${icon('close', 13)}</button>
        <div class="danmaku-layer" id="danmaku-layer"></div>
        <div class="sc-float-layer" id="sc-float-layer"></div>
        <div class="stage-hint" id="stage-hint"><span class="big-spinner"></span><span>正在读取直播间…</span></div>
        <div class="room-topbar" id="room-topbar">
          <button class="back-btn" id="room-back" title="返回">${icon('back', 21)}</button>
          <div class="room-heading">
            <h1 id="room-title">正在读取房间…</h1>
            <div class="room-sub" id="room-sub"></div>
          </div>
          <div class="room-top-actions">
            <button class="overlay-btn follow-btn" id="room-follow">${icon('follow', 16)}<span class="label">关注</span></button>
            <button class="overlay-btn icon-only" id="room-share" title="分享">${icon('share', 18)}</button>
            <button class="overlay-btn icon-only" id="room-more" title="更多">${icon('more', 18)}</button>
          </div>
        </div>
        <div class="player-controls" id="player-controls">
          <!-- 三段式：音量钉在最左、全屏钉在最右，中间那截自己收。
               以前是一整排 flex，画质写着「1080p60」这类长档位时，
               右边一组会整体被顶出可视区，全屏按钮只剩半个。 -->
          <div class="pc-side pc-left">
            <div class="volume-wrap" id="volume-wrap">
              <button class="ctrl" id="ctrl-volume" title="静音">${icon('volume', 21)}</button>
              <!-- 音量条：桌面靠 hover 在按钮右侧展开，手机上改为按钮上方的浮层
                   （见 mobile.css 的 .volume-pop），不再把右边的控件挤走。 -->
              <div class="volume-pop">
                <input type="range" id="volume-range" min="0" max="100" value="80" aria-label="音量" />
              </div>
            </div>
          </div>
          <div class="pc-mid" id="pc-mid">
            <span class="clock" id="player-clock">--:--:--</span>
            <span class="ctrl-spacer"></span>
            <button class="ctrl-text" id="ctrl-quality"><span class="ctrl-label" id="ctrl-quality-label">原画</span> ${icon('chevronUp', 13)}</button>
            <button class="ctrl-text" id="ctrl-line"><span class="ctrl-label" id="ctrl-line-label">线路 1</span> ${icon('chevronUp', 13)}</button>
            <button class="ctrl" id="ctrl-danmaku" title="弹幕开关">${icon('danmaku', 21)}</button>
            <button class="ctrl" id="ctrl-settings" title="弹幕与播放设置">${icon('settings', 20)}</button>
            <button class="ctrl" id="ctrl-pip" title="画中画">${icon('screen', 20)}</button>
          </div>
          <div class="pc-side pc-right">
            <button class="ctrl" id="ctrl-fullscreen" title="全屏（F / 双击画面）">${icon('fullscreen', 21)}</button>
          </div>
          <div class="live-progress"></div>
        </div>
      </div>
      <aside class="room-chat" id="room-chat">
        <div class="chat-resizer" id="chat-resizer" title="拖动调整聊天区宽度"></div>
        <div class="chat-head">
          <span id="chat-avatar"></span>
          <div class="chat-head-text">
            <h3 id="chat-name">聊天</h3>
            <div class="chat-head-meta" id="chat-meta"></div>
          </div>
          <div class="chat-head-actions">
            <button class="icon-btn" id="chat-follow" title="关注">${icon('follow', 17)}</button>
            <button class="icon-btn" id="chat-collapse" title="收起聊天区">${icon('chevron', 17)}</button>
          </div>
        </div>
        <div class="chat-tabs" id="chat-tabs">
          <button class="chat-tab active" data-tab="chat">聊天</button>
          <button class="chat-tab" data-tab="sc">SC<em id="sc-count">0</em></button>
          <button class="chat-tab" data-tab="follow">关注</button>
          <button class="chat-tab" data-tab="settings">设置</button>
          <span class="tab-underline chat-tab-underline" aria-hidden="true"></span>
        </div>
        <div class="chat-status" id="chat-status" hidden></div>
        <div class="chat-list" id="chat-list"></div>
        <form class="chat-composer hidden" id="chat-composer" autocomplete="off">
          <input class="chat-input" id="chat-input" type="text" maxlength="100" placeholder="发个弹幕…" />
          <button class="chat-send" type="submit" title="发送">${icon('send', 17)}</button>
        </form>
        <button class="chat-to-bottom" id="chat-to-bottom" title="回到底部">${icon('chevronDown', 15)}<span>回到底部</span></button>
      </aside>
    </div>
    <footer class="room-footer">
      <button class="footer-action" id="footer-refresh">${icon('refresh', 17)}<span>刷新</span></button>
      <button class="footer-action" id="footer-follow">${icon('follow', 17)}<span>关注</span></button>
      <button class="footer-action" id="footer-tag">${icon('tag', 17)}<span>标签</span></button>
      <div class="footer-right">
        <button class="footer-action" id="footer-share">${icon('share', 17)}<span>分享</span></button>
      </div>
    </footer>
    <button class="chat-expand hidden" id="chat-expand" title="展开聊天区">${icon('back', 18)}</button>`;

  const $ = (id) => page.querySelector(`#${id}`);
  const stage = $('stage');
  const video = $('player');
  const videoB = $('player-b');
  const audioOnlyBadge = $('audio-only-badge');
  const layer = $('danmaku-layer');
  const hint = $('stage-hint');
  const clock = $('player-clock');
  const volumeRange = $('volume-range');
  const volumeWrap = $('volume-wrap');
  const playerControls = $('player-controls');
  // 控制条中间那一段（时间/画质/线路/弹幕/设置/小窗）。宽度不够时收的是这里的内容，
  // 两端的音量与全屏永远不动。
  const pcMid = $('pc-mid');
  const roomTopbar = $('room-topbar');
  const chatList = $('chat-list');
  const chat = $('room-chat');
  const chatToBottom = $('chat-to-bottom');
  const composer = $('chat-composer');
  const chatInput = $('chat-input');

  const session = {
    platform,
    roomId,
    key: '',
    detail: null,
    qualities: [],
    qualityIndex: 0,
    headers: [],
    lineIndex: 0,
    player: null,
    // 弹幕发送是否正在进行（防连点）。
    sendingDanmaku: false,
    // 弹幕连接状态：{ state, reason }。聊天栏顶部的状态条就靠它，
    // 未连接、连不上或被平台限制时把原因直接摆在用户眼前。
    danmakuStatus: null,
    // 当前播放器对应的协议：'flv'（mpegts.js）或 'hls'（hls.js / 原生 HLS）。
    playerProtocol: '',
    // 线路列表：[{ url, protocol }]，FLV 在前、HLS 作为兜底在后。
    lines: [],
    messages: [],
    tab: 'chat',
    chatCollapsed: false,
    loading: true,
    failed: false,
    idleTimer: 0,
    clockTimer: 0,
    statsTimer: 0,
    infoTimer: 0,
    refreshTimer: 0,
    scMessages: [],
    scHistory: [],
    // SC 面板的二级视图：当前正在显示 / 历史归档。
    // 历史条目可能上百条，和当前 SC 同屏会互相挤占，所以一次只渲染一个列表。
    scView: 'active',
    scTimers: new Map(),
    scSweep: 0,
    followRefreshing: false,
    dedupe: new Map(),
    recentBlocked: 0,
    wakeBound: false,
    destroyed: false,
    // 小窗（PiP）期间的退出探测定时器，见 setPipMode。
    pipWatch: 0,
    // 同屏小窗的尺寸监听：舞台大小变了要重算小窗位置。
    pipObserver: null,
    danmakuEnabled: state.settings.danmaku.enabled !== false,
    follow: false,
    playerReady: false,
    lastUiWake: 0,
    lastVolume: 0.8,
    lineFailures: 0,
    // 直播流「一直没有进展」时连续自动重试的次数。主播下播后画面会永久停住，
    // 不设上限的话卡顿检测会每隔几秒重取一次流、弹一次 toast，永远停不下来。
    stallRetries: 0,
    // 自动重连已经放弃（下播/流彻底没了）。用户手动刷新时清掉。
    streamDead: false,
    // 断流重连：error 与 ended 共用这套计数。斗鱼的 FLV 直链一个多小时就过期，
    // CDN 也会主动掐长连接，出画后清零，连续失败 3 次才把错误页交给用户。
    errorRetries: 0,
    reconnecting: false,
    // 斗鱼地址续签定时器（见 startStreamRenew）。
    renewTimer: 0,
    playStartedAt: 0,
    stallTimer: 0,
    lastProgressTime: 0,
    lastProgressAt: 0,
    // 观看时长统计：watchSince 是「这一段从什么时候开始连续播放」，
    // watchPending 是已经结算但还没落盘的部分，靠心跳定时刷进 localStorage，
    // 这样关窗/崩溃最多丢一个心跳周期的时长。
    watchSince: 0,
    watchPending: 0,
    watchTimer: 0,
    // 同屏播放：A 这一路是否只取声音（视频 tag 在代理层就被丢掉）。
    // 只由用户那个「只播放音频」开关决定；同屏开着但小窗关掉时，为了切回来不用
    // 重新取流，A 仍然保留视频（用户明确要的取舍：多占一路带宽换切换速度）。
    audioOnly: false,
    // 齿轮里的「只播放音频」：用户自己按下的那个开关，只对本次进房有效。
    audioOnlyUser: false,
    // 延迟播放：比直播慢几秒（秒，0 表示关闭），只作用于 A。
    // 靠「先攒够 N 秒缓冲再开播」实现，见 holdForDelay。
    delaySec: 0,
    delayTimer: 0,
    delayHolding: false,
    // 当前弹幕连的是哪一路：'a'（本直播间）还是 'b'（同屏的另一个）。
    danmakuSource: 'a',
    // 已经施加在 A / B 上的延迟（秒）。时间偏移是相对调整，靠它算差值。
    dualDelayA: 0,
    dualDelayB: 0,
    // 面板里填的 B 地址（面板重画时输入框不会丢内容）与当前设定的偏移值。
    dualInput: '',
    dualOffset: 0,
    // 同屏布局：flip 为 true 表示 A 主画面、B 缩成小窗（点小窗切换）。
    dualFlip: false,
    // A 的小窗：on 是开关，x/y 是左上角相对舞台的百分比（null 走默认右下角）。
    // 拖过之后记住位置，关掉再开还在原处。
    dualPip: { on: true, x: null, y: null },
    // 面板上 B 的独立音量（0~1）。默认给一半：两路都满音量混在一起太吵，
    // 但也不静音——静音会让人以为 B 没声音。
    dualVolumeB: 0.5,
  };
  state.room = session;

  // B 路播放器。它自己取流、自己播，和 A 的状态机互不干扰；
  // 面板上的开关只是把参数丢给它。
  const dual = createDualPlayback(videoB, renderDualState);
  session.dual = dual;

  // 竖屏（手机上竖着拿）控制条放不下全部控件，但不是一刀切全藏起来：
  // 按「线路 → 画质 → 时间」的优先级逐级收起，后面的越常用、越晚收。
  // 收起来的项在「更多」菜单里始终有入口（showMoreMenu 无条件显示）。
  //
  // 量的是中间那一段（.pc-mid）：两端的音量与全屏是钉死的，中间塞不下只影响中间，
  // 绝不会像以前那样把全屏顶到屏幕外。画质/线路的文字放在 .ctrl-label 里，
  // 真的没地方时先允许它缩写（省略号），再由下面的循环整项收起。
  const portraitQuery = window.matchMedia('(orientation: portrait)');
  const CONTROL_FADE = [
    ['ctrl-hide-line', 'ctrl-line'],
    ['ctrl-hide-quality', 'ctrl-quality'],
    ['ctrl-hide-clock', 'player-clock'],
  ];

  function applyControlDensity() {
    for (const [cls] of CONTROL_FADE) page.classList.remove(cls);
    if (!IS_MOBILE || !pcMid.clientWidth) return;
    // spacer 会先吃掉多余空间，真的塞不下时 scrollWidth 才会超出 clientWidth，
    // 每收一项就重新量一次，刚好放得下就停手。
    for (const [cls] of CONTROL_FADE) {
      if (pcMid.scrollWidth <= pcMid.clientWidth + 1) break;
      page.classList.add(cls);
    }
  }

  // ------------------------------------------------------------ 基础 UI

  // 从直播间进入另一个直播间时，返回应该回到一级界面，而不是回到上一个直播间。
  // 全屏（桌面 Fullscreen API / 安卓剧场模式）时先退全屏：这个位置在用户眼里
  // 就是「退一层」，直接退出直播间太粗暴，也容易误触。
  $('room-back').addEventListener('click', () => {
    if (isPlayerFullscreen()) {
      exitPlayerFullscreen();
      return;
    }
    ctx.exitRoom();
  });
  // 音量：桌面是「点=静音、悬停展开滑条」；手机没有 hover，点一下在按钮**上方**
  // 弹出竖直滑条（再点收起），拖动时不再像以前那样把右边的控件挤出去。
  $('ctrl-volume').addEventListener('click', () => {
    if (IS_MOBILE) {
      setVolumePop(!volumeWrap.classList.contains('is-open'));
      return;
    }
    toggleMute();
  });
  // 点别处收起音量浮层。用捕获阶段，免得被控制条/画面上的别的处理截走。
  document.addEventListener('pointerdown', onVolumeOutside, true);
  volumeRange.addEventListener('input', () => {
    video.volume = Number(volumeRange.value) / 100;
    video.muted = video.volume === 0;
    session.lastVolume = video.volume || 0.8;
    updateVolumeIcon();
    wake();
  });
  // 注意：这两个函数带默认参数（anchor = 控制条按钮），直接当监听器用会把 Event
  // 当成 anchor 传进去，`anchor.getBoundingClientRect` 抛 TypeError，表现就是「点了没反应」。
  $('ctrl-quality').addEventListener('click', () => showQualityMenu());
  $('ctrl-line').addEventListener('click', () => showLineMenu());
  $('ctrl-danmaku').addEventListener('click', () => setDanmakuEnabled(!session.danmakuEnabled));
  $('ctrl-settings').addEventListener('click', openQuickSettings);
  // 小窗：拖动改位置、点一下换主次、右上角的 × 收起。
  $('pip-close').addEventListener('click', () => setDualPip(false));
  bindPipDrag(video);
  bindPipDrag(videoB);
  // 舞台尺寸会变（拖聊天栏、进全屏、缩放窗口），小窗按百分比重算位置。
  if (typeof ResizeObserver === 'function') {
    const pipObserver = new ResizeObserver(() => {
      if (dual.state.open && session.dualPip.on) positionDualPip();
    });
    pipObserver.observe(stage);
    session.pipObserver = pipObserver;
  }
  // 「只播放音频」时画面是黑的，标记本身就是退出这个模式的入口。
  // 必须 stopPropagation：画面上的点击会唤出控制条/暂停，别让标记顺带触发一次。
  audioOnlyBadge.addEventListener('click', (event) => {
    event.stopPropagation();
    setAudioOnlyByUser(false);
  });
  $('ctrl-fullscreen').addEventListener('click', toggleFullscreen);
  $('ctrl-pip').addEventListener('click', togglePip);
  $('room-follow').addEventListener('click', onFollowClick);
  $('footer-follow').addEventListener('click', onFollowClick);
  $('chat-follow').addEventListener('click', onFollowClick);
  $('footer-tag').addEventListener('click', onTagClick);
  $('room-share').addEventListener('click', shareRoom);
  $('footer-share').addEventListener('click', shareRoom);
  $('footer-refresh').addEventListener('click', () => manualRefreshStream());
  $('room-more').addEventListener('click', showMoreMenu);
  $('chat-collapse').addEventListener('click', () => setChatCollapsed(true));
  $('chat-expand').addEventListener('click', () => setChatCollapsed(false));
  $('chat-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.chat-tab')?.dataset.tab;
    if (!tab) return;
    setChatTab(tab);
  });
  chatList.addEventListener('scroll', updateChatToBottom, { passive: true });
  // 聊天栏左右滑动切标签：聊天 → SC → 关注 → 设置。只在移动端，
  // 桌面端鼠标拖拽容易误触，而且标签本来就好点。
  if (IS_MOBILE) {
    const swipeTabs = ['chat', 'sc', 'follow', 'settings'];
    bindHorizontalSwipe(chat, (direction) => {
      const index = swipeTabs.indexOf(session.tab);
      if (index < 0) return;
      const next = swipeTabs[index + (direction === 'left' ? 1 : -1)];
      if (!next) return;
      setChatTab(next);
      chatList.classList.remove('swipe-in');
      void chatList.offsetWidth;
      chatList.classList.add('swipe-in');
    });
  }
  chatToBottom.addEventListener('click', () => scrollChatToBottom(true));
  composer.addEventListener('submit', submitDanmaku);
  updateComposer();
  const stageEvents = ['mousemove', 'mousedown', 'touchstart', 'wheel'];
  const wake = () => {
    page.classList.remove('ui-idle');
    clearTimeout(session.idleTimer);
    if (session.destroyed) return;
    session.idleTimer = setTimeout(() => {
      // 全屏（桌面 Fullscreen API / 安卓剧场模式）时聊天栏已隐藏，即使视频正在缓冲
      // 也要让顶部浮层和底部控制条自动收起，不然暂停在广告画面上就是两块常驻黑条。
      const canHide =
        !volumeWrap.classList.contains('is-open') &&
        (document.fullscreenElement ||
          page.classList.contains('is-theater') ||
          (!video.paused && !session.chatCollapsed));
      if (canHide && !document.querySelector('.menu-overlay:not(.closing)')) {
        page.classList.add('ui-idle');
      }
    }, 2800);
  };
  for (const name of stageEvents) page.addEventListener(name, wake, { passive: true });

  // ------------------------------------------------------------ 弹幕渲染

  // 弹幕交给 fly-barrage（canvas + 虚拟轨道避让），这里只负责开关、屏蔽和转交。
  // 注意：渲染器要等页面插进 DOM、容器量到真实宽高后再建，否则 canvas 会是 0×0。
  let danmaku = null;

  function initDanmaku() {
    if (danmaku || !flyBarrageAvailable()) return;
    // 初始设置直接交给渲染器，避免建好再重建一次。
    danmaku = createDanmakuLayer(layer, video, state.settings.danmaku);
    danmaku.setEnabled(session.danmakuEnabled);
  }

  function applyDanmakuStyle() {
    const config = state.settings.danmaku;
    // 顶部/底部安全边距交给容器留白，库只负责在剩余区域内排轨道。
    // 弹幕「顶部安全边距」是相对播放器画面顶端的真实边距，0 就是贴着画面顶端——
    // 房间标题浮层会自动隐藏，不需要为它预留空间（早期这里强制钳到 64px，
    // 导致设置里 0~60 的滑块怎么调都不生效）。
    layer.style.top = `${Math.max(0, Number(config.safeTop) || 0)}px`;
    layer.style.bottom = `${Math.max(0, Number(config.safeBottom) || 0)}px`;
    applyBigEmojiSize(config.bigEmojiLines);
    danmaku?.update(config);
  }

  /// 聊天栏大表情的高度用 CSS 变量推下去（而不是写到每个 `<img>` 的内联样式里）：
  /// 改档位时屏上已有的那些表情会立刻跟着变，不用等聊天栏重渲染。
  /// 1 行 = `.chat-line` 的 line-height（1.55），和弹幕层「1 行 = 一个轨道高」是同一个口径。
  function applyBigEmojiSize(lines) {
    const value = Math.max(1, Number(lines) || 2);
    document.documentElement.style.setProperty('--big-emoji-lines', String(value));
  }

  /// 弹幕开关只有这一条逻辑：底部控件、右侧设置面板、全屏设置弹窗都走这里。
  function setDanmakuEnabled(enabled) {
    session.danmakuEnabled = Boolean(enabled);
    state.settings.danmaku.enabled = session.danmakuEnabled;
    saveSettings();
    $('ctrl-danmaku').classList.toggle('active', session.danmakuEnabled);
    // 开回来时必须显式 setEnabled(true)：库的 switch(false) 会停掉渲染循环，
    // 只改配置不调它，弹幕就再也回不来了（设置面板开关「关得掉、开不回来」就是这个原因）。
    danmaku?.setEnabled(session.danmakuEnabled);
    syncEnabledSwitches();
    if (session.tab === 'chat' || session.tab === 'sc') renderChatTab();
  }

  /// 设置面板里的开关是另一份 DOM（侧栏一份、全屏弹窗又能再开一份），
  /// 状态要跟着底部控件的真实开关走，两边不能各说各话。
  function syncEnabledSwitches() {
    for (const button of document.querySelectorAll('.chat-settings #cs-enabled')) {
      button.setAttribute('aria-checked', String(session.danmakuEnabled));
    }
  }

  function blocked(message) {
    const config = state.settings.danmaku;
    if (!config.block) return false;
    const keywords = String(config.blockKeywords || '').split('\n').map((item) => item.trim()).filter(Boolean);
    const users = String(config.blockUsers || '').split('\n').map((item) => item.trim()).filter(Boolean);
    if (keywords.some((keyword) => message.text.includes(keyword))) return true;
    if (users.some((user) => message.user.includes(user))) return true;
    return false;
  }

  function deduped(message) {
    const config = state.settings.danmaku;
    if (!config.dedupe) return false;
    const now = Date.now();
    const key = config.dedupeMode === 'user' ? `${message.user}|${message.text}` : message.text;
    const last = session.dedupe.get(key) || 0;
    const windowMs = Math.max(1, config.dedupeWindow) * 1000;
    session.dedupe.set(key, now);
    if (session.dedupe.size > 600) {
      for (const [item, time] of session.dedupe) {
        if (now - time > 15000) session.dedupe.delete(item);
      }
    }
    return now - last < windowMs;
  }

  function spawnDanmaku(message) {
    if (!session.danmakuEnabled || message.system || message.sc) return false;
    if (blocked(message) || deduped(message)) return false;
    if (!danmaku) return false;
    // 库不回收已下屏的实例（数组只增不减，每帧渲染都要遍历一遍），长时间观看必须清理。
    // 这里用 prune() 就地摘掉已经滚出去的，屏上正在滚的保持原位——
    // 以前用 reset() 重建渲染器，代价是整层弹幕瞬间被清空，看起来像「弹幕重新刷了一次」。
    if (danmaku.sent > danmaku.limit) danmaku.prune();
    danmaku.send(message);
    return true;
  }

  function scTierColors(sc) {
    const fallback = [
      [1000, '#f7e6b8', '#b8860b'],
      [500, '#ffdede', '#c94f4f'],
      [100, '#ffe6c7', '#d9762a'],
      [50, '#d8f4fb', '#3f9fbe'],
      [30, '#e2ebff', '#4c78d8'],
    ];
    const tier = fallback.find(([price]) => Number(sc.price) >= price) || [0, '#ffe3ed', '#d85a84'];
    return {
      top: sc.background_color || tier[1],
      bottom: sc.background_bottom_color || tier[2],
    };
  }

  /// 聊天区里的 SC 行：底色直接取 SC 面板那张卡片的档位色（同一套 palette），
  /// 平铺一个颜色、不铺渐变。
  ///
  /// 这里只把两个档位色写成 CSS 变量，深浅主题各用哪一档、配什么字色交给 room.css：
  /// 深色主题用深一档的底色 + 白字，浅色主题用浅一档 + 深字。
  /// 走 CSS 的另一个好处是切换主题时，屏上已经画好的 SC 行会立刻跟着变，
  /// 不像 inline style 那样必须重新渲染聊天栏。
  function paintScChatLine(line, sc) {
    const { top, bottom } = scTierColors(sc);
    line.style.setProperty('--sc-bg', top);
    line.style.setProperty('--sc-bg-strong', bottom);
  }

  function clearScTimer(entry) {
    const timer = session.scTimers.get(entry);
    if (timer) clearTimeout(timer);
    session.scTimers.delete(entry);
  }

  /// 从“正在显示”的 SC 里移除，并归档到历史 SC（带结束时间与原因）。
  function removeScMessage(entry, reason = 'expired') {
    if (!session.scMessages.includes(entry)) return;
    clearScTimer(entry);
    session.scMessages = session.scMessages.filter((item) => item !== entry);
    session.scHistory.unshift({ ...entry, endedAt: Date.now(), reason });
    if (session.scHistory.length > 200) session.scHistory.pop();
    const counter = $('sc-count');
    if (counter) counter.textContent = String(session.scMessages.length);
    renderScOverlay();
    if (session.tab === 'sc') {
      renderChatTab();
      syncChatTabUnderline();
    }
  }

  function scheduleScRemoval(entry) {
    clearScTimer(entry);
    if (!state.settings.player.superChatAutoRemove) return;
    const end = Number(entry.sc.end_time) || 0;
    const delay = end > 0 ? Math.max(4000, end * 1000 - Date.now()) : 60_000;
    session.scTimers.set(
      entry,
      setTimeout(() => removeScMessage(entry), Math.min(delay, 24 * 60 * 60 * 1000))
    );
  }

  function purgeExpiredSc() {
    if (!state.settings.player.superChatAutoRemove) return;
    const now = Date.now();
    for (const entry of [...session.scMessages]) {
      const end = Number(entry.sc.end_time) || 0;
      if (end > 0 && end * 1000 <= now) removeScMessage(entry);
    }
  }

  function renderScOverlay() {
    const layer = $('sc-float-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const enabled = Boolean(state.settings.player.superChatOverlay);
    layer.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const active = session.scMessages.slice(-3);
    for (const entry of active) {
      const { top, bottom } = scTierColors(entry.sc);
      const card = document.createElement('div');
      card.className = 'sc-float-card';
      card.dataset.end = String(entry.sc.end_time ?? '');
      card.style.backgroundColor = top;
      card.innerHTML = `
        <div class="sc-float-head">
          ${avatarHtml(entry.user, entry.sc.avatar, 28)}
          <b>${escapeHtml(entry.user || 'B 站用户')}</b>
          <span>¥${Number(entry.sc.price) || 0}</span>
          <button class="sc-delete" title="关闭">${icon('close', 12)}</button>
        </div>
        <div class="sc-float-text">${escapeHtml(entry.text)}</div>`;
      card.querySelector('.sc-float-text').style.backgroundColor = bottom;
      card.querySelector('.sc-delete').addEventListener('click', (event) => {
        event.stopPropagation();
        removeScMessage(entry, 'manual');
      });
      layer.appendChild(card);
    }
    bindImageFallback(layer);
  }

  function pushMessage(message) {
    const text = message.text == null ? '' : String(message.text);
    const entry = {
      user: message.user || '',
      // 不要写成 `message.text || ''`：数字 0 之类的假值会被吞掉。
      text,
      color: message.color,
      system: Boolean(message.system),
      position: Number(message.position) || 0,
      sc: message.sc || null,
      // 表情弹幕的图片信息要一路带到弹幕层与聊天栏，漏掉这里表情就只剩占位文字。
      // 抖音的普通小表情只有文字、没有图（`rtfContent` 只覆盖互动表情），
      // 这里按本地表情表补齐；只在抖音补，别的平台有自己的 `[xxx]` 表，别串台。
      emoticons:
        session.platform === 'douyin'
          ? expandDouyinEmoticons(text, message.emoticons) || undefined
          : Array.isArray(message.emoticons) && message.emoticons.length
            ? message.emoticons
            : undefined,
      at: Date.now(),
    };
    session.messages.push(entry);
    if (session.messages.length > MAX_MESSAGES) session.messages.shift();
    if (entry.sc) {
      session.scMessages.push(entry);
      if (session.scMessages.length > 100) session.scMessages.shift();
      const counter = $('sc-count');
      if (counter) counter.textContent = String(session.scMessages.length);
      scheduleScRemoval(entry);
      renderScOverlay();
      if (session.tab === 'sc') {
        renderChatTab();
        // 计数位数变了（9 → 10）标签会变宽，色条得跟着重新对齐。
        syncChatTabUnderline();
      }
    }
    if (!entry.system && !entry.sc) spawnDanmaku(entry);
    if (session.tab === 'chat') queueChatLine(entry);
  }

  // 正则里的特殊字符要转义：表情 key 自带 `[` `]`，不转义会被当成字符组。
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function chatEmojiImage(key, url, big = false) {
    const image = document.createElement('img');
    // 大表情（收藏集那类只能单独发送的）按设置里的「几行」画，和弹幕层同一个行数；
    // 具体高度由 CSS 变量 --big-emoji-lines 决定（见 applyBigEmojiSize），
    // 所以改档位时屏上已有的表情也会立刻跟着变。
    // 小表情（`[热]`）仍跟行高走，否则一行字会被顶开。
    image.className = big ? 'chat-emoji is-big' : 'chat-emoji';
    image.src = url;
    image.alt = key;
    image.loading = 'lazy';
    // 图片挂了就退回文字，不要把整条弹幕变空白。
    image.addEventListener('error', () => image.replaceWith(document.createTextNode(key)));
    return image;
  }

  /// 聊天行正文：把表情占位符换成小图标。
  ///
  /// 用的是和弹幕层同一份 `message.emoticons`，区别只是这里按聊天区字号缩放（CSS 的 `em`）。
  /// 关掉「显示弹幕表情」时原样显示文字：`[大哭]`、`[热]`、`[下次一定]` 这些占位符照旧看得见，
  /// 大表情的正文本来就是词，也不动。
  function fillChatText(node, message) {
    const text = message.text == null ? '' : String(message.text);
    const list = Array.isArray(message.emoticons) ? message.emoticons : null;
    // 同一个 key 可能对应不同的图（每个房间都有自己那套 `[热]`），按出现顺序取第一个。
    const entryByKey = new Map();
    for (const emoticon of list || []) {
      const key = typeof emoticon?.key === 'string' ? emoticon.key : '';
      const url = typeof emoticon?.url === 'string' ? emoticon.url : '';
      if (key && url && !entryByKey.has(key)) entryByKey.set(key, { url, big: Boolean(emoticon.big) });
    }
    if (!entryByKey.size) {
      node.textContent = text;
      return;
    }
    if (state.settings.danmaku.emoji === false) {
      node.textContent = text;
      return;
    }
    // 整条扫一遍再切片，而不是按 emoticons 逐个 replace 一次：
    // 同一条弹幕里同一个表情常出现多次（`[大哭][大哭]`），只换第一处会让后面几个留成文字。
    // 长 key 排在前面，避免 `[热]` 抢走 `[热乎]` 的前半截。
    const keys = [...entryByKey.keys()].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      if (at > cursor) node.appendChild(document.createTextNode(text.slice(cursor, at)));
      const entry = entryByKey.get(match[0]);
      node.appendChild(chatEmojiImage(match[0], entry.url, entry.big));
      cursor = at + match[0].length;
    }
    if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  }

  /// 造一条聊天行，只建 DOM 不插入聊天列表。
  function buildChatLine(message) {
    const line = document.createElement('div');
    line.className = `chat-line${message.system ? ' system' : ''}${message.sc ? ' sc' : ''}`;
    if (!message.system) {
      if (message.sc) {
        const tag = document.createElement('span');
        tag.className = 'sc-tag';
        tag.textContent = `SC ¥${message.sc.price}`;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `${message.user}：`;
        const text = document.createElement('span');
        text.className = 'text';
        fillChatText(text, message);
        line.append(tag, who, text);
        paintScChatLine(line, message.sc);
      } else {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `${message.user}：`;
        const text = document.createElement('span');
        text.className = 'text';
        fillChatText(text, message);
        if (message.color && message.color !== 0xffffff) {
          text.style.color = `#${Number(message.color).toString(16).padStart(6, '0')}`;
        } else {
          // 白色弹幕在浅色聊天区按正文色显示，避免白字看不清；
          // 带颜色的弹幕仍保留平台下发的颜色。
          text.classList.add('text-plain');
        }
        line.append(who, text);
      }
    } else {
      line.textContent = message.text;
    }
    return line;
  }

  /// 聊天行只留最近这些条：再往前滚不到，留着纯属拖慢布局。
  const MAX_CHAT_LINES = 320;

  /// 每帧最多上屏多少行（见 flushChatLines）。
  const CHAT_LINES_PER_FRAME = 24;

  /// 待上屏的聊天行。
  ///
  /// 一条一条 append 是刷屏时最贵的一段：每条都要读一次 scrollHeight 再改 scrollTop，
  /// 每一读都是强制同步布局；热门直播间一秒钟几十条，安卓 WebView 上就是肉眼可见的卡顿。
  /// 这里攒到下一帧一起插进去，插入和滚动每帧只做一次。
  const pendingChatLines = [];
  let chatFlushHandle = 0;

  function queueChatLine(message) {
    pendingChatLines.push(message);
    if (chatFlushHandle) return;
    chatFlushHandle = requestAnimationFrame(flushChatLines);
  }

  function flushChatLines() {
    chatFlushHandle = 0;
    if (!pendingChatLines.length) return;
    // 切到别的标签页时聊天列表会被清空，这批消息已经在 session.messages 里，
    // 切回来 renderChatTab() 会整表重画，这里直接丢掉就不会重复上屏。
    if (session.tab !== 'chat') {
      pendingChatLines.length = 0;
      return;
    }
    // 一帧最多上屏这么多行：热门房间 100ms 一批能来几十条，一次性建完 DOM
    // 会在安卓上顶出一个几十毫秒的长任务，视频和弹幕跟着掉帧。
    // 拆到几帧里插完，肉眼看不出来，主线程不堵。
    const batch = pendingChatLines.splice(0, CHAT_LINES_PER_FRAME);
    chatList.querySelector('.chat-placeholder')?.remove();
    // 贴不贴底必须在插入之前量。
    const pinned = chatGapToBottom() < CHAT_PIN_GAP;
    const fragment = document.createDocumentFragment();
    for (const message of batch) fragment.appendChild(buildChatLine(message));
    chatList.appendChild(fragment);
    while (chatList.childElementCount > MAX_CHAT_LINES) chatList.firstElementChild?.remove();
    if (pinned) chatList.scrollTop = chatList.scrollHeight;
    updateChatToBottom();
    if (pendingChatLines.length) chatFlushHandle = requestAnimationFrame(flushChatLines);
  }

  function cancelChatFlush() {
    if (chatFlushHandle) cancelAnimationFrame(chatFlushHandle);
    chatFlushHandle = 0;
    pendingChatLines.length = 0;
  }

  /// 整表重画时用：消息都从 session.messages 来，一条一条同步插入即可。
  function appendChatLine(message) {
    chatList.querySelector('.chat-placeholder')?.remove();
    chatList.appendChild(buildChatLine(message));
    while (chatList.childElementCount > MAX_CHAT_LINES) chatList.firstElementChild?.remove();
  }

  function placeholder(text, iconName = 'danmaku') {
    const box = document.createElement('div');
    box.className = 'chat-placeholder';
    box.innerHTML = `${icon(iconName, 26)}<div>${escapeHtml(text)}</div>`;
    return box;
  }

  /// 聊天栏为空时的占位文案，必须跟着弹幕连接状态走。
  /// 以前只在渲染那一刻读一次状态：连上之后如果一直没人发弹幕，
  /// 占位就一直停在「正在连接弹幕服务器…」，看起来像卡在连接中。
  function chatPlaceholderText() {
    const state_ = session.danmakuStatus?.state;
    if (state_ === 'unsupported') return '本平台暂不支持弹幕';
    if (state_ === 'failed') return '弹幕未连接，原因见上方提示';
    if (state_ === 'connected') return '已连接弹幕服务器，还没有人发弹幕';
    return '正在连接弹幕服务器…';
  }

  /// 状态变化时就地改占位文案（不整页重绘，免得把滚动位置和输入框弄乱）。
  function refreshChatPlaceholder() {
    if (session.tab !== 'chat' || session.messages.length) return;
    const label = chatList.querySelector('.chat-placeholder > div');
    if (!label) return;
    const text = chatPlaceholderText();
    if (label.textContent !== text) label.textContent = text;
  }

  async function refreshRoomFollowStatus() {
    if (session.followRefreshing) return;
    const list = loadFollow();
    if (!list.length) return;
    session.followRefreshing = true;
    const button = chatList.querySelector('#chat-follow-refresh');
    button?.classList.add('is-loading');
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const item = list[cursor++];
        try {
          const payload = await api.openRoom(item.platform, item.room_id);
          updateFollow(item.platform, item.room_id, {
            live: Boolean(payload.detail.live),
            title: payload.detail.title || item.title,
            user_name: payload.detail.user_name || item.user_name,
            avatar: payload.detail.avatar || item.avatar || '',
            cover: payload.detail.cover || item.cover || '',
            online: Number(payload.detail.online) || 0,
          });
        } catch {
          /* 忽略单个失败 */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    session.followRefreshing = false;
    if (session.tab === 'follow') renderChatTab();
    toast('关注直播状态已刷新', 'success');
  }

  function renderChatTab() {
    // 记下滚动位置：SC 面板在「历史」视图时收到新 SC 也会整体重渲染，
    // 不还原的话列表会每次跳回顶部。
    const keepScroll = chatList.scrollTop;
    // 从这里开始整表重画，攒着的聊天行也一起作废（消息本身都在 session.messages 里）。
    cancelChatFlush();
    chatList.innerHTML = '';
    // 换标签页或重画时先收起悬浮按钮，聊天分支画完再按实际位置决定要不要露出。
    chatToBottom.classList.remove('is-shown');
    if (session.tab === 'chat') {
      if (!session.messages.length) {
        chatList.appendChild(placeholder(chatPlaceholderText(), 'danmaku'));
        return;
      }
      for (const message of session.messages) appendChatLine(message);
      chatList.scrollTop = chatList.scrollHeight;
      updateChatToBottom();
      return;
    }
    if (session.tab === 'sc') {
      // SC 分「正在显示 / 历史」两个视图，一次只渲染一个列表。
      // 历史最多 200 条，和当前 SC 同屏会把当前 SC 挤到渲染不出来。
      const nav = document.createElement('div');
      nav.className = 'sc-view-nav';
      nav.innerHTML = `
        <button data-view="active" class="${session.scView === 'active' ? 'active' : ''}">正在显示 ${session.scMessages.length}</button>
        <button data-view="history" class="${session.scView === 'history' ? 'active' : ''}">历史 ${session.scHistory.length}</button>`;
      nav.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', () => {
          session.scView = button.dataset.view;
          renderChatTab();
        });
      });
      chatList.appendChild(nav);

      if (session.scView === 'history') {
        if (!session.scHistory.length) {
          chatList.appendChild(placeholder('还没有归档的 SC', 'history'));
          return;
        }
        for (const message of session.scHistory) {
          const row = document.createElement('div');
          row.className = 'sc-history-item';
          const ended = new Date(message.endedAt);
          const clock = `${String(ended.getHours()).padStart(2, '0')}:${String(ended.getMinutes()).padStart(2, '0')}`;
          row.innerHTML = `
            <span class="sc-history-time" title="${message.reason === 'manual' ? '手动结束' : '到期自动结束'}">${clock}</span>
            <span class="sc-history-main">
              <b>${escapeHtml(message.user || 'B 站用户')}</b>
              <em>¥${Number(message.sc?.price) || 0}</em>
              <span class="sc-history-text">${escapeHtml(message.text)}</span>
            </span>`;
          chatList.appendChild(row);
        }
        chatList.scrollTop = keepScroll;
        return;
      }

      if (!session.scMessages.length) {
        chatList.appendChild(placeholder('当前没有正在显示的 SC', 'spark'));
        return;
      }
      for (const message of session.scMessages.slice().reverse()) {
        const card = document.createElement('div');
        card.className = 'sc-card';
        card.dataset.end = String(message.sc.end_time ?? '');
        const { top, bottom } = scTierColors(message.sc);
        card.style.backgroundColor = top;
        card.innerHTML = `
          <div class="sc-card-head">
            ${avatarHtml(message.user, message.sc.avatar, 32)}
            <b>${escapeHtml(message.user || 'B 站用户')}</b>
            <span class="sc-price">¥${Number(message.sc.price) || 0}</span>
            <button class="sc-card-close" title="结束这条 SC">${icon('close', 13)}</button>
          </div>
          <div class="sc-card-text">${escapeHtml(message.text)}</div>`;
        card.querySelector('.sc-card-text').style.backgroundColor = bottom;
        card.querySelector('.sc-card-close').addEventListener('click', () => removeScMessage(message, 'manual'));
        chatList.appendChild(card);
      }
      bindImageFallback(chatList);
      chatList.scrollTop = keepScroll;
      return;
    }
    if (session.tab === 'follow') {
      // 只列正在直播的关注，副标题只保留平台名，直播状态用左侧圆点表达。
      const all = loadFollow();
      const follows = all.filter((item) => item.live).slice(0, 40);
      const toolbar = document.createElement('div');
      toolbar.className = 'chat-follow-toolbar';
      toolbar.innerHTML = `<span>${follows.length} 位正在直播</span><button class="btn small" id="chat-follow-refresh">${icon('refresh', 13)} 刷新状态</button>`;
      toolbar.querySelector('#chat-follow-refresh').addEventListener('click', refreshRoomFollowStatus);
      chatList.appendChild(toolbar);
      if (!follows.length) {
        chatList.appendChild(placeholder(all.length ? '关注的主播都还没开播' : '你还没有关注其他主播', 'follow'));
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'chat-follow-grid';
      for (const item of follows) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'chat-follow-card';
        card.innerHTML = `
          ${avatarHtml(item.user_name, item.avatar || item.cover, 38)}
          <span class="chat-follow-info">
            <b title="${escapeHtml(item.user_name || '未知主播')}">${escapeHtml(item.user_name || '未知主播')}</b>
            <small><i class="chat-follow-dot live"></i>${escapeHtml(PLATFORM_META[item.platform]?.short || item.platform)}</small>
          </span>`;
        card.addEventListener('click', () => ctx.openRoom(item.platform, item.room_id));
        grid.appendChild(card);
      }
      chatList.appendChild(grid);
      bindImageFallback(grid);
      return;
    }
    if (session.tab === 'settings') {
      renderChatSettings();
      // 从聊天切过来时会沿用聊天的滚动位置，面板直接从中间开始显示、顶上的开关看不见。
      chatList.scrollTop = 0;
    }
  }

  function renderChatSettings(target = chatList) {
    const config = state.settings.danmaku;
    const wrap = document.createElement('div');
    wrap.className = 'chat-settings';

    /// 数值项一律自绘下拉，不再用原生 `<select>`：收起态还能靠 CSS 装一下，
    /// 展开那一下是 WebView 自己画的 —— 深色皮肤会弹出一块系统白底列表，
    /// 和这套皮肤没有任何关系。改成按钮 + openMenu（页面里其他菜单都是这一套），
    /// 展开态的底色/描边/选中色全部走 --surface-menu / --accent。
    ///
    /// 模板里调 picker() 时顺手登记一份选项，绑定阶段照着同一份走，
    /// 避免「模板里加了一项、绑定忘了写」这种只有点开才发现的问题。
    const pickers = [];
    const picker = (id, key, choices, numeric = true) => {
      pickers.push({ id, key, choices, numeric });
      const current = choices.find((item) => item.selected) || choices[0];
      return `<button type="button" class="chat-setting-select" id="${id}" data-value="${escapeHtml(String(current.value))}" aria-haspopup="menu"><span class="chat-setting-value">${escapeHtml(current.label)}</span>${icon('chevronDown', 13)}</button>`;
    };

    wrap.innerHTML = `
      <div class="chat-settings-group">
        <h4>弹幕设置</h4>
        <div class="chat-setting-row"><span>弹幕开关</span><button class="switch" id="cs-enabled" aria-checked="${session.danmakuEnabled}"></button></div>
        <div class="chat-setting-row"><span>弹幕表情</span><button class="switch" id="cs-emoji" aria-checked="${config.emoji !== false}"></button></div>
        <div class="chat-setting-row"><span>大表情大小</span>${picker('cs-big-emoji', 'bigEmojiLines', presetChoices(CS_PRESETS.bigEmoji, config.bigEmojiLines, (value) => `${value} 行`))}</div>
        <div class="chat-setting-row"><span>不透明度</span>${picker('cs-opacity', 'opacity', presetChoices(CS_PRESETS.opacity, config.opacity, (value) => `${value}%`))}</div>
        <div class="chat-setting-row"><span>显示区域</span>${picker('cs-area', 'area', presetChoices(CS_PRESETS.area, config.area, (value) => `${value}%`))}</div>
        <div class="chat-setting-row"><span>显示行数</span>${picker('cs-lines', 'lines', presetChoices(CS_PRESETS.lines, config.lines, (value) => `${value} 行`))}</div>
        <div class="chat-setting-row"><span>字体大小</span>${picker('cs-font', 'font', presetChoices(CS_PRESETS.font, config.font, (value) => `${value} px`))}</div>
        <div class="chat-setting-row"><span>字体粗细</span>${picker('cs-weight', 'weight', fixedChoices([[300, '极细'], [400, '很细'], [500, '正常'], [600, '小粗'], [700, '偏粗'], [800, '很粗'], [900, '极粗']], config.weight))}</div>
        <div class="chat-setting-row"><span>滚动速度</span>${picker('cs-speed', 'speed', presetChoices(CS_PRESETS.speed, config.speed, (value) => `${value} 秒`))}</div>
        <div class="chat-setting-row"><span>弹幕描边</span><button class="switch" id="cs-stroke" aria-checked="${config.stroke}"></button></div>
        <div class="chat-setting-row"><span>描边宽度</span>${picker('cs-stroke-width', 'strokeWidth', presetChoices(CS_PRESETS.strokeWidth, config.strokeWidth, (value) => `${value} px`))}</div>
        <div class="chat-setting-row"><span>顶部边距</span>${picker('cs-safe-top', 'safeTop', presetChoices(CS_PRESETS.safe, config.safeTop, (value) => `${value} px`))}</div>
        <div class="chat-setting-row"><span>底部边距</span>${picker('cs-safe-bottom', 'safeBottom', presetChoices(CS_PRESETS.safe, config.safeBottom, (value) => `${value} px`))}</div>
        <div class="chat-setting-row"><span>性能档位</span>${picker('cs-perf', 'perf', fixedChoices(PERF_OPTIONS.map((option) => [option.value, option.label]), config.perf), false)}</div>
        <div class="chat-setting-row"><span>帧率上限</span>${picker('cs-fps', 'fps', fixedChoices(FPS_OPTIONS.map((option) => [option.value, option.label]), config.fps))}</div>
      </div>
      <div class="chat-settings-group">
        <h4>屏蔽设置</h4>
        <div class="chat-setting-row"><span>启用屏蔽</span><button class="switch" id="cs-block" aria-checked="${config.block}"></button></div>
        <label class="chat-setting-field"><span>关键词屏蔽</span><textarea class="chat-setting-textarea" id="cs-block-keywords" placeholder="每行一个关键词">${escapeHtml(config.blockKeywords || '')}</textarea></label>
        <label class="chat-setting-field"><span>用户屏蔽</span><textarea class="chat-setting-textarea" id="cs-block-users" placeholder="每行一个用户名">${escapeHtml(config.blockUsers || '')}</textarea></label>
        <div class="chat-setting-row"><span>重复过滤</span><button class="switch" id="cs-dedupe" aria-checked="${config.dedupe}"></button></div>
        <div class="chat-setting-row"><span>过滤模式</span>${picker('cs-dedupe-mode', 'dedupeMode', fixedChoices([['content', '按内容'], ['user', '按用户'], ['strict', '刷屏严格']], config.dedupeMode), false)}</div>
        <div class="chat-setting-row"><span>过滤窗口</span>${picker('cs-dedupe-window', 'dedupeWindow', presetChoices(CS_PRESETS.dedupeWindow, config.dedupeWindow, (value) => `${value} 秒`))}</div>
        <div class="chat-setting-row"><span>过滤步长</span>${picker('cs-dedupe-step', 'dedupeStep', presetChoices(CS_PRESETS.dedupeStep, config.dedupeStep, (value) => `${value} 条`))}</div>
      </div>
      <div class="chat-settings-group">
        <h4>SC 设置</h4>
        <div class="chat-setting-row"><span>到期自动消失</span><button class="switch" id="cs-sc-auto" aria-checked="${state.settings.player.superChatAutoRemove}"></button></div>
        <div class="chat-setting-row"><span>左下角浮动显示</span><button class="switch" id="cs-sc-float" aria-checked="${state.settings.player.superChatOverlay}"></button></div>
      </div>
      <div class="chat-setting-tip">修改会立即保存并作用于当前弹幕；弹幕轨道会按实际位置避让，不再叠字。切换性能档位会重建渲染器，当前屏上的弹幕会被清掉。</div>`;
    target.appendChild(wrap);

    const bindSwitch = (id, key) => {
      const button = wrap.querySelector(`#${id}`);
      button.addEventListener('click', () => {
        const value = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(value));
        setConfig(key, value);
      });
    };
    // 数值项全部自绘：点按钮弹 openMenu，选完把值写回按钮文字 + setConfig。
    // 按钮上的 data-value 是唯一真相（菜单项只负责显示勾选态），
    // 这样再次点开时高亮的就是当前值，不用回头读 config。
    for (const { id, key, choices, numeric } of pickers) {
      const button = wrap.querySelector(`#${id}`);
      const label = button.querySelector('.chat-setting-value');
      button.addEventListener('click', () => {
        const value = numeric ? Number(button.dataset.value) : button.dataset.value;
        openMenu(
          button,
          choices.map((item) => ({
            label: item.label,
            active: item.value === value,
            onClick: () => {
              button.dataset.value = String(item.value);
              label.textContent = item.label;
              setConfig(key, numeric ? Number(item.value) : item.value);
            },
          }))
        );
      });
    }
    const bindTextarea = (id, key) => {
      const area = wrap.querySelector(`#${id}`);
      area.addEventListener('input', () => setConfig(key, area.value));
    };

    bindSwitch('cs-enabled', 'enabled');
    bindSwitch('cs-emoji', 'emoji');
    bindSwitch('cs-stroke', 'stroke');
    bindSwitch('cs-block', 'block');
    bindTextarea('cs-block-keywords', 'blockKeywords');
    bindTextarea('cs-block-users', 'blockUsers');
    bindSwitch('cs-dedupe', 'dedupe');
    const bindPlayerSwitch = (id, key) => {
      const button = wrap.querySelector(`#${id}`);
      button.addEventListener('click', () => {
        const value = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(value));
        setPlayerConfig(key, value);
      });
    };
    bindPlayerSwitch('cs-sc-auto', 'superChatAutoRemove');
    bindPlayerSwitch('cs-sc-float', 'superChatOverlay');
  }

  function setPlayerConfig(key, value) {
    state.settings.player[key] = value;
    saveSettings();
    if (key === 'superChatAutoRemove') {
      for (const entry of session.scMessages) {
        if (value) scheduleScRemoval(entry);
        else clearScTimer(entry);
      }
    }
    if (key === 'superChatOverlay') renderScOverlay();
  }

  function setConfig(key, value) {
    state.settings.danmaku[key] = value;
    if (key === 'enabled') {
      // 不要再自己写一套开关逻辑：统一交给 setDanmakuEnabled()，
      // 否则面板里的开关只关得掉、开不回来，也跟不上底部控件的状态。
      setDanmakuEnabled(value);
      return;
    }
    saveSettings();
    // 表情开关只影响「后续渲染」，聊天栏里已经画好的行要重画一遍才能立刻看到效果。
    // 弹幕层不用动：新弹幕在 emit 时会重新读配置，屏上的旧弹幕滚过去就算了。
    if (key === 'emoji' && session.tab === 'chat') renderChatTab();
    // 大表情大小改的是聊天栏的 CSS 变量（--big-emoji-lines），
    // 必须在这里单独推一次：聊天栏不在 applyDanmakuStyle 的触发列表里，
    // 漏了这一步，改成 3 行要退出直播间重进才生效。
    if (key === 'bigEmojiLines') applyBigEmojiSize(value);

    // 字号/行数/区域/速度的改动交给弹幕层：库内部会重排轨道并保留现有弹幕，
    // 只有字号变化才需要重建（弹幕实例的宽高是创建时固定的）。
    danmaku?.update(state.settings.danmaku);
    // 边距变化会改变容器尺寸，弹幕层自己会感知并重排。
    if (['opacity', 'lines', 'area', 'font', 'weight', 'stroke', 'strokeWidth', 'safeTop', 'safeBottom'].includes(key)) {
      applyDanmakuStyle();
    }
  }

  // ------------------------------------------------------------ 回到底部

  // 往上翻历史时新弹幕还在往下堆，底部会越来越远，给一个悬浮按钮直接跳回去。
  const CHAT_PIN_GAP = 80; // 距底这么近就算「贴着底部」，新消息自动跟着滚
  const CHAT_BUTTON_GAP = 160; // 拉开这么远才浮出按钮，免得轻微滚动就一直闪

  function chatGapToBottom() {
    return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight;
  }

  function updateChatToBottom() {
    // 只有「聊天」标签页有底部可言，SC / 关注 / 设置页不显示这个按钮。
    const show = session.tab === 'chat' && chatGapToBottom() > CHAT_BUTTON_GAP;
    chatToBottom.classList.toggle('is-shown', show);
  }

  function scrollChatToBottom(smooth = true) {
    if (smooth) chatList.scrollTo({ top: chatList.scrollHeight, behavior: 'smooth' });
    else chatList.scrollTop = chatList.scrollHeight;
    updateChatToBottom();
  }

  function setChatTab(tab) {
    session.tab = tab;
    for (const button of page.querySelectorAll('.chat-tab')) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }
    renderChatTab();
    syncChatTabUnderline();
    updateComposer();
  }

  // 聊天标签下方的主色条：所有标签共用一个元素，切换时滑过去。
  // 标签宽度会随 SC 计数变化，所以每次切标签、计数变动都要重新量一次。
  const chatTabUnderline = page.querySelector('.chat-tab-underline');
  let chatTabUnderlineReady = false;
  function syncChatTabUnderline() {
    const active = page.querySelector('.chat-tab.active');
    if (!chatTabUnderline || !active) return;
    // 和原来的 ::after 一样左右各缩 22%，条比文字长一点。
    const inset = active.offsetWidth * 0.22;
    if (!chatTabUnderlineReady) chatTabUnderline.style.transition = 'none';
    chatTabUnderline.style.width = `${Math.max(0, active.offsetWidth - inset * 2)}px`;
    chatTabUnderline.style.transform = `translateX(${active.offsetLeft + inset}px)`;
    if (!chatTabUnderlineReady) {
      // 首次定位不要动画，否则进房间时会看到色条从左边滑过来。
      void chatTabUnderline.offsetWidth;
      chatTabUnderline.style.transition = '';
      chatTabUnderlineReady = true;
    }
  }

  // 横竖屏旋转、拖窗口宽度都会改标签的实际宽度（横屏更宽、SC 计数还会撑开一格），
  // 色条位置是量出来写死的，不重量就停在旧位置。和首页平台标签同一套做法：
  // ResizeObserver 盯容器 + resize/orientationchange 兜底，debounce 让旋转时的抖动先过去。
  const chatTabsBox = page.querySelector('#chat-tabs');
  let chatUnderlineTimer = 0;
  const onChatUnderlineResize = () => {
    clearTimeout(chatUnderlineTimer);
    chatUnderlineTimer = setTimeout(() => {
      if (chatTabsBox?.offsetWidth) syncChatTabUnderline();
    }, 120);
  };
  window.addEventListener('resize', onChatUnderlineResize);
  window.addEventListener('orientationchange', onChatUnderlineResize);
  let chatTabsObserver = null;
  if (typeof ResizeObserver === 'function' && chatTabsBox) {
    chatTabsObserver = new ResizeObserver(onChatUnderlineResize);
    chatTabsObserver.observe(chatTabsBox);
  }

  // 发送弹幕的输入框默认隐藏（设置 → 弹幕与SC设置 → 允许发送弹幕），
  // 只在「聊天」标签下显示，避免挡住 SC/关注/设置面板。
  function updateComposer() {
    const enabled = Boolean(state.settings.danmaku.sendEnabled);
    const visible = enabled && session.tab === 'chat';
    composer.classList.toggle('hidden', !visible);
  }

  // 发送一条纯文本弹幕。失败原因原样透出（未登录 / 频率限制 / 平台不支持），
  // 不要吞成一句「发送失败」，否则用户不知道是没登录还是被风控。
  async function submitDanmaku(event) {
    event?.preventDefault();
    const text = chatInput.value.trim();
    if (!text || session.sendingDanmaku) return;
    session.sendingDanmaku = true;
    composer.classList.add('is-sending');
    try {
      await api.sendDanmaku(session.key, text);
      chatInput.value = '';
      toast('弹幕已发送');
    } catch (error) {
      toast(`发送失败：${error}`);
    } finally {
      session.sendingDanmaku = false;
      composer.classList.remove('is-sending');
      if (!session.destroyed) chatInput.focus();
    }
  }

  function setChatCollapsed(collapsed) {
    session.chatCollapsed = collapsed;
    chat.classList.toggle('hidden', collapsed);
    $('chat-expand').classList.toggle('hidden', !collapsed);
    if (!collapsed) {
      page.classList.remove('ui-idle');
      renderChatTab();
    }
    // 收起/展开聊天栏会改画面宽度（横屏与平板），控制条放不放得下要重新算。
    requestAnimationFrame(applyControlDensity);
  }

  // ------------------------------------------------------------ 聊天栏宽度

  // 聊天栏宽度可以拖左边缘调整，记住上次的选择。
  const CHAT_WIDTH_KEY = 'starveil.chatWidth.v1';
  const MIN_CHAT_WIDTH = 240;
  const MAX_CHAT_WIDTH = 560;

  /// 窗口变窄时聊天栏不能把视频挤没，留至少 360px 给画面。
  function maxChatWidth() {
    return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, window.innerWidth - 360));
  }

  function applyChatWidth(width) {
    const clamped = Math.round(Math.min(maxChatWidth(), Math.max(MIN_CHAT_WIDTH, width)));
    page.style.setProperty('--chat-width', `${clamped}px`);
    return clamped;
  }

  function restoreChatWidth() {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    if (!Number.isFinite(saved) || saved <= 0) return;
    applyChatWidth(saved);
  }

  function setupChatResizer() {
    const resizer = $('chat-resizer');
    if (!resizer) return;
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (event) => {
      if (!dragging) return;
      event.preventDefault();
      // 往左拖是加宽，往右拖是变窄。
      applyChatWidth(startWidth - (event.clientX - startX));
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing-chat');
      localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(chat.getBoundingClientRect().width)));
    };

    resizer.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = chat.getBoundingClientRect().width;
      resizer.classList.add('is-dragging');
      document.body.classList.add('is-resizing-chat');
    });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 离开直播间后要摘掉全局监听，否则监听会一直挂着。
    session.resizerCleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }

  // ------------------------------------------------------------ 播放器

  function setHint(options) {
    if (!options) {
      hint.classList.add('hidden');
      return;
    }
    hint.classList.remove('hidden');
    hint.innerHTML = `${options.spinner ? '<span class="big-spinner"></span>' : ''}<span>${escapeHtml(options.text || '')}</span>${options.actions ? `<div class="hint-actions">${options.actions}</div>` : ''}`;
  }

  /// 把毫秒格式化成 `H:MM:SS`。
  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /// 左下角显示的是“这场直播已经播了多久”，拿不到开播时间时退回本次观看时长。
  function updateClock() {
    if (!clock) return;
    const startedAt = Number(session.detail?.live_start_time) > 0
      ? Number(session.detail.live_start_time) * 1000
      : session.playStartedAt;
    if (!startedAt) {
      clock.textContent = '--:--:--';
      clock.title = '直播时长';
      return;
    }
    clock.textContent = formatDuration(Date.now() - startedAt);
    clock.title = Number(session.detail?.live_start_time) > 0 ? '本场已直播时长' : '已观看时长';
  }

  function setQualityLabel() {
    const quality = session.qualities[session.qualityIndex];
    // 线路标签带上协议：用户能一眼看出当前是 FLV 还是 HLS，排查问题也省得猜。
    const line = session.lines[session.lineIndex];
    const suffix = line?.protocol === 'hls' ? ' · HLS' : '';
    // 只改文字，不动按钮里的箭头图标；文字单独一层才做得出省略号。
    $('ctrl-quality-label').textContent = quality || '清晰度';
    $('ctrl-line-label').textContent = `线路 ${session.lineIndex + 1}${suffix}`;
    // 档位名长短差很多（「原画」→「1080p60」），标签一长就可能把中间那段挤爆。
    // 换完文字立刻重量一次，够不够放得下按新的宽度判断。
    applyControlDensity();
  }

  function showQualityMenu(anchor = $('ctrl-quality'), placement = 'top') {
    if (!session.qualities.length) return;
    openMenu(anchor, session.qualities.map((name, index) => ({
      label: name,
      active: index === session.qualityIndex,
      onClick: () => selectQuality(index),
    })), { align: 'end', placement });
  }

  function showLineMenu(anchor = $('ctrl-line'), placement = 'top') {
    if (session.lines.length <= 1) {
      toast('当前只有一条线路');
      return;
    }
    openMenu(anchor, session.lines.map((line, index) => ({
      label: line.protocol === 'hls' ? `线路 ${index + 1} · HLS` : `线路 ${index + 1}`,
      value: line.url.includes('127.0.0.1') ? '' : shortHost(line.url),
      active: index === session.lineIndex,
      onClick: () => playLine(index),
    })), { align: 'end', placement });
  }

  function shortHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '线路';
    }
  }

  function selectQuality(index) {
    session.qualityIndex = index;
    if (state.settings.player.rememberQuality) {
      localStorage.setItem(`${QUALITY_KEY}${session.platform}`, String(index));
    }
    setQualityLabel();
    refreshStream(false);
  }

  /// 设置里的「默认清晰度」落到当前平台的清晰度列表上。
  ///
  /// 各平台档位名字不统一（B 站 原画/蓝光/超清/高清/流畅，虎牙 蓝光20M/蓝光4M/超清…），
  /// 所以按关键词从高到低匹配；匹配不到就退回平台默认档，而不是硬选最低档——
  /// 用户选了「1080P 优先」，平台没这个叫法时给出平台默认的观感更合理。
  function pickDefaultQuality(platform, huyaDefault) {
    const fallback = platform === 'huya' && huyaDefault >= 0 ? huyaDefault : 0;
    const mode = state.settings.player?.defaultQuality || 'auto';
    const list = session.qualities;
    if (!list.length) return 0;
    if (mode === 'auto') return fallback;
    if (mode === 'highest') return 0;
    if (mode === 'lowest') return list.length - 1;
    const keywords = {
      // 键名与设置页的 valueMap 保持一致（不能是纯数字，见那边的注释）。
      fullhd: ['1080', '超清', '蓝光', '原画'],
      hd: ['720', '高清'],
      sd: ['480', '标清', '流畅'],
      smooth: ['流畅', '极速', '标清'],
    }[mode];
    if (!keywords) return fallback;
    // 关键词按优先级逐个找：加上分辨率前缀后，「原画 4K」也含「原画」，
    // 一起 any 匹配会让「1080P 优先」落到 4K 上。
    for (const word of keywords) {
      const index = list.findIndex((name) => String(name).includes(word));
      if (index >= 0) return index;
    }
    return fallback;
  }

  function destroyPlayer() {
    // 换线/重连会先把旧播放器拆掉，这里先结算这一段观看时长。
    stopWatchClock();
    // 延迟播放的攒缓冲循环跟着播放器一起停，否则换线后它还在数旧缓冲。
    stopDelayGate();
    if (session.player) {
      try {
        if (session.playerProtocol === 'hls') {
          // hls.js 只认 destroy()；mpegts 的 unload/detach 它没有。
          session.player.destroy();
        } else {
          session.player.pause();
          session.player.unload();
          session.player.detachMediaElement();
          session.player.destroy();
        }
      } catch {
        /* 忽略销毁异常 */
      }
      session.player = null;
    } else if (session.playerProtocol === 'native-hls') {
      // 原生 HLS（iOS/Safari 路线）没实例可销毁，清掉 src 释放解码器。
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        /* 忽略 */
      }
    }
    session.playerProtocol = '';
    session.playerReady = false;
  }

  // ------------------------------------------------------------ 观看时长统计
  //
  // 口径是「真的在播的时间」：暂停、断流、换线、加载中都不计，
  // 否则把直播间挂着不动也会一直累加。结算出的毫秒先放在 watchPending 里，
  // 由 30 秒心跳写进 localStorage，关窗最多丢一个周期。
  function startWatchClock() {
    if (session.destroyed || session.watchSince) return;
    session.watchSince = Date.now();
  }

  function flushWatch() {
    if (session.watchPending < 1000) return;
    const value = session.watchPending;
    session.watchPending = 0;
    addWatchTime(session.platform, session.roomId, value);
  }

  function stopWatchClock() {
    if (session.watchSince) {
      const delta = Date.now() - session.watchSince;
      session.watchSince = 0;
      if (delta > 0) session.watchPending += delta;
    }
    flushWatch();
  }

  session.watchTimer = setInterval(() => {
    if (session.watchSince) {
      const now = Date.now();
      session.watchPending += now - session.watchSince;
      session.watchSince = now;
    }
    flushWatch();
  }, 30000);

  // 关窗/切页时同步补一次，靠 pagehide 而不是 beforeunload（后者在 WebView2 里不保证触发）。
  const flushWatchOnHide = () => stopWatchClock();
  window.addEventListener('pagehide', flushWatchOnHide);
  const resumeWatchOnShow = () => {
    if (!document.hidden && !video.paused) startWatchClock();
  };
  document.addEventListener('visibilitychange', resumeWatchOnShow);

  // 线路播放失败时的统一处理：能自动换线就换，换不了才把提示交给用户。
  // FLV 与 HLS 走同一套逻辑，避免两条路径给出不一致的行为。
  /// 自动重连一轮，返回 false 表示已经放弃（调用方去显示错误页）。
  ///
  /// 一次断流会连发好几个 ERROR 事件，没有 `reconnecting` 挡着就会同时发起三四个
  /// `refreshStream()`，最后互相把对方的播放器拆掉，表现是「越重连越黑屏」。
  /// 退避 700ms × 次数，第三轮失败后把选择权交给用户。
  function scheduleReconnect() {
    if (session.reconnecting) return true;
    if (session.errorRetries >= 3) return false;
    session.errorRetries += 1;
    session.reconnecting = true;
    const attempt = session.errorRetries;
    setTimeout(() => {
      if (session.destroyed) return;
      session.reconnecting = false;
      toast(attempt === 1 ? '直播流断开，正在重连…' : `正在第 ${attempt} 次重连…`);
      refreshStream();
    }, 700 * attempt);
    return true;
  }

  /// 斗鱼直链到期前换一份新地址。
  ///
  /// 有效期是 CDN 在地址里写死的 `expire=` 参数：高码率档只有 **300 秒**
  /// （实测到点就是干净的一刀，不是网络抖动），而且不能靠改查询串续命——
  /// 追加或替换 `expire` 会让签名失效，一个字节都读不到。所以只能在到期前
  /// 重新签一份新地址。
  ///
  /// 续签只更新后端 `proxy_targets` 里同一个 token 的地址，不碰播放器：
  /// 正在播的上游连接照旧，等它被 CDN 断掉时，本机代理原地接上新地址，
  /// 并把新一路流的 FLV 头去掉、时间戳接着排（`src-tauri/src/flv.rs`），
  /// 播放器那条 HTTP 流从头到尾没断过。
  const STREAM_RENEW_FALLBACK_S = 40 * 60;
  /// 提前量：留出一次请求 + 握手的时间，也避免和 CDN 的时钟差异撞上。
  const STREAM_RENEW_LEAD_S = 45;

  function startStreamRenew(expiresIn) {
    clearTimeout(session.renewTimer);
    session.renewTimer = 0;
    if (session.platform !== 'douyu') return;
    const lifetime = Number(expiresIn) > 0 ? Number(expiresIn) : STREAM_RENEW_FALLBACK_S;
    const delay = Math.max(30, lifetime - STREAM_RENEW_LEAD_S) * 1000;
    session.renewTimer = setTimeout(async () => {
      session.renewTimer = 0;
      if (session.destroyed) return;
      let nextExpires = expiresIn;
      try {
        // 续签必须带上同一个 audioOnly：代理按 token 区分纯音频条目，
        // 换成带视频的那一条会让续接后的字节突然多出视频 tag。
        const payload = await api.play(session.key, session.qualityIndex, {
          audioOnly: session.audioOnly,
        });
        if (session.destroyed) return;
        const lines = buildLines(payload);
        if (lines.length) {
          session.lines = lines;
          session.headers = payload.headers || session.headers;
          if (session.lineIndex >= lines.length) session.lineIndex = 0;
        }
        // 新地址的有效期可能和上一份不同（登录后更长），按最新的排下一轮。
        if (Number(payload?.expires_in) > 0) nextExpires = Number(payload.expires_in);
      } catch {
        /* 续签失败不打扰用户：代理那边旧连接还能撑一会儿，下次刷新会再来 */
      }
      // 无论这次成没成都要排下一轮，否则一次网络抖动就再也不会续签了。
      if (!session.destroyed) startStreamRenew(nextExpires);
    }, delay);
  }

  function onLineError(detail) {
    if (session.destroyed) return;
    console.warn('[room] 线路报错', detail);
    if (state.settings.player.autoSwitchLine && session.lineIndex + 1 < session.lines.length) {
      toast('当前线路播放失败，正在切换线路…');
      setTimeout(() => {
        if (!session.destroyed) playLine(session.lineIndex + 1);
      }, 300);
      return;
    }
    // 线路用尽：斗鱼 CDN 掐连接、地址过期都在这里兜住，不再让用户点重试。
    if (scheduleReconnect()) {
      setHint({ spinner: true, text: '直播流断开，正在重新获取地址…' });
      return;
    }
    setHint({
      text: `播放失败：${detail || '无法连接视频流'}`,
      actions: '<button class="btn" id="hint-switch">换线</button><button class="btn primary" id="hint-retry">重试</button>',
    });
    bindHintActions();
  }

  // HLS 线路：优先 hls.js（MSE），没有 MSE 时退回原生 HLS（iOS/WKWebView 那条路）。
  function playHls(url) {
    const Hls = window.Hls;
    const delay = Number(session.delaySec) || 0;
    if (Hls && Hls.isSupported()) {
      try {
        const hls = new Hls({
          // 缓冲档位（设置 → 播放缓冲）：窗口大小、起播分片数都在档位表里。
          ...hlsBufferOptions(),
          // 延迟播放：hls.js 直接按秒数决定起播点，不用外面再压一层缓冲。
          ...(delay > 0
            ? { liveSyncDuration: delay + 2, liveMaxLatencyDuration: delay + 12 }
            : {}),
          backBufferLength: 30,
          manifestLoadingTimeOut: 8000,
          fragLoadingTimeOut: 20000,
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal) return;
          console.error('hls error', data.type, data.details);
          hls.destroy();
          session.player = null;
          session.playerProtocol = '';
          onLineError(data.details);
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        session.player = hls;
        session.playerProtocol = 'hls';
        session.playerReady = true;
        resumePlayback(true);
        return;
      } catch (error) {
        setHint({ text: `创建 HLS 播放器失败：${error}`, actions: '<button class="btn primary" id="hint-retry">重试</button>' });
        bindHintActions();
        return;
      }
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      session.playerProtocol = 'native-hls';
      session.playerReady = true;
      video.src = url;
      resumePlayback();
      return;
    }
    setHint({
      text: '当前 WebView 既没有 MSE 也不支持原生 HLS，无法播放这条线路',
      actions: '<button class="btn" id="hint-switch">换线</button>',
    });
    bindHintActions();
  }

  // 自动播放被拦截时静音兜底，不弹遮挡提示。
  /// `skipDelay` 给 hls.js 用：它按 `liveSyncDuration` 自己起播，
  /// 再压一层就等于等两遍。
  function resumePlayback(skipDelay = false) {
    if (!skipDelay && Number(session.delaySec) > 0) {
      holdForDelay(Number(session.delaySec));
      return;
    }
    playNow();
  }

  function playNow() {
    const promise = video.play();
    if (promise?.catch) promise.catch(() => {
      if (session.destroyed) return;
      video.muted = true;
      video.play().catch(() => {});
    });
  }

  function playLine(index) {
    const line = session.lines[index];
    if (!line) {
      setHint({ text: '没有可用的播放地址', actions: '<button class="btn" id="hint-retry">重试</button>' });
      bindHintActions();
      return;
    }
    session.lineIndex = index;
    // 换线路 = 重新开一轮尝试，之前「已放弃自动重连」的结论作废。
    session.streamDead = false;
    setQualityLabel();
    // 这里**不要**再 `danmaku.reset()`。换线 / 重取流跟弹幕没关系，
    // 但每次清空整层，在下播后自动重连的循环里会表现为「弹幕一直在闪」或者
    // 「弹幕层不动了」——而聊天栏还在正常刷新，看着就像弹幕流和直播流绑死了。
    setHint({ spinner: true, text: '正在连接视频流…' });
    destroyPlayer();
    if (line.protocol === 'hls') {
      playHls(line.url);
      return;
    }
    if (!window.mpegts || !mpegts.isSupported()) {
      setHint({ text: '当前 WebView 不支持 FLV（MSE）播放' });
      return;
    }
    const source = { type: 'flv', url: line.url, isLive: true, cors: true };
    if (session.headers?.length) {
      source.headers = Object.fromEntries(session.headers);
      source.withCredentials = false;
    }
    let player;
    try {
      player = mpegts.createPlayer(source, {
        enableWorker: false,
        lazyLoad: false,
        // 缓冲大小按设置里的档位来（定义见 player-buffer.js）。
        // 开了「延迟播放」就不能追帧：那一档是靠刻意落后实现的，
        // 库一去追帧就等于把用户设的延迟一秒秒吃掉。
        ...flvBufferOptions(Number(session.delaySec) <= 0),
        autoCleanupSourceBuffer: true,
        fixAudioTimestampGap: true,
      });
      player.attachMediaElement(video);
      player.on(mpegts.Events.ERROR, (_type, detail) => {
        console.error('mpegts error', _type, detail);
        onLineError(detail);
      });
      player.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (!session.destroyed && video.paused) setHint({ text: '直播流已结束，可以尝试刷新', actions: '<button class="btn primary" id="hint-retry">刷新</button>' });
        bindHintActions();
      });
      player.load();
      session.player = player;
      session.playerProtocol = 'flv';
      session.playerReady = true;
      resumePlayback();
    } catch (error) {
      setHint({ text: `创建播放器失败：${error}`, actions: '<button class="btn primary" id="hint-retry">重试</button>' });
      bindHintActions();
    }
  }

  /// 用户主动刷新：先把「自动重连已放弃」的标记清掉，再重新取流。
  /// 卡顿检测自己调的 `refreshStream()` 不走这里，否则计数永远清零、重试停不下来。
  function manualRefreshStream() {
    session.stallRetries = 0;
    session.streamDead = false;
    refreshStream();
  }

  function bindHintActions() {
    hint.querySelector('#hint-retry')?.addEventListener('click', () => manualRefreshStream());
    hint.querySelector('#hint-switch')?.addEventListener('click', () => {
      if (session.lines.length > 1) playLine((session.lineIndex + 1) % session.lines.length);
      else toast('当前没有其他线路');
    });
    hint.querySelector('#hint-browser')?.addEventListener('click', () => {
      openExternal(session.detail?.url || roomUrl(session.platform, session.roomId));
    });
    hint.querySelector('#hint-back-home')?.addEventListener('click', () => ctx.go('home'));
  }

  // 后端把 FLV 与 HLS 分开返回：FLV 走本机代理（补 Referer/CORS），
  // HLS 直连 CDN。FLV 在前，HLS 作为兜底线路排在后面。
  function buildLines(payload) {
    const lines = [];
    for (const url of payload.urls || []) lines.push({ url, protocol: 'flv' });
    for (const url of payload.hls_urls || []) lines.push({ url, protocol: 'hls' });
    return lines;
  }

  async function refreshStream(resetQuality = false) {
    if (!session.key) return;
    setHint({ spinner: true, text: '正在获取播放地址…' });
    try {
      // 同屏时 A 只要声音：audioOnly 让代理丢掉视频 tag。
      const payload = await api.play(session.key, session.qualityIndex, {
        audioOnly: session.audioOnly,
      });
      if (session.destroyed) return;
      session.lines = buildLines(payload);
      session.headers = payload.headers || [];
      session.lineIndex = 0;
      session.lineFailures = 0;
      setQualityLabel();
      // 斗鱼的地址有有效期（`expires_in` 秒），进房就按它排上续签；
      // 其它平台这个函数直接返回。
      startStreamRenew(payload.expires_in);
      if (!session.lines.length) {
        setHint({ text: '这个房间暂时没有可用的播放地址（可能未开播或限制地区）', actions: '<button class="btn" id="hint-retry">重试</button>' });
        bindHintActions();
        return;
      }
      playLine(0);
    } catch (error) {
      if (session.destroyed) return;
      setHint({
        text: `获取播放地址失败：${error}`,
        actions: '<button class="btn primary" id="hint-retry">重试</button>',
      });
      bindHintActions();
    }
  }

  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = session.lastVolume || 0.8;
    updateVolumeIcon();
  }

  function updateVolumeIcon() {
    const muted = video.muted || video.volume === 0;
    $('ctrl-volume').innerHTML = icon(muted ? 'mute' : 'volume', 21);
    volumeRange.value = String(Math.round((muted ? 0 : video.volume) * 100));
  }

  /// 手机上的音量浮层开关（桌面不用，靠 :hover）。
  function setVolumePop(open) {
    volumeWrap.classList.toggle('is-open', Boolean(open));
    $('ctrl-volume').classList.toggle('active', Boolean(open));
  }

  /// 点浮层外面收起音量条；点按钮自己不算「外面」，否则一次点击会被这里先关掉。
  function onVolumeOutside(event) {
    if (!volumeWrap.classList.contains('is-open')) return;
    if (volumeWrap.contains(event.target)) return;
    setVolumePop(false);
  }

  function updatePlayIcon() {
    page.classList.toggle('is-paused', video.paused);
  }

  /// 当前是不是「铺满画面」的状态。
  ///
  /// 桌面上是浏览器 Fullscreen API（document.fullscreenElement），安卓 WebView 不支持它，
  /// 走的是 CSS 剧场模式（html.is-theater）。这两条路的判断以前散在各处，
  /// 「全屏里点设置 → 弹幕与SC设置没反应」「全屏按返回直接退出直播间」都是只看
  /// document.fullscreenElement 造成的——安卓上它永远是 null。
  function isPlayerFullscreen() {
    return Boolean(document.fullscreenElement) || page.classList.contains('is-theater');
  }

  /// 退出铺满状态（不离开直播间）。
  function exitPlayerFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (page.classList.contains('is-theater')) setTheater(false);
  }

  /// 安卓的「全屏」。
  ///
  /// Android WebView 不实现 `requestFullscreen()`（没有 WebChromeClient 的全屏回调），
  /// 点了只会报「全屏失败」。这里改成两半：CSS（`html.is-theater`）把视频铺满并收掉
  /// 聊天区/底栏/侧栏，系统栏由 `set_immersive` 藏起来；顺手把方向掰到横屏，
  /// 退出时恢复设置里的方向。
  function setTheater(active) {
    page.classList.toggle('is-theater', active);
    document.documentElement.classList.toggle('is-theater', active);
    $('ctrl-fullscreen').innerHTML = icon(active ? 'fullscreenExit' : 'fullscreen', 21);
    // 顶部返回按钮在全屏里表示「退全屏」，标题跟着改，免得点了才发现不是退出直播间。
    const back = $('room-back');
    back.title = active ? '退出全屏' : '返回';
    api.setImmersive(active).catch(() => {});
    const setting = state.settings.appearance?.orientation || 'auto';
    const target = active ? (setting === 'portrait' ? 'portrait' : 'landscape') : setting;
    api.setScreenOrientation(target).catch(() => {});
    page.classList.remove('ui-idle');
    wake();
    requestAnimationFrame(applyControlDensity);
  }

  /// 舞台上「双击切全屏」要跳过的区域。
  ///
  /// 控制条、顶栏、错误卡、SC 卡片各有自己的点击行为，连点两下（比如把音量
  /// 按两下）不该顺手把画面全屏掉。小窗（`.is-pip`）也在这里：它的双击由
  /// bindPipDrag 处理，放过来会先全屏再被自己切一次，等于没切。
  const STAGE_NO_DBLCLICK = [
    '.player-controls',
    '.room-topbar',
    '.stage-hint',
    '.sc-float-card',
    '.pip-close',
    '.audio-only-badge',
    '.is-pip',
    'button',
    'input',
    'textarea',
    'select',
    'a',
  ].join(', ');

  function isStageControl(target) {
    return Boolean(target?.closest?.(STAGE_NO_DBLCLICK));
  }

  async function toggleFullscreen() {
    if (IS_MOBILE) {
      setTheater(!page.classList.contains('is-theater'));
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // 只让直播间全屏，避免把左侧导航/顶栏也带进全屏。
        try {
          await page.requestFullscreen();
        } catch {
          await document.documentElement.requestFullscreen();
        }
      }
    } catch (error) {
      toast(`全屏失败：${error}`);
    }
    // 进出全屏都先唤出控制条；退出后不要让上一轮的全屏隐藏状态残留。
    page.classList.remove('ui-idle');
    wake();
  }

  async function togglePip() {
    if (IS_MOBILE) {
      // Android WebView 不实现 HTML5 画中画（requestPictureInPicture 直接 reject），
      // 只能让系统把小窗浮起来：Activity 级 PiP，整个应用缩成小窗。
      try {
        const entered = await api.enterPictureInPicture();
        if (entered) {
          setPipMode(true);
          // 小窗里视频要接着放：系统暂停过一次的话这里补一次 play。
          video.play().catch(() => {});
          if (page.classList.contains('is-dual')) videoB.play().catch(() => {});
          toast('已进入小窗，返回键可退出', 'info', 3000);
        } else {
          toast('当前系统不支持小窗播放（需要 Android 8.0 及以上）');
        }
      } catch (error) {
        toast(`小窗播放失败：${error}`);
      }
      return;
    }
    // 只播放音频时没有视频轨，小窗里会是一片黑。
    if (page.classList.contains('is-audio-only')) {
      toast('只播放音频时没有画面，小窗里也是黑的');
      return;
    }
    // 同屏时台前是主画面（默认 B，互换后是 A）：小窗里要显示的就是铺满的那个，
    // 而不是缩在角落的那一路，否则拖出来是一张很小的画面。
    const pipVideo = page.classList.contains('is-dual')
      ? (session.dualFlip ? video : videoB)
      : video;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await pipVideo.requestPictureInPicture();
      }
    } catch {
      toast('当前画面不支持画中画');
    }
  }

  /// 小窗（PiP）模式：整个应用被缩成一个小窗口，聊天栏、底栏、控制条统统收起，
  /// 只留视频铺满——否则 192×108 的窗口里全是零碎的 UI。
  ///
  /// 退出小窗时系统不会再通知一次（WebView 一直是「可见」的），所以每秒问一次
  /// 系统还进不进去；退出后把布局还原，播放不受影响。
  function setPipMode(active) {
    document.documentElement.classList.toggle('is-pip', active);
    page.classList.toggle('is-pip', active);
    clearInterval(session.pipWatch);
    session.pipWatch = 0;
    if (!active) return;
    session.pipWatch = setInterval(async () => {
      if (session.destroyed) {
        clearInterval(session.pipWatch);
        session.pipWatch = 0;
        return;
      }
      try {
        const stillPip = await api.inPictureInPicture();
        if (!stillPip) setPipMode(false);
      } catch {
        /* 查询失败就保持现状，下一轮再试 */
      }
    }, 1000);
  }

  video.addEventListener('playing', () => {
    setHint(null);
    updatePlayIcon();
    session.failed = false;
    // 出画 = 这一轮重连成功，计数清零；否则几次小抖动累加满 3 次之后就再也不自动重连了。
    session.errorRetries = 0;
    session.reconnecting = false;
    session.playStartedAt = Date.now();
    session.lastProgressTime = video.currentTime;
    session.lastProgressAt = Date.now();
    // 竖屏直播（9:16）和横屏直播的容器高度不一样：竖屏让视频区更高一些，
    // 横屏保持 16:9，避免宽画面上下留出两条大黑边。
    page.classList.toggle('is-portrait-video', video.videoHeight > video.videoWidth);
    // 真正出画了才开始计观看时长。
    startWatchClock();
  });
  video.addEventListener('ended', () => {
    if (session.destroyed) return;
    // 流断了就不该继续累计时长，重连上会由 playing 重新开始计时。
    stopWatchClock();
    // 有些线路第一次会返回一个只有几百毫秒的失效分片，自动重取一次。
    // 斗鱼长连接被 CDN 掐掉时也是这条路径（mpegts 正常收尾 → ended）。
    if (scheduleReconnect()) {
      setHint({ spinner: true, text: '直播流意外结束，正在重新连接…' });
      return;
    }
    setHint({
      text: '直播流已结束，可以刷新看看，或者换一条线路。',
      actions: '<button class="btn primary" id="hint-retry">刷新</button>',
    });
    bindHintActions();
  });
  video.addEventListener('pause', () => {
    updatePlayIcon();
    page.classList.remove('ui-idle');
    stopWatchClock();
  });
  video.addEventListener('volumechange', updateVolumeIcon);
  video.addEventListener('error', () => {
    if (session.destroyed) return;
    stopWatchClock();
    setHint({ text: '视频播放出错，请尝试刷新或换线', actions: '<button class="btn" id="hint-retry">刷新</button>' });
    bindHintActions();
  });
  // 直播不提供暂停；单击只负责唤出控制条，双击进入/退出全屏。
  //
  // 双击挂在舞台上而不是 #player 上：同屏时主画面是 pointer-events:none
  // （点击要穿透到舞台，否则会把控制条挡住），事件到不了 video。而且画面
  // 本来就不止 #player 一个——B 的画面、小窗之外的空白、只播放音频时的黑底，
  // 双击它们都该切全屏。
  video.addEventListener('click', wake);
  // 双击的第二下按下去时掐掉默认动作：否则浏览器会把被双击的 video 整个选中，
  // 在上面盖一层蓝色选区（看着像画面蒙了层色），文字也可能被一起框住。
  // 控件除外——连点两下按钮不该被拦。
  stage.addEventListener('mousedown', (event) => {
    if (event.detail > 1 && !isStageControl(event.target)) event.preventDefault();
  });
  stage.addEventListener('dblclick', (event) => {
    if (isStageControl(event.target)) return;
    toggleFullscreen();
  });

  // ------------------------------------------------------------ 房间信息

  function renderRoomHeader() {
    const detail = session.detail;
    if (!detail) return;
    $('room-title').textContent = detail.title || '(无标题)';
    const avatar = canonicalImage(detail.avatar || detail.cover);
    const cover = canonicalImage(detail.cover || detail.avatar);
    $('room-sub').innerHTML = `
      ${avatarHtml(detail.user_name, avatar, 22, 'avatar-mini')}
      <span class="name">${escapeHtml(detail.user_name || '未知主播')}</span>
      <span class="dot">·</span>
      <span class="area">${escapeHtml(detail.area || PLATFORM_META[session.platform]?.short || '直播')}</span>
      <span class="online">${icon('flame', 12)}${formatOnline(detail.online)}</span>`;
    $('chat-avatar').innerHTML = avatarHtml(detail.user_name, avatar, 42);
    bindImageFallback(page);
    $('chat-name').textContent = detail.user_name || '聊天';
    // 聊天区第二行：平台 + 开播状态 + 观众数据。
    // 「看过人数」是 B 站的累计观看量，不是实时在线人数，所以口径写成「看过」。
    const viewers = Number(detail.viewers) || 0;
    const guards = Number(detail.guard_count) || 0;
    const dataBits = [];
    if (viewers > 0) dataBits.push(`<span class="online">${icon('users', 11)}${formatOnline(viewers)} 看过</span>`);
    // 大航海自己占一行（`.chat-head-guard` 的 flex-basis 是 100%）：
    // 它是「舰长数」，和看过人数挤在一起时窄一点就只剩半截，另起一行反而清爽。
    const guardBit = guards > 0 ? `<span class="chat-head-guard">${icon('anchor', 11)}${guards} 大航海</span>` : '';
    $('chat-meta').innerHTML =
      `${platformBadge(session.platform)}<span>${detail.live ? '直播中' : '未开播'}</span>` +
      (dataBits.length ? `<span class="chat-head-data">${dataBits.join('<span class="sep">·</span>')}</span>` : '') +
      guardBit;
    document.title = `${detail.title || '直播间'} · Starveil`;
    if (cover) {
      $('stage-bg').style.backgroundImage = `url("${cover}")`;
    }
  }

  /// 定时刷新直播间数据（标题 / 人气 / 看过 / 大航海 / 是否在播）。
  /// 只重画头部，不碰播放器：`open_room` 用 `平台:房间号` 当 key，
  /// 重复调用只是把同一个会话的详情刷新一遍，正在播的流地址不受影响。
  async function refreshRoomInfo() {
    if (session.destroyed || document.hidden) return;
    try {
      const payload = await api.openRoom(session.platform, session.roomId);
      if (session.destroyed) return;
      session.detail = payload.detail;
      if (payload.qualities?.length) {
        session.qualities = payload.qualities;
        // 平台中途下架了高档清晰度时，别让下标指到空档上。
        session.qualityIndex = Math.min(session.qualityIndex, session.qualities.length - 1);
      }
      renderRoomHeader();
      setQualityLabel();
    } catch {
      /* 刷新失败就保持原样，下一轮再试 */
    }
  }

  function renderFollowState() {
    session.follow = isFollowing(session.platform, session.roomId);
    for (const button of [$('room-follow'), $('footer-follow'), $('chat-follow')]) {
      button.classList.toggle('active', session.follow);
    }
    const mark = session.follow ? 'followFilled' : 'follow';
    $('room-follow').innerHTML = `${icon(mark, 16)}<span class="label">${session.follow ? '已关注' : '关注'}</span>`;
    $('chat-follow').innerHTML = icon(mark, 17);
    $('chat-follow').title = session.follow ? '取消关注' : '关注';
    $('footer-follow').innerHTML = `${icon(mark, 17)}<span>${session.follow ? '已关注' : '关注'}</span>`;
  }

  async function onFollowClick() {
    if (!session.detail) return;
    const room = {
      platform: session.platform,
      room_id: session.roomId,
      title: session.detail.title,
      user_name: session.detail.user_name,
      avatar: session.detail.avatar,
      cover: session.detail.cover,
      online: session.detail.online,
      live: session.detail.live,
      area: session.detail.area,
      url: session.detail.url,
    };
    const following = toggleFollow(room);
    session.follow = following;
    renderFollowState();
    toast(following ? '已关注，主播开播时可以在关注页找到' : '已取消关注', following ? 'success' : 'info');
  }

  async function onTagClick() {
    if (!session.detail) return;
    if (!isFollowing(session.platform, session.roomId)) {
      toast('先关注主播，才能设置标签');
      return;
    }
    const tag = await promptDialog({ title: '设置标签', text: '给这个主播一个分组标签。', placeholder: '例如：游戏、歌势', value: '默认' });
    if (tag === null) return;
    const list = loadFollow();
    const index = list.findIndex((item) => item.platform === session.platform && item.room_id === session.roomId);
    if (index >= 0) {
      list[index].tag = tag || '默认';
      localStorage.setItem('simple-live.follow.v2', JSON.stringify(list));
      toast('标签已更新', 'success');
    }
  }

  /// 复制文本：后端已经不再弹终端，这里补上失败提示。
  async function copyText(text, successMessage) {
    try {
      await api.copyText(text);
      toast(successMessage, 'success');
    } catch (error) {
      toast(`复制失败：${error}`, 'error');
    }
  }

  /// 用默认浏览器打开链接，失败时给出提示。
  async function openExternal(url) {
    try {
      await api.openUrl(url);
    } catch (error) {
      toast(`打开失败：${error}`, 'error');
    }
  }

  function shareRoom() {
    copyText(session.detail?.url || roomUrl(session.platform, session.roomId), '直播间链接已复制');
  }

  function copyRoomLink() {
    copyText(session.detail?.url || roomUrl(session.platform, session.roomId), '直播间链接已复制');
  }

  /// 复制直播流：给的是本机代理地址（`http://127.0.0.1:端口/stream/...`）。
  /// 它带着当前平台的 Referer / UA，粘回「同屏播放」就能直接播；
  /// 反过来把原始 CDN 地址交出去，多半会被平台按 Referer 拒掉。
  ///
  /// 只播放音频时 `session.lines` 里是代理的 `-a` 那一条（没有视频 tag），
  /// 复制出去就是个没画面的流，所以这里重新要一份带视频的地址再复制。
  async function copyStream() {
    const current = session.lines[session.lineIndex]?.url;
    if (!current) {
      toast('还没有取到直播流地址');
      return;
    }
    if (!session.audioOnly) {
      copyText(current, '直播流地址已复制');
      return;
    }
    try {
      const payload = await api.play(session.key, session.qualityIndex, { audioOnly: false });
      copyText(payload?.urls?.[0] || current, '直播流地址已复制');
    } catch {
      copyText(current, '直播流地址已复制（只有声音）');
    }
  }

  /// 定时关闭在菜单上的文案：开关状态跟「设置 → 定时关闭」是同一份数据，
  /// 所以这里读的是 app.js 那套计时器的实时剩余量，不是另存一份。
  function sleepTimerItem() {
    const info = ctx.sleepTimer?.() || { enabled: false, minutes: 0, remaining: 0 };
    const minutes = Math.ceil(info.remaining / 60000);
    return {
      label: '定时关闭',
      icon: 'timer',
      value: info.enabled ? `${minutes} 分钟后退出` : '',
      active: info.enabled,
      onClick: () => showSleepTimerMenu(),
    };
  }

  function showSleepTimerMenu() {
    const anchor = $('room-more');
    const info = ctx.sleepTimer?.() || { enabled: false, minutes: 60, remaining: 0 };
    const remaining = Math.ceil(info.remaining / 60000);
    const items = [15, 30, 60, 120].map((minutes) => {
      const active = info.enabled && info.minutes === minutes;
      return {
        label: `${minutes} 分钟后关闭`,
        active,
        value: active ? `剩 ${remaining} 分钟` : '',
        onClick: () => applySleepTimer(minutes),
      };
    });
    if (info.enabled) {
      items.push({ separator: true });
      items.push({ label: '取消定时关闭', icon: 'close', onClick: () => applySleepTimer(0) });
    }
    items.push({ separator: true });
    items.push({ label: '与「设置 → 定时关闭」同步', icon: 'info' });
    openMenu(anchor, items, { align: 'end', placement: 'bottom' });
  }

  function applySleepTimer(minutes) {
    ctx.setSleepTimer?.(minutes);
    if (minutes > 0) {
      toast(`将在 ${minutes} 分钟后关闭应用`, 'info', 4000);
    } else {
      toast('已取消定时关闭');
    }
  }

  function showMoreMenu() {
    const anchor = $('room-more');
    const items = [];
    // 「更多」在两端都放全量入口：桌面控制条上虽然有画质/线路按钮，
    // 但手机上横屏/竖屏都可能被自动收起（见 applyControlDensity），
    // 这里必须始终能找到，不能只在竖屏出现。
    const quality = session.qualities[session.qualityIndex];
    items.push({
      label: '清晰度',
      icon: 'quality',
      value: quality || '',
      onClick: () => showQualityMenu(anchor, 'bottom'),
    });
    items.push({
      label: '线路',
      icon: 'route',
      value: session.lines.length ? `${session.lineIndex + 1} / ${session.lines.length}` : '未取到',
      onClick: () => showLineMenu(anchor, 'bottom'),
    });
    if (IS_MOBILE) {
      items.push({ label: '小窗播放', icon: 'screen', onClick: togglePip });
    }
    items.push({ separator: true });
    items.push(
      sleepTimerItem(),
      { separator: true },
      { label: '刷新直播流', icon: 'refresh', onClick: () => manualRefreshStream() },
      { label: '在浏览器打开', icon: 'link', onClick: () => openExternal(session.detail?.url || roomUrl(session.platform, session.roomId)) },
      { label: '复制直播流', icon: 'copy', onClick: copyStream },
      { label: '复制直播间链接', icon: 'copy', onClick: copyRoomLink },
      { separator: true },
      { label: '房间信息', icon: 'info', onClick: showRoomInfo },
      { label: '播放统计', icon: 'stats', onClick: showPlaybackStats },
    );
    openMenu(anchor, items);
  }

  /// 播放统计：清晰度 / 线路 / 分辨率 / 码率 / 帧率、缓冲与播放状态、已解码与丢帧。
  /// 每秒刷新一次，关闭弹窗或退出直播间都会清掉定时器。
  function showPlaybackStats() {
    const body = document.createElement('div');
    body.className = 'stats-body';
    const table = document.createElement('div');
    table.className = 'info-table';
    body.appendChild(table);

    /// 当前已缓冲到的位置比播放点靠后多少秒。
    function bufferedAhead() {
      let end = 0;
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= video.currentTime && video.currentTime <= video.buffered.end(index)) {
          end = Math.max(end, video.buffered.end(index));
        }
      }
      return Math.max(0, end - video.currentTime);
    }

    // 帧率只能靠「两次采样之间解码了多少帧」算：mpegts 只给累计帧数。
    let lastFrames = 0;
    let lastAt = 0;
    let fps = 0;

    function paint() {
      const quality = session.qualities[session.qualityIndex] || '未知';
      const lines = session.lines.length ? `线路 ${session.lineIndex + 1} / 共 ${session.lines.length} 条` : '未取到直播流';
      const resolution = video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : '未知';
      const playState = video.paused
        ? '已暂停'
        : video.readyState >= 3
          ? '播放中'
          : video.readyState >= 2
            ? '缓冲中'
            : '等待数据';
      const ahead = bufferedAhead();
      const qualityInfo = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
      const decoded = Number(qualityInfo?.totalVideoFrames) || 0;
      const dropped = Number(qualityInfo?.droppedVideoFrames) || 0;
      const intact = decoded > 0 ? `${(((decoded - dropped) / decoded) * 100).toFixed(2)}%` : '—';
      // mpegts 自己的统计：decodedFrames / droppedFrames 之外还有速度之类，
      // 字段随版本变化，这里把剩余的标量字段原样列出来。
      const stats = session.player?.statisticsInfo || {};
      // statisticsInfo.speed 是 KB/s；一秒采一次样，换算成 Mbps 更直观。
      const speedKb = Number(stats.speed) || 0;
      const bitrate = speedKb > 0 ? `${((speedKb * 8) / 1024).toFixed(2)} Mbps` : '—';
      const nowAt = performance.now();
      if (lastAt && nowAt > lastAt && decoded > lastFrames) {
        fps = ((decoded - lastFrames) * 1000) / (nowAt - lastAt);
      }
      lastFrames = decoded;
      lastAt = nowAt;
      const frameRate = fps > 0 ? `${fps.toFixed(1)} fps` : '—';
      const extra = Object.entries(stats)
        .filter(
          ([key, value]) =>
            !['playerType', 'decodedFrames', 'droppedFrames', 'speed'].includes(key) &&
            typeof value !== 'object',
        )
        .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><b>${escapeHtml(String(value))}</b></div>`)
        .join('');
      table.innerHTML = `
        <div><span>清晰度</span><b>${escapeHtml(quality)}</b></div>
        <div><span>线路</span><b>${escapeHtml(lines)}</b></div>
        <div><span>分辨率</span><b>${escapeHtml(resolution)}</b></div>
        <div><span>码率</span><b>${escapeHtml(bitrate)}</b></div>
        <div><span>帧率</span><b>${escapeHtml(frameRate)}</b></div>
        <div><span>播放状态</span><b>${escapeHtml(playState)}</b></div>
        <div><span>缓冲</span><b>${ahead.toFixed(1)} 秒</b></div>
        <div><span>已解码帧</span><b>${decoded}</b></div>
        <div><span>丢帧</span><b>${dropped}（完好率 ${intact}）</b></div>
        ${extra}`;
    }

    paint();
    clearInterval(session.statsTimer);
    session.statsTimer = setInterval(() => {
      if (session.destroyed) {
        clearInterval(session.statsTimer);
        session.statsTimer = 0;
        return;
      }
      paint();
    }, 1000);

    openModal({
      title: '播放统计',
      subtitle: '每秒刷新',
      width: 460,
      body,
      actions: [{ label: '关闭', kind: 'primary' }],
      onClose: () => {
        clearInterval(session.statsTimer);
        session.statsTimer = 0;
      },
    });
  }

  function showRoomInfo() {
    const detail = session.detail;
    if (!detail) return;
    // 竖屏下左下角的直播时长会被收起来，所以这里也补一行，信息不至于找不着。
    const startedAt = Number(detail.live_start_time) > 0 ? Number(detail.live_start_time) * 1000 : 0;
    const liveDuration = startedAt ? formatDuration(Date.now() - startedAt) : '未提供';
    openModal({
      title: '房间信息',
      width: 520,
      body: `
        <div class="info-table">
          <div><span>平台</span><b>${escapeHtml(PLATFORM_META[session.platform]?.name || session.platform)}</b></div>
          <div><span>房间号</span><b>${escapeHtml(session.roomId)}</b></div>
          <div><span>主播</span><b>${escapeHtml(detail.user_name || '')}</b></div>
          <div><span>分区</span><b>${escapeHtml(detail.area || '未提供')}</b></div>
          <div><span>人气</span><b>${formatOnline(detail.online)}</b></div>
          <div><span>状态</span><b>${detail.live ? '直播中' : '未开播'}</b></div>
          <div><span>已直播</span><b>${escapeHtml(liveDuration)}</b></div>
          <div><span>直播流</span><b>${session.lines.length} 条线路 / ${session.qualities.length} 档清晰度</b></div>
        </div>`,
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  }

  function openDanmakuSettingsModal() {
    const body = document.createElement('div');
    body.className = 'room-settings-modal';
    openModal({
      title: '弹幕与SC设置',
      subtitle: '弹幕 / 屏蔽 / SC',
      width: 420,
      body,
    });
    renderChatSettings(body);
  }

  /// 控制条上的齿轮：只放**直播间里独有**的设置。
  /// 刷新直播流 / 复制直播流 / 在浏览器打开 在上方「更多」里已经有入口，
  /// 弹幕开关就在紧邻的图标按钮上——重复的入口只是让人多找一次，去掉了。
  /// 「画面尺寸」是原来那个只会弹提示的「播放器设置」换来的：改铺满/适应不必离开直播间。
  function openQuickSettings() {
    openMenu($('ctrl-settings'), [
      {
        label: '弹幕与SC设置',
        icon: 'danmaku',
        onClick: () => {
          // 铺满状态（桌面全屏 / 安卓剧场）下聊天栏是隐藏的，切到聊天栏的「设置」标签
          // 用户什么也看不到——以前判的是 document.fullscreenElement，安卓上恒为 null，
          // 于是全屏里点这一项就是「没反应」。两种全屏都走弹窗。
          if (isPlayerFullscreen()) {
            openDanmakuSettingsModal();
          } else {
            setChatCollapsed(false);
            setChatTab('settings');
          }
        },
      },
      {
        label: '画面尺寸',
        icon: 'player',
        value: SCALE_MODES.find(([value]) => value === state.settings.player.scaleMode)?.[1] || '适应',
        onClick: showScaleMenu,
      },
      {
        label: '只播放音频',
        icon: 'volume',
        // 同屏时这一项没意义（A 本来就只有声音），但入口照样在，避免菜单随状态变长变短。
        value: session.audioOnlyUser ? '开启' : '关闭',
        active: session.audioOnlyUser,
        onClick: () => setAudioOnlyByUser(!session.audioOnlyUser),
      },
      {
        label: '延迟播放',
        icon: 'delay',
        value: Number(session.delaySec) > 0 ? `${Number(session.delaySec).toFixed(1)} 秒` : '关闭',
        onClick: openDelayPanel,
      },
      {
        label: '同屏播放',
        icon: 'dual',
        // B 的名字做值：一眼看出现在台前是谁，不用再点进去确认。
        value: dual.state.open ? shortDualTitle(dual.state.title) : '关闭',
        onClick: openDualPanel,
      },
    ], { align: 'end', placement: 'top' });
  }

  /// 菜单右侧的值只放得下几个字。
  function shortDualTitle(title) {
    const text = String(title || '已开启');
    return text.length > 8 ? `${text.slice(0, 8)}…` : text;
  }

  /// 画面尺寸：和设置页「播放 → 画面尺寸」写同一份配置，改完立刻作用于当前画面。
  function applyScaleMode(mode) {
    const fit = mode === 'cover' ? 'cover' : mode === 'fill' ? 'fill' : 'contain';
    video.style.objectFit = fit;
    // 同屏时台前是 B，两路共用同一个缩放方式，切档位才看不出差异。
    videoB.style.objectFit = fit;
  }

  function showScaleMenu() {
    const current = state.settings.player.scaleMode;
    openMenu(
      $('ctrl-settings'),
      SCALE_MODES.map(([value, label]) => ({
        label,
        active: current === value,
        onClick: () => {
          state.settings.player.scaleMode = value;
          saveSettings();
          applyScaleMode(value);
        },
      })),
      { align: 'end', placement: 'top' }
    );
  }

  // ------------------------------------------------------------ 只播放音频
  //
  // 这里不是「把画面藏起来继续解码」，而是真的不传视频：`api.play` 带上
  // audioOnly，代理层（src-tauri/src/flv.rs 的 AudioOnlyFilter）把视频 tag
  // 丢掉。省一半带宽，也不占解码器；代价是画面位置只剩一块黑，所以留了个
  // 能点回来的标记。

  /// 用户按下的那个开关，只对本次进房有效（退出直播间就恢复画面）。
  function setAudioOnlyByUser(on) {
    const next = Boolean(on);
    if (session.audioOnlyUser === next) return;
    session.audioOnlyUser = next;
    syncAudioOnly();
    if (dualPanelBody) renderDualPanel();
    toast(next ? '只播放音频，点画面上的标记可恢复' : '已恢复画面', 'info', 2000);
  }

  /// 合成本次进房「这一路到底要不要视频」，需要换代理分支时重取流。
  ///
  /// 只由用户那个开关决定：同屏时 A 也保留视频——小窗随时要出画面，
  /// 而且关掉小窗再开回来不用等重新取流。多占一路带宽是明确要的取舍。
  function syncAudioOnly() {
    const want = session.audioOnlyUser;
    // 开着「只播放音频」时小窗必然是一块黑，直接收掉。
    if (want && session.dualPip.on) {
      session.dualPip.on = false;
      applyDualLayout();
    }
    page.classList.toggle('is-audio-only', want && !dual.state.open);
    if (session.audioOnly === want) return;
    session.audioOnly = want;
    // 代理按 token 分两套地址（带视频 / 纯音频），换过去必须重新取一次流。
    if (session.key) refreshStream();
  }

  // ------------------------------------------------------------ 延迟播放
  //
  // 直播没有「慢放」，想比直播晚 N 秒看，只能让播放器先攒够 N 秒再开播：
  // 播放点落在缓冲里、离直播边缘 N 秒，这段就是抗抖动缓冲——网络抖一下只是
  // 把缓冲吃掉一截，画面不用停下来等。代价是刚打开要等 N 秒（有提示），
  // 而且画面比直播和弹幕慢。

  const DELAY_MAX = 20;
  // 同屏「时间偏移」的上限（秒），正负都取这个值。
  const DUAL_OFFSET_MAX = 20;

  function bufferedEnd() {
    const ranges = video.buffered;
    return ranges && ranges.length ? ranges.end(ranges.length - 1) : 0;
  }

  /// 当前播放点离「已经收到的最后一点数据」还有多少秒，也就是能扛多久抖动。
  ///
  /// 刚起播时 `currentTime` 可能还停在 0，而缓冲是从别的时间点开始的
  /// （MSE 的时间轴不一定从 0 起），这时按缓冲起点算，否则会算出一个巨大的
  /// 「已缓冲」而直接开播，延迟一点都攒不上。
  function bufferedAhead() {
    const ranges = video.buffered;
    if (!ranges || !ranges.length) return 0;
    const start = ranges.start(0);
    const end = ranges.end(ranges.length - 1);
    const now = video.currentTime < start ? start : video.currentTime;
    return Math.max(0, end - now);
  }

  function stopDelayGate() {
    clearInterval(session.delayTimer);
    session.delayTimer = 0;
    session.delayHolding = false;
  }

  /// 压住播放，等缓冲攒到 `target` 秒再放。
  ///
  /// 暂停期间 mpegts 照样往 SourceBuffer 里写，缓冲自己会长；所以这一步不需要
  /// 额外的缓冲队列，播完的位置天然就比直播晚了攒进去的那一段。
  function holdForDelay(target) {
    stopDelayGate();
    session.delayHolding = true;
    try {
      video.pause();
    } catch {
      /* 停不下来就继续等，下一轮还会再压一次 */
    }
    setHint({ spinner: true, text: `正在缓冲 ${target.toFixed(1)} 秒（延迟播放）…` });
    let lastEnd = -1;
    let lastGrow = Date.now();
    session.delayTimer = setInterval(() => {
      if (session.destroyed || !session.playerReady) {
        stopDelayGate();
        return;
      }
      const end = bufferedEnd();
      if (end > lastEnd + 0.01) {
        lastEnd = end;
        lastGrow = Date.now();
      } else if (Date.now() - lastGrow > 12000) {
        // 数据根本不来（断流/下播），别一直挂着「正在缓冲」骗人。
        stopDelayGate();
        setHint(null);
        return;
      }
      if (bufferedAhead() + 0.05 < target) return;
      stopDelayGate();
      setHint(null);
      playNow();
      watchDelay(target);
    }, 200);
  }

  /// 延迟是攒出来的，也会被卡顿一点点吃掉：掉到目标的一半就压回去补，
  /// 否则开着 20 秒、实际只剩 2 秒，用户还以为有缓冲垫着。
  function watchDelay(target) {
    stopDelayGate();
    session.delayTimer = setInterval(() => {
      if (session.destroyed) {
        stopDelayGate();
        return;
      }
      if (video.paused || video.ended) return;
      const ahead = bufferedAhead();
      if (ahead > 0.4 && ahead < target * 0.5) holdForDelay(target);
    }, 2000);
  }

  /// 改延迟：变大就压住补缓冲，变小就往前跳一段（直播没有快进，跳掉的就看不到了）。
  function applyDelay(next) {
    const target = Math.max(0, Math.min(DELAY_MAX, Math.round((Number(next) || 0) * 10) / 10));
    const previous = Number(session.delaySec) || 0;
    session.delaySec = target;
    if (!session.lines.length) {
      toast(`延迟 ${target.toFixed(1)} 秒，取到流后生效`, 'info', 2200);
      return;
    }
    if (target <= 0) {
      stopDelayGate();
      setHint(null);
      // 关掉延迟就是回到直播：缓冲里那一段不要了，直接跳到缓冲边上。
      const ahead = bufferedAhead();
      if (ahead > 1.2) seekInBuffer(video, ahead - 0.8);
      if (video.paused) playNow();
      toast('已关闭延迟播放', 'info', 1600);
      return;
    }
    if (target > previous + 0.05) {
      holdForDelay(target);
      toast(`延迟 ${target.toFixed(1)} 秒`, 'info', 1600);
      return;
    }
    if (target < previous - 0.05) {
      const ahead = bufferedAhead();
      if (ahead > target + 1) seekInBuffer(video, ahead - target);
      watchDelay(target);
      toast(`延迟 ${target.toFixed(1)} 秒`, 'info', 1600);
    }
  }

  let delayPanelBody = null;

  function openDelayPanel() {
    if (delayPanelBody) return;
    const body = document.createElement('div');
    body.className = 'dual-panel';
    delayPanelBody = body;
    openModal({
      title: '延迟播放',
      subtitle: '画面比直播慢一点，换来一段抗抖动缓冲',
      width: 470,
      body,
      onClose: () => {
        delayPanelBody = null;
      },
    });
    renderDelayPanel();
  }

  function renderDelayPanel() {
    const body = delayPanelBody;
    if (!body) return;
    const value = (Number(session.delaySec) || 0).toFixed(1);
    body.innerHTML = `
      <div class="dual-block">
        <div class="delay-stepper">
          <button class="btn small" data-step="-1" title="减 1 秒">-1</button>
          <button class="btn small" data-step="-0.1" title="减 0.1 秒">-0.1</button>
          <input class="dual-input dual-offset-input" id="delay-value" type="number"
            min="0" max="${DELAY_MAX}" step="0.1" value="${value}" />
          <span class="dual-unit">秒</span>
          <button class="btn small" data-step="0.1" title="加 0.1 秒">+0.1</button>
          <button class="btn small" data-step="1" title="加 1 秒">+1</button>
        </div>
        <p class="dual-tip">0 表示不延迟。设成 N 秒后，画面会比直播慢 N 秒，网络抖动先吃掉这 N 秒缓冲，不会立刻卡。</p>
      </div>
      <div class="dual-row">
        <button class="btn primary small" id="delay-apply">应用</button>
        <button class="btn small" id="delay-off">关闭延迟</button>
      </div>
      <p class="dual-note">延迟靠「先攒够再开播」实现，所以刚打开（或调大）时会先黑屏缓冲一会儿；调小会往前跳过一段画面——直播没有快进。只作用于本直播间，同屏的 B 不受影响。</p>`;
    bindDelayPanel();
  }

  function bindDelayPanel() {
    const body = delayPanelBody;
    if (!body) return;
    const input = body.querySelector('#delay-value');
    const clamp = () => {
      const next = Math.max(0, Math.min(DELAY_MAX, Math.round((Number(input.value) || 0) * 10) / 10));
      input.value = next.toFixed(1);
      return next;
    };
    for (const button of body.querySelectorAll('.delay-stepper button')) {
      button.addEventListener('click', () => {
        const next = (Number(input.value) || 0) + Number(button.dataset.step);
        input.value = Math.max(0, Math.min(DELAY_MAX, Math.round(next * 10) / 10)).toFixed(1);
      });
    }
    input?.addEventListener('blur', clamp);
    input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyDelay(clamp());
    });
    body.querySelector('#delay-apply')?.addEventListener('click', () => applyDelay(clamp()));
    body.querySelector('#delay-off')?.addEventListener('click', () => {
      input.value = '0.0';
      applyDelay(0);
    });
  }

  // ------------------------------------------------------------ 同屏播放
  //
  // 默认 B 铺满、A 缩成可拖动的小窗（点小窗和 B 换主次），两路各有一个音量。
  // 小窗可以关掉，只留 B 的画面 + A 的声音。
  //
  // A 这一路要不要视频由「只播放音频」那个开关单独决定：小窗开着必然要画面，
  // 所以开小窗时会把这个开关关掉。关掉小窗后 A 仍然保留视频流——切回来不用
  // 重新取流，代价是多占一路带宽（这是明确要的取舍）。

  let dualPanelBody = null;
  let lastDualError = '';

  function openDualPanel() {
    if (dualPanelBody) return;
    const body = document.createElement('div');
    body.className = 'dual-panel';
    dualPanelBody = body;
    openModal({
      title: '同屏播放',
      subtitle: 'B 出画面，A 出声音和小窗',
      width: 470,
      body,
      onClose: () => {
        dualPanelBody = null;
      },
    });
    renderDualPanel();
  }

  function dualTip() {
    const current = dual.state;
    if (current.error) return current.error;
    if (current.loading) return '正在载入 B…';
    if (current.open) {
      const name = PLATFORM_META[current.platform]?.name || '外部流';
      return `画面来自「${current.title || 'B'}」 · ${name}`;
    }
    return '填直播间链接、房间号，或者直接粘 .flv / .m3u8 地址。没载入成功不会改动当前直播间。';
  }

  function renderDualPanel() {
    const body = dualPanelBody;
    if (!body) return;
    const current = dual.state;
    const source = session.danmakuSource;
    const canUseB = Boolean(current.key && current.detail?.live);
    const offset = (Number(session.dualOffset) || 0).toFixed(1);
    // 滑块显示的就是实际音量：静音等价于 0，不再单列静音按钮。
    const volA = Math.round((video.muted ? 0 : video.volume) * 100);
    const volB = Math.round((videoB.muted ? 0 : videoB.volume) * 100);
    const pipOn = session.dualPip.on;
    body.innerHTML = `
      <div class="dual-block">
        <div class="dual-input-row">
          <input class="dual-input" id="dual-input" placeholder="直播间链接、房间号或流地址"
            value="${escapeHtml(session.dualInput || '')}" />
          <button class="btn primary small" id="dual-load"${current.loading ? ' disabled' : ''}>${current.open ? '切换' : '载入'}</button>
        </div>
        <p class="dual-tip${current.error ? ' is-error' : ''}">${escapeHtml(dualTip())}</p>
      </div>
      <div class="dual-block">
        <span class="dual-row-label">声音</span>
        <div class="dual-volumes">
          <div class="dual-volume">
            <span class="dual-vol-tag">A</span>
            <input type="range" class="dual-range" id="dual-vol-a" min="0" max="100" step="1"
              value="${volA}" aria-label="A 的音量" />
            <span class="dual-vol-num" id="dual-vol-a-num">${volA}</span>
          </div>
          <div class="dual-volume">
            <span class="dual-vol-tag">B</span>
            <input type="range" class="dual-range" id="dual-vol-b" min="0" max="100" step="1"
              value="${volB}" aria-label="B 的音量"${current.open ? '' : ' disabled'} />
            <span class="dual-vol-num" id="dual-vol-b-num">${current.open ? volB : '—'}</span>
          </div>
        </div>
        <span class="dual-row-hint">A 的音量就是底部控制条那个，B 是单独的</span>
      </div>
      <div class="dual-row">
        <span class="dual-row-label">A 小窗</span>
        <div class="dual-choices">
          <button class="dual-choice" data-pip="on" aria-pressed="${pipOn}"${current.open ? '' : ' disabled'}>开启</button>
          <button class="dual-choice" data-pip="off" aria-pressed="${!pipOn}"${current.open ? '' : ' disabled'}>关闭</button>
        </div>
        <span class="dual-row-hint">${
          current.open
            ? (session.dualFlip ? 'A 在主画面，B 在小窗' : '拖动可移动，点一下和主画面互换')
            : '载入 B 之后可用'
        }</span>
      </div>
      <div class="dual-row">
        <span class="dual-row-label">弹幕</span>
        <div class="dual-choices">
          <button class="dual-choice" data-source="a" aria-pressed="${source === 'a'}">只看 A</button>
          <button class="dual-choice" data-source="b" aria-pressed="${source === 'b'}"${canUseB ? '' : ' disabled'}>只看 B</button>
        </div>
        <span class="dual-row-hint">${canUseB ? '同一时刻只连一路，切换会重连' : 'B 没有可用的弹幕'}</span>
      </div>
      <div class="dual-block">
        <span class="dual-row-label">时间偏移</span>
        <div class="delay-stepper">
          <button class="btn small" data-offset-step="-1" title="减 1 秒">-1</button>
          <button class="btn small" data-offset-step="-0.1" title="减 0.1 秒">-0.1</button>
          <input class="dual-input dual-offset-input" id="dual-offset" type="number"
            min="${-DUAL_OFFSET_MAX}" max="${DUAL_OFFSET_MAX}" step="0.1" value="${offset}" />
          <span class="dual-unit">秒</span>
          <button class="btn small" data-offset-step="0.1" title="加 0.1 秒">+0.1</button>
          <button class="btn small" data-offset-step="1" title="加 1 秒">+1</button>
        </div>
        <div class="dual-row">
          <button class="btn small" id="dual-apply"${current.open ? '' : ' disabled'}>应用</button>
          <span class="dual-row-hint">正数 B 慢，负数 A 慢；只落在已缓冲的范围内，最多 ${DUAL_OFFSET_MAX} 秒</span>
        </div>
      </div>
      ${current.open ? '<button class="btn dual-close" id="dual-close">关闭同屏，恢复 A 的画面</button>' : ''}`;
    bindDualPanel();
  }

  function bindDualPanel() {
    const body = dualPanelBody;
    if (!body) return;
    const input = body.querySelector('#dual-input');
    input?.addEventListener('input', () => {
      session.dualInput = input.value;
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      loadDual();
    });
    body.querySelector('#dual-load')?.addEventListener('click', loadDual);
    // 音量滑块：A 直接改 video.volume（和底部控制条是同一个值），
    // B 走 dual.setVolume。拖到 0 就是静音，所以不再单列静音按钮。
    const volA = body.querySelector('#dual-vol-a');
    volA?.addEventListener('input', () => {
      const value = Number(volA.value) / 100;
      video.volume = value;
      video.muted = value === 0;
      if (value > 0) session.lastVolume = value;
      updateVolumeIcon();
      const num = body.querySelector('#dual-vol-a-num');
      if (num) num.textContent = String(Math.round(value * 100));
    });
    const volB = body.querySelector('#dual-vol-b');
    volB?.addEventListener('input', () => {
      const value = Number(volB.value) / 100;
      session.dualVolumeB = value;
      dual.setVolume(value);
      const num = body.querySelector('#dual-vol-b-num');
      if (num) num.textContent = String(Math.round(value * 100));
      // B 拖到 0 之后小窗还亮着会很奇怪，不用管画面，声音关掉就行。
    });
    for (const button of body.querySelectorAll('.dual-choice[data-pip]')) {
      button.addEventListener('click', () => setDualPip(button.dataset.pip === 'on'));
    }
    for (const button of body.querySelectorAll('.dual-choice[data-source]')) {
      button.addEventListener('click', () => switchDanmakuSource(button.dataset.source));
    }
    // 时间偏移：步进按钮 + 输入框，和「延迟播放」同一套控件。
    const offsetInput = body.querySelector('#dual-offset');
    const clampOffset = () => {
      const next = Math.max(
        -DUAL_OFFSET_MAX,
        Math.min(DUAL_OFFSET_MAX, Math.round((Number(offsetInput?.value) || 0) * 10) / 10)
      );
      if (offsetInput) offsetInput.value = next.toFixed(1);
      return next;
    };
    for (const button of body.querySelectorAll('[data-offset-step]')) {
      button.addEventListener('click', () => {
        const next = (Number(offsetInput?.value) || 0) + Number(button.dataset.offsetStep);
        if (offsetInput) {
          offsetInput.value = Math.max(
            -DUAL_OFFSET_MAX,
            Math.min(DUAL_OFFSET_MAX, Math.round(next * 10) / 10)
          ).toFixed(1);
        }
      });
    }
    offsetInput?.addEventListener('blur', clampOffset);
    offsetInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyDualOffset(clampOffset());
    });
    body.querySelector('#dual-apply')?.addEventListener('click', () => applyDualOffset(clampOffset()));
    body.querySelector('#dual-close')?.addEventListener('click', closeDual);
  }

  async function loadDual() {
    const value = String(session.dualInput || '').trim();
    if (!value) {
      toast('先填写 B 的链接或地址');
      return;
    }
    try {
      await dual.open(value, { currentPlatform: session.platform, muted: session.dualVolumeB <= 0 });
      if (session.destroyed) return;
      if (!dual.state.open) {
        renderDualPanel();
        return;
      }
      // 默认 B 铺满、A 缩成小窗。小窗要 A 的画面，先把「只播放音频」关掉。
      session.dualFlip = false;
      session.dualPip.on = true;
      ensureAHasVideo();
      applyDualLayout();
      // B 用自己那份音量，不跟随 A：两路同时出声时必须能分别调。
      dual.setVolume(session.dualVolumeB);
      session.dualOffset = 0;
      session.dualDelayA = 0;
      session.dualDelayB = 0;
      syncAudioOnly();
      renderDualPanel();
    } catch (error) {
      toast(`载入 B 失败：${error}`, 'error');
      renderDualPanel();
    }
  }

  function closeDual() {
    if (!dual.state.open) {
      renderDualPanel();
      return;
    }
    dual.close();
    session.dualFlip = false;
    applyDualLayout();
    session.dualOffset = 0;
    session.dualDelayA = 0;
    session.dualDelayB = 0;
    // 弹幕还在 B 那边时，先把连接交回 A，否则关掉后聊天栏就停住了。
    if (session.danmakuSource === 'b') switchDanmakuSource('a');
    // 关掉同屏能不能恢复画面，取决于「只播放音频」那个开关还在不在。
    syncAudioOnly();
    renderDualPanel();
  }

  /// 同屏布局：谁铺满、谁缩成小窗，全由 class 决定。
  ///
  /// 两路 video 都不移动 DOM——把正在播 MSE 的元素塞进别的父节点会掉源，
  /// 只能重新 load。所以「点小窗换主次」是纯样式操作。
  function applyDualLayout() {
    const active = dual.state.open;
    const pipOn = active && session.dualPip.on;
    page.classList.toggle('is-dual', active);
    const close = $('pip-close');
    if (close) close.hidden = !pipOn;
    for (const el of [video, videoB]) el.classList.remove('is-main', 'is-pip', 'is-hidden');
    if (!active) {
      clearPipStyle();
      return;
    }
    applyScaleMode(state.settings.player.scaleMode);
    // flip=true 是 A 主 B 小；默认反过来。
    const mainEl = session.dualFlip ? video : videoB;
    const pipEl = session.dualFlip ? videoB : video;
    // 换主次时上一个「小窗」身上还留着 inline 的宽高和 left/top，
    // 不清掉它就算挂上 is-main 也还是小尺寸（inline 优先级更高）。
    clearPipStyle();
    mainEl.classList.add('is-main');
    if (pipOn) {
      pipEl.classList.add('is-pip');
      positionDualPip();
    } else {
      pipEl.classList.add('is-hidden');
    }
  }

  /// 小窗的位置与大小。x/y 记的是左上角占舞台的百分比，窗口尺寸一变
  /// 会按比例落回原处；没拖过就是右下角。
  function pipBox() {
    const rect = stage.getBoundingClientRect();
    // 26% 宽在小窗口下会太窄，150px 兜底；上限 45%，别把主画面挡死。
    const width = Math.round(Math.min(Math.max(rect.width * 0.26, 150), rect.width * 0.45));
    const height = Math.round((width * 9) / 16);
    const maxX = Math.max(0, rect.width - width);
    const maxY = Math.max(0, rect.height - height);
    const x = session.dualPip.x == null
      ? Math.max(0, maxX - 12)
      : Math.min(Math.max(0, session.dualPip.x * rect.width), maxX);
    const y = session.dualPip.y == null
      ? Math.max(0, maxY - 12)
      : Math.min(Math.max(0, session.dualPip.y * rect.height), maxY);
    return { rect, width, height, x, y, maxX, maxY };
  }

  function positionDualPip() {
    if (!dual.state.open || !session.dualPip.on) return;
    const el = session.dualFlip ? videoB : video;
    const box = pipBox();
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    placePipClose(box.x, box.y, box.width);
  }

  /// 关闭按钮钉在小窗右上角。它是舞台的直接子元素（video 不能有子元素）。
  function placePipClose(x, y, width) {
    const close = $('pip-close');
    if (!close) return;
    close.style.left = `${x + width - 30}px`;
    close.style.top = `${y + 6}px`;
  }

  function clearPipStyle() {
    for (const el of [video, videoB]) {
      el.style.width = '';
      el.style.height = '';
      el.style.left = '';
      el.style.top = '';
    }
  }

  /// 点小窗 = 和主画面互换。
  function toggleDualFlip() {
    if (!dual.state.open) return;
    session.dualFlip = !session.dualFlip;
    applyDualLayout();
    renderDualPanel();
  }

  function setDualPip(on) {
    const next = Boolean(on);
    if (session.dualPip.on === next) return;
    session.dualPip.on = next;
    if (next) {
      // 重新打开小窗时回到「B 主 A 小」这个默认摆法。
      session.dualFlip = false;
      ensureAHasVideo();
    }
    applyDualLayout();
    renderDualPanel();
  }

  /// 小窗要真有画面，A 就不能是纯音频流：把这个开关关掉，重取带视频的地址。
  function ensureAHasVideo() {
    if (!session.audioOnlyUser) return;
    session.audioOnlyUser = false;
    syncAudioOnly();
    toast('A 的小窗需要画面，已关闭「只播放音频」', 'info', 2600);
  }

  /// 拖动 + 点击：位移小于 4px 当点击（换主次），否则记住新位置。
  ///
  /// 小窗上双击也是「切全屏」，所以单击互换要压 240ms 再执行：第二击落在
  /// 这个窗口里就把互换取消、改切全屏，全程不会先闪一下主次对调。
  function bindPipDrag(el) {
    let drag = null;
    let tapTimer = 0;
    let lastTapAt = 0;
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (!dual.state.open || !session.dualPip.on) return;
      // 只有当前小窗那一方可拖；主画面上的拖动留给控制条唤醒。
      if (el !== (session.dualFlip ? videoB : video)) return;
      const box = pipBox();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: box.x,
        top: box.y,
        box,
        moved: false,
      };
      el.classList.add('is-dragging');
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      event.preventDefault();
    });
    el.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const x = Math.min(Math.max(0, drag.left + dx), drag.box.maxX);
      const y = Math.min(Math.max(0, drag.top + dy), drag.box.maxY);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      placePipClose(x, y, drag.box.width);
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      const box = drag.box;
      drag = null;
      el.classList.remove('is-dragging');
      try {
        el.releasePointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      if (!moved) {
        const now = performance.now();
        if (now - lastTapAt < 320) {
          // 第二击：撤掉待定的互换，切全屏。
          lastTapAt = 0;
          clearTimeout(tapTimer);
          tapTimer = 0;
          toggleFullscreen();
          return;
        }
        lastTapAt = now;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          tapTimer = 0;
          toggleDualFlip();
        }, 240);
        return;
      }
      session.dualPip.x = (parseFloat(el.style.left) || 0) / (box.rect.width || 1);
      session.dualPip.y = (parseFloat(el.style.top) || 0) / (box.rect.height || 1);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => {
      if (!drag) return;
      drag = null;
      el.classList.remove('is-dragging');
    });
  }

  /// B 的状态变化：面板开着就重画；错误除了写面板，也弹一次（面板常常是关着的）。
  function renderDualState() {
    if (dualPanelBody) renderDualPanel();
    const error = dual.state.error;
    if (error && error !== lastDualError) {
      lastDualError = error;
      toast(error, 'error');
    }
    if (!error) lastDualError = '';
  }

  /// 换一路弹幕看。后端只有一个弹幕槽位，所以是「停掉旧的、连新的」。
  async function switchDanmakuSource(source) {
    const next = source === 'b' ? 'b' : 'a';
    if (next === session.danmakuSource) return;
    if (next === 'b' && !danmakuTarget('b')) {
      toast('B 没有可用的弹幕');
      return;
    }
    // 换一路等于换了个聊天频道：旧消息留着只会让人分不清是谁说的。
    session.messages = [];
    session.scMessages = [];
    cancelChatFlush();
    if (session.tab === 'chat' || session.tab === 'sc') renderChatTab();
    try {
      await api.stopDanmaku();
    } catch {
      /* 停不掉也没关系，start 会先把它停掉 */
    }
    await startDanmaku(next);
    renderDualPanel();
  }

  /// 时间偏移：正数让 B 慢，负数让 A 慢。
  ///
  /// 直播流只能落在已缓冲的范围内，所以按「与上次施加值的差」做相对 seek，
  /// 并把实际移动量记下来——缓冲不够时下次还能补上，不会越调越错。
  function applyDualOffset(next) {
    if (!dual.state.open) {
      toast('先载入 B');
      return;
    }
    const target = Math.max(
      -DUAL_OFFSET_MAX,
      Math.min(DUAL_OFFSET_MAX, Math.round((Number(next) || 0) * 10) / 10)
    );
    const wantA = target < 0 ? -target : 0;
    const wantB = target > 0 ? target : 0;
    // 差值为正 = 这一路要更慢 = 播放位置往后退；为负 = 追回一段。
    const deltaA = wantA - session.dualDelayA;
    const deltaB = wantB - session.dualDelayB;
    const movedA = deltaA ? seekInBuffer(video, -deltaA) : 0;
    const movedB = deltaB ? dual.seekBy(-deltaB) : 0;
    session.dualDelayA = Math.max(0, session.dualDelayA - movedA);
    session.dualDelayB = Math.max(0, session.dualDelayB - movedB);
    session.dualOffset = target;
    const achieved = Math.max(session.dualDelayA, session.dualDelayB);
    if (Math.abs(achieved - Math.abs(target)) > 0.8) {
      toast(`缓冲不够，只对齐到 ${achieved.toFixed(1)} 秒`, 'info', 3200);
    } else {
      toast(`已按 ${target.toFixed(1)} 秒对齐`, 'info', 1600);
    }
    renderDualPanel();
  }

  // ------------------------------------------------------------ 数据连接

  // ------------------------------------------------------------ 弹幕状态

  /// 把当前弹幕连接状态画成聊天栏顶部的一条横幅。
  ///
  /// 只画「未连上/连不上/不支持」这三种：连上之后继续占着一行纯属浪费地方，
  /// 但会短暂显示「已连接」给个反馈。任何平台都一样，不再只对抖音/快手说话。
  let statusHideTimer = 0;
  function renderDanmakuStatus() {
    const bar = $('chat-status');
    if (!bar) return;
    const status = session.danmakuStatus;
    if (!status) {
      bar.hidden = true;
      bar.className = 'chat-status';
      bar.replaceChildren();
      return;
    }
    const state = String(status.state || '');
    const reason = String(status.reason || '');
    bar.hidden = false;
    bar.className = `chat-status is-${state}`;
    bar.replaceChildren();

    const dot = document.createElement('span');
    dot.className = 'chat-status-dot';
    const text = document.createElement('span');
    text.className = 'chat-status-text';
    text.textContent = reason || '弹幕连接状态未知';
    bar.append(dot, text);

    if (state === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'chat-status-action';
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        session.danmakuStatus = { state: 'connecting', reason: '正在重新连接弹幕服务器…' };
        renderDanmakuStatus();
        startDanmaku();
      });
      bar.appendChild(retry);
    } else if (state === 'unsupported') {
      // 平台不支持时给个出口，别让用户对着空白聊天框猜。
      const open = document.createElement('button');
      open.className = 'chat-status-action';
      open.textContent = '看网页弹幕';
      open.addEventListener('click', () => openExternal(session.detail?.url || roomUrl(session.platform, session.roomId)));
      bar.appendChild(open);
    }

    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = 0;
    }
    if (state === 'connected') {
      statusHideTimer = setTimeout(() => {
        if (session.destroyed || session.danmakuStatus?.state !== 'connected') return;
        bar.hidden = true;
      }, 4000);
    }
    // 横幅会自己收起，占位文案得接住「已连接」这个状态，
    // 否则没人发弹幕时聊天栏永远写着「正在连接弹幕服务器…」。
    refreshChatPlaceholder();
  }

  /// 抖音需要先算握手签名，其余平台直接连。
  async function prepareDanmakuSignature(platform, detail) {
    if (platform !== 'douyin') return {};
    // RoomExtra 是枚举，序列化出来是 `{ Douyin: { room_id } }`；
    // 顺手兼容一次「已经摊平」的形状，免得两边改来改去对不上。
    const extra = detail?.extra || {};
    const roomInnerId = extra?.Douyin?.room_id || extra?.room_id || '';
    if (!roomInnerId) {
      // 未开播的抖音房间往往还没下发 19 位房间号，签名算不出来。
      throw new Error('没拿到抖音房间号（未开播时连不了弹幕），开播后重进试试');
    }
    const { signature, userId } = await signDouyinDanmaku(roomInnerId);
    return { signature, userId };
  }

  /// 当前弹幕该连哪一路。同屏时 B 也要能连，所以 key / 平台 / 详情都从这里取。
  function danmakuTarget(source) {
    if (source === 'b') {
      const other = dual.state;
      if (!other.open || !other.key) return null;
      return { key: other.key, platform: other.platform, detail: other.detail };
    }
    if (!session.key) return null;
    return { key: session.key, platform: session.platform, detail: session.detail };
  }

  /// `source` 为 'a' / 'b'：后端只有一个弹幕槽位，同一时刻只连一路，
  /// 切换就是把上一路停掉、用另一路重连（"只看 A / 只看 B"）。
  async function startDanmaku(source = session.danmakuSource) {
    session.danmakuSource = source === 'b' ? 'b' : 'a';
    const target = danmakuTarget(session.danmakuSource);
    if (!target) {
      session.danmakuStatus = { state: 'failed', reason: 'B 没有可用的弹幕连接' };
      renderDanmakuStatus();
      return;
    }
    session.danmakuStatus = { state: 'connecting', reason: '正在连接弹幕服务器…' };
    renderDanmakuStatus();
    // 重试时会再进这里：先把上一轮的监听摘掉，否则每重试一次就多一份监听。
    if (typeof state.unlistenDanmaku === 'function') state.unlistenDanmaku();
    if (typeof state.unlistenDanmakuStatus === 'function') state.unlistenDanmakuStatus();
    state.unlistenDanmaku = null;
    state.unlistenDanmakuStatus = null;
    // 先挂监听再去连：后端的「不支持 / 连接失败」几乎是立刻推出来的，
    // 等 startDanmaku 返回再挂就只能看到「正在连接」卡在那儿。
    const unlistenStatus = await api.onDanmakuStatus((status) => {
      if (session.destroyed) return;
      session.danmakuStatus = { state: String(status?.state || ''), reason: String(status?.reason || '') };
      renderDanmakuStatus();
    });
    const unlisten = await api.onDanmaku((message) => {
      if (!session.destroyed) pushMessage(message);
    });
    if (session.destroyed) {
      unlisten?.();
      unlistenStatus?.();
      return;
    }
    state.unlistenDanmaku = unlisten;
    state.unlistenDanmakuStatus = unlistenStatus;
    try {
      const options = await prepareDanmakuSignature(target.platform, target.detail);
      if (session.destroyed) return;
      await api.startDanmaku(target.key, options);
      // 状态由后端推事件驱动，这里不再自己往聊天记录里塞「连接正常」——
      // 那句提示对不支持的平台是假的，会把真实原因挡在后面。
    } catch (error) {
      if (session.destroyed) return;
      session.danmakuStatus = { state: 'failed', reason: `弹幕连接失败：${error}` };
      renderDanmakuStatus();
    }
  }

  async function boot() {
    session.scSweep = setInterval(purgeExpiredSc, 1000);
    video.addEventListener('timeupdate', purgeExpiredSc);
    // 恢复上次记住的聊天栏宽度，并挂上拖拽手柄。
    restoreChatWidth();
    setupChatResizer();
    // 拿不到开播时间时，用“本次进入房间的时间”算已观看时长，至少不是一片空白。
    session.playStartedAt = Date.now();
    initDanmaku();
    setHint({ spinner: true, text: '正在读取直播间…' });
    applyDanmakuStyle();
    setDanmakuEnabled(session.danmakuEnabled);
    setQualityLabel();
    // 定时刷新直播间数据（标题 / 人气 / 看过 / 大航海）。
    // 这些数字在平台侧一直在变，进房时抓一次就再也不动，看久了会明显对不上。
    session.infoTimer = setInterval(refreshRoomInfo, REFRESH_INFO_INTERVAL);
    try {
      const payload = await api.openRoom(platform, roomId);
      if (session.destroyed) return;
      session.key = payload.key;
      session.detail = payload.detail;
      session.qualities = payload.qualities || [];
      const detailPlatform = normalizePlatform(payload.detail.platform || platform);
      session.platform = detailPlatform;
      const remembered = Number(localStorage.getItem(`${QUALITY_KEY}${detailPlatform}`));
      // 虎牙 4K/20M 对带宽要求高，首次进入默认选蓝光4M，避免一上来就频繁缓冲。
      const huyaDefault = session.qualities.findIndex((name) => name.includes('4M'));
      const defaultQuality = pickDefaultQuality(detailPlatform, huyaDefault);
      session.qualityIndex =
        state.settings.player.rememberQuality &&
        Number.isInteger(remembered) &&
        remembered >= 0 &&
        remembered < session.qualities.length
          ? remembered
          : defaultQuality;
      state.platform = detailPlatform;
      renderRoomHeader();
      // 未登录时平台会限制最高画质；进入房间明确提示一次。
      if (!loadLogin(detailPlatform)?.cookie) {
        if (detailPlatform === 'bilibili') {
          toast('B 站未登录，无法开启最高画质', 'info', 5000);
        } else if (detailPlatform === 'douyu') {
          toast('斗鱼未登录，最高画质仅可体验 10 分钟', 'info', 5000);
        }
      }
      renderFollowState();
      recordHistory({ ...payload.detail, platform: detailPlatform });
      touchFollowVisit(detailPlatform, session.roomId);
      setChatTab('chat');
      setQualityLabel();
      // 弹幕流和直播流是两条独立连接：**先连弹幕，再去取流**。
      // 以前弹幕挂在取流成功之后，于是没开播 / 没取到流源的房间永远不连弹幕——
      // 明明有人发弹幕，聊天栏却一直空着。这里不等它返回，两件事并行做。
      startDanmaku();
      if (!payload.detail.live || !session.qualities.length) {
        // 未开播也要保留房间头、关注/取关和主播信息，只是不取流。
        $('ctrl-quality').disabled = true;
        $('ctrl-line').disabled = true;
        setHint({
          // 弹幕有没有连上，聊天栏顶部与占位文案会说得更准（各平台情况不同），
          // 这里只交代直播流的事，别抢那句话。
          text: payload.detail.live ? '当前没有可用的直播流' : '主播当前未开播，开播后可以刷新进入',
          actions: '<button class="btn primary" id="hint-reopen">刷新房间</button>',
        });
        hint.querySelector('#hint-reopen')?.addEventListener('click', () => {
          ctx.openRoom(session.platform, session.roomId);
        });
        updateClock();
        return;
      }
      await refreshStream();
      if (state.settings.player.muteOnStart) {
        video.muted = true;
        updateVolumeIcon();
      }
      if (state.settings.player.autoFullscreen) {
        setTimeout(toggleFullscreen, 300);
      }
      updateClock();
      session.clockTimer = setInterval(updateClock, 1000);
      // 不再按固定间隔重取流：那会在地址还没过期时主动销毁播放器，表现为“看一会儿断一下”。
      // 地址真的过期时画面会停住，下面的卡顿检测会在 6 秒内换线或重取流。
      // 虎牙部分线路会静默卡住，画面 currentTime 不再推进；
      // 6 秒没有进展就换线/重取流，而不是等用户手动刷新。
      session.lastProgressTime = video.currentTime;
      session.lastProgressAt = Date.now();
      session.stallTimer = setInterval(() => {
        if (session.destroyed || session.streamDead || video.paused || video.readyState < 2) return;
        const now = Date.now();
        // 延迟兜底。标准/流畅档位关掉了 liveBufferLatencyChasing，任何一次卡顿（窗口被切走、
        // 网络抖一下、解码跟不上）都会让播放点永久落后：之后收到的数据只会继续
        // 往后 append，播放点按 1 倍速再也追不回来，延迟和缓冲一起膨胀到几分钟，
        // 内存与 appendBuffer 压力反过来让小卡更多——就是「越看越卡、最后重连」。
        // 低延迟档位库自己会追帧，这里只是兜底：只在落后超过 30 秒时跳一次回到最新位置，
        // 日常小抖动不参与，避免频繁跳帧（也免得把「延迟播放」设的那几秒跳掉）。
        const bufferedEnd = video.buffered.length
          ? video.buffered.end(video.buffered.length - 1)
          : 0;
        if (bufferedEnd - video.currentTime > 30) {
          const target = Math.max(0, bufferedEnd - 2);
          video.currentTime = target;
          session.lastProgressTime = target;
          session.lastProgressAt = now;
          return;
        }
        if (Math.abs(video.currentTime - session.lastProgressTime) > 0.4) {
          session.lastProgressTime = video.currentTime;
          session.lastProgressAt = now;
          // 画面在动了，说明流是好的，把「连续失败」计数清掉。
          session.stallRetries = 0;
          return;
        }
        if (now - session.lastProgressAt < 6000) return;
        session.lastProgressAt = now;
        if (!state.settings.player.autoRefresh) {
          setHint({ text: '直播流已停止，可以刷新继续观看', actions: '<button class="btn primary" id="hint-retry">刷新</button>' });
          bindHintActions();
          return;
        }
        // 连续几次重连都没有进展，多半是主播下播了（画面会永久停住）。
        // 再自动重试下去只会每隔几秒弹一次 toast，停掉循环、把选择权交回用户。
        // 弹幕是另一条连接，不受影响，这里不碰它。
        session.stallRetries += 1;
        if (session.stallRetries > 3) {
          session.stallRetries = 0;
          session.streamDead = true;
          // 弹幕是另一条连接，直播流停了不代表它停了——按实际状态说话，不要瞎猜。
          const danmakuAlive = session.danmakuStatus?.state === 'connected';
          setHint({
            text: danmakuAlive
              ? '直播流已停止（主播可能已下播），弹幕仍在接收；稍后可以刷新重试'
              : '直播流已停止（主播可能已下播），稍后可以刷新重试',
            actions: '<button class="btn primary" id="hint-retry">刷新</button>',
          });
          bindHintActions();
          return;
        }
        // 优先换线；线路用尽后重取流。两种情况都不需要用户操作。
        if (session.lines.length > 1 && session.lineFailures < session.lines.length) {
          session.lineFailures += 1;
          toast('直播流卡顿，正在切换线路…');
          playLine((session.lineIndex + 1) % session.lines.length);
        } else {
          session.lineFailures = 0;
          toast('直播流卡顿，正在重新连接…');
          refreshStream();
        }
      }, 3000);
      wake();
    } catch (error) {
      if (session.destroyed) return;
      session.failed = true;
      setHint({
        text: `打不开这个直播间：${error}`,
        actions: '<button class="btn" id="hint-back">返回</button><button class="btn" id="hint-browser">在浏览器打开</button><button class="btn primary" id="hint-retry">重试</button>',
      });
      hint.querySelector('#hint-back')?.addEventListener('click', () => ctx.back());
      bindHintActions();
      $('room-title').textContent = '打开失败';
    }
  }

  // ------------------------------------------------------------ 键盘

  const onKeyDown = (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Escape') {
      // 桌面全屏交给浏览器自己处理 Esc（它会退出 Fullscreen API）。
      if (document.fullscreenElement) return;
      event.preventDefault();
      // 安卓剧场模式没有浏览器那一层，Esc（外接键盘）自己退全屏，别一把退出直播间。
      if (page.classList.contains('is-theater')) {
        setTheater(false);
        return;
      }
      ctx.exitRoom();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
    if (event.key === 'd' || event.key === 'D') {
      event.preventDefault();
      setDanmakuEnabled(!session.danmakuEnabled);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      video.volume = Math.min(1, video.volume + 0.05);
      video.muted = false;
      updateVolumeIcon();
      wake();
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      video.volume = Math.max(0, video.volume - 0.05);
      updateVolumeIcon();
      wake();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  const onFullscreenChange = () => {
    const active = Boolean(document.fullscreenElement);
    page.classList.toggle('is-fullscreen', active);
    $('ctrl-fullscreen').innerHTML = icon(active ? 'fullscreenExit' : 'fullscreen', 21);
    $('room-back').title = active ? '退出全屏' : '返回';
    if (!active) page.classList.remove('ui-idle');
    wake();
    if (active) {
      setTimeout(() => {
        if (document.fullscreenElement && !document.querySelector('.menu-overlay:not(.closing)')) {
          page.classList.add('ui-idle');
        }
      }, 3000);
    }
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  video.volume = 0.8;
  applyScaleMode(state.settings.player.scaleMode);
  updateVolumeIcon();
  updatePlayIcon();
  // 控制条要等真正有了宽度才能量出放不放得下：插进 DOM 后按 rAF 量一次，
  // 之后横竖屏切换、窗口缩放都重量一次。
  const onControlResize = () => applyControlDensity();
  window.addEventListener('resize', onControlResize);
  portraitQuery.addEventListener?.('change', onControlResize);
  // 安卓返回键退全屏（app.js 的 handleAndroidBack 统一处理按键，这里只负责收布局）。
  const onExitTheater = () => {
    if (page.classList.contains('is-theater')) setTheater(false);
  };
  window.addEventListener('simple-live:exit-theater', onExitTheater);
  document.getElementById('view').appendChild(page);
  // 插进 DOM、量得到宽度之后再把主色条摆到「聊天」下面。
  syncChatTabUnderline();
  requestAnimationFrame(onControlResize);
  boot();

  return () => {
    session.destroyed = true;
    // 退出直播间前把最后一段时长落盘，这也是「关窗即退出」时唯一可靠的结算点。
    stopWatchClock();
    clearInterval(session.watchTimer);
    window.removeEventListener('pagehide', flushWatchOnHide);
    document.removeEventListener('visibilitychange', resumeWatchOnShow);
    // 聊天标签色条的尺寸监听也要跟着房间一起撤掉，否则每进出一次就叠一对监听。
    window.removeEventListener('resize', onChatUnderlineResize);
    window.removeEventListener('orientationchange', onChatUnderlineResize);
    chatTabsObserver?.disconnect();
    clearTimeout(chatUnderlineTimer);
    clearTimeout(session.idleTimer);
    clearInterval(session.clockTimer);
    clearInterval(session.statsTimer);
    clearInterval(session.infoTimer);
    clearInterval(session.stallTimer);
    clearTimeout(session.renewTimer);
    for (const timer of session.scTimers.values()) clearTimeout(timer);
    session.scTimers.clear();
    clearInterval(session.scSweep);
    if (session.pipWatch) {
      clearInterval(session.pipWatch);
      session.pipWatch = 0;
    }
    document.documentElement.classList.remove('is-pip');
    page.classList.remove('is-pip');
    danmaku?.destroy();
    cancelChatFlush();
    session.resizerCleanup?.();
    session.resizerCleanup = null;
    video.removeEventListener('timeupdate', purgeExpiredSc);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onVolumeOutside, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    window.removeEventListener('resize', onControlResize);
    portraitQuery.removeEventListener?.('change', onControlResize);
    window.removeEventListener('simple-live:exit-theater', onExitTheater);
    if (typeof state.unlistenDanmaku === 'function') state.unlistenDanmaku();
    state.unlistenDanmaku = null;
    if (typeof state.unlistenDanmakuStatus === 'function') state.unlistenDanmakuStatus();
    state.unlistenDanmakuStatus = null;
    if (statusHideTimer) {
      clearTimeout(statusHideTimer);
      statusHideTimer = 0;
    }
    api.stopDanmaku().catch(() => {});
    destroyPlayer();
    // 同屏的 B 路是另一套播放器，得单独收掉，否则退出直播间后它还在后台拉流。
    dual.destroy();
    session.pipObserver?.disconnect();
    session.pipObserver = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // 安卓的「全屏」是自己拼的，离开直播间必须还原：否则系统栏一直是隐藏的、
    // 屏幕还锁在横屏，回到列表页会非常别扭。
    if (document.documentElement.classList.contains('is-theater')) {
      document.documentElement.classList.remove('is-theater');
      api.setImmersive(false).catch(() => {});
      api.setScreenOrientation(state.settings.appearance?.orientation || 'auto').catch(() => {});
    }
    document.title = 'Starveil';
    state.room = null;
  };
}

function platformBadge(platform) {
  return `<span class="platform-badge">${platformIcon(platform, 15)}</span>`;
}
