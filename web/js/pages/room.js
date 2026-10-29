// 直播间：mpegts 播放、滚动弹幕、聊天面板、清晰度/线路、全屏。
import { api, canonicalImage, formatOnline, normalizePlatform, roomUrl } from '../api.js';
import { createDanmakuLayer, FPS_OPTIONS, flyBarrageAvailable, PERF_OPTIONS } from '../danmaku.js';
import { signDouyinDanmaku } from '../douyin-sign.js';
import { icon, PLATFORM_META, platformIcon } from '../icons.js';
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
            <button class="overlay-btn follow-btn" id="room-follow">${icon('heart', 16)}<span class="label">关注</span></button>
            <button class="overlay-btn icon-only" id="room-share" title="分享">${icon('share', 18)}</button>
            <button class="overlay-btn icon-only" id="room-more" title="更多">${icon('more', 18)}</button>
          </div>
        </div>
        <div class="player-controls" id="player-controls">
          <div class="volume-wrap">
            <button class="ctrl" id="ctrl-volume" title="静音">${icon('volume', 21)}</button>
            <input type="range" id="volume-range" min="0" max="100" value="80" />
          </div>
          <span class="clock" id="player-clock">--:--:--</span>
          <span class="ctrl-spacer"></span>
          <button class="ctrl-text" id="ctrl-quality">原画 ${icon('chevronUp', 13)}</button>
          <button class="ctrl-text" id="ctrl-line">线路 1 ${icon('chevronUp', 13)}</button>
          <button class="ctrl" id="ctrl-danmaku" title="弹幕开关">${icon('danmaku', 21)}</button>
          <button class="ctrl" id="ctrl-settings" title="弹幕与播放设置">${icon('settings', 20)}</button>
          <button class="ctrl" id="ctrl-pip" title="画中画">${icon('screen', 20)}</button>
          <button class="ctrl" id="ctrl-fullscreen" title="全屏（F / 双击画面）">${icon('fullscreen', 21)}</button>
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
            <button class="icon-btn" id="chat-follow" title="关注">${icon('heart', 17)}</button>
            <button class="icon-btn" id="chat-collapse" title="收起聊天区">${icon('chevron', 17)}</button>
          </div>
        </div>
        <div class="chat-tabs" id="chat-tabs">
          <button class="chat-tab active" data-tab="chat">聊天</button>
          <button class="chat-tab" data-tab="sc">SC<em id="sc-count">0</em></button>
          <button class="chat-tab" data-tab="follow">关注</button>
          <button class="chat-tab" data-tab="settings">设置</button>
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
      <button class="footer-action" id="footer-follow">${icon('heart', 17)}<span>关注</span></button>
      <button class="footer-action" id="footer-tag">${icon('tag', 17)}<span>标签</span></button>
      <div class="footer-right">
        <button class="footer-action" id="footer-share">${icon('share', 17)}<span>分享</span></button>
        <button class="footer-action" id="footer-copy-link">${icon('link', 17)}<span>复制链接</span></button>
        <span class="footer-divider"></span>
        <button class="footer-action" id="footer-copy-stream">${icon('copy', 17)}<span>复制直播流</span></button>
      </div>
    </footer>
    <button class="chat-expand hidden" id="chat-expand" title="展开聊天区">${icon('back', 18)}</button>`;

  const $ = (id) => page.querySelector(`#${id}`);
  const stage = $('stage');
  const video = $('player');
  const layer = $('danmaku-layer');
  const hint = $('stage-hint');
  const clock = $('player-clock');
  const volumeRange = $('volume-range');
  const playerControls = $('player-controls');
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
    danmakuEnabled: state.settings.danmaku.enabled !== false,
    follow: false,
    playerReady: false,
    lastUiWake: 0,
    lastVolume: 0.8,
    reconnectAttempts: 0,
    lineFailures: 0,
    // 直播流「一直没有进展」时连续自动重试的次数。主播下播后画面会永久停住，
    // 不设上限的话卡顿检测会每隔几秒重取一次流、弹一次 toast，永远停不下来。
    stallRetries: 0,
    // 自动重连已经放弃（下播/流彻底没了）。用户手动刷新时清掉。
    streamDead: false,
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
  };
  state.room = session;

  // ------------------------------------------------------------ 基础 UI

  // 从直播间进入另一个直播间时，返回应该回到一级界面，而不是回到上一个直播间。
  $('room-back').addEventListener('click', () => ctx.exitRoom());
  $('ctrl-volume').addEventListener('click', toggleMute);
  volumeRange.addEventListener('input', () => {
    video.volume = Number(volumeRange.value) / 100;
    video.muted = video.volume === 0;
    session.lastVolume = video.volume || 0.8;
    updateVolumeIcon();
  });
  $('ctrl-quality').addEventListener('click', showQualityMenu);
  $('ctrl-line').addEventListener('click', showLineMenu);
  $('ctrl-danmaku').addEventListener('click', () => setDanmakuEnabled(!session.danmakuEnabled));
  $('ctrl-settings').addEventListener('click', openQuickSettings);
  $('ctrl-fullscreen').addEventListener('click', toggleFullscreen);
  $('ctrl-pip').addEventListener('click', togglePip);
  $('room-follow').addEventListener('click', onFollowClick);
  $('footer-follow').addEventListener('click', onFollowClick);
  $('chat-follow').addEventListener('click', onFollowClick);
  $('footer-tag').addEventListener('click', onTagClick);
  $('room-share').addEventListener('click', shareRoom);
  $('footer-share').addEventListener('click', shareRoom);
  $('footer-copy-link').addEventListener('click', copyRoomLink);
  $('footer-copy-stream').addEventListener('click', copyStream);
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
  chatToBottom.addEventListener('click', () => scrollChatToBottom(true));
  composer.addEventListener('submit', submitDanmaku);
  updateComposer();
  const stageEvents = ['mousemove', 'mousedown', 'touchstart', 'wheel'];
  const wake = () => {
    page.classList.remove('ui-idle');
    clearTimeout(session.idleTimer);
    if (session.destroyed) return;
    session.idleTimer = setTimeout(() => {
      // 全屏时聊天栏已隐藏，即使视频正在缓冲也要让顶部浮层自动隐藏。
      const canHide = document.fullscreenElement || (!video.paused && !session.chatCollapsed);
      if (canHide && !document.querySelector('.menu-overlay')) {
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
    danmaku?.update(config);
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
    if (session.tab === 'sc') renderChatTab();
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
    const entry = {
      user: message.user || '',
      // 不要写成 `message.text || ''`：数字 0 之类的假值会被吞掉。
      text: message.text == null ? '' : String(message.text),
      color: message.color,
      system: Boolean(message.system),
      position: Number(message.position) || 0,
      sc: message.sc || null,
      // 表情弹幕的图片信息要一路带到弹幕层与聊天栏，漏掉这里表情就只剩占位文字。
      emoticons: Array.isArray(message.emoticons) && message.emoticons.length ? message.emoticons : undefined,
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
      if (session.tab === 'sc') renderChatTab();
    }
    if (!entry.system && !entry.sc) spawnDanmaku(entry);
    if (session.tab === 'chat') appendChatLine(entry);
  }

  // 正则里的特殊字符要转义：表情 key 自带 `[` `]`，不转义会被当成字符组。
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function chatEmojiImage(key, url) {
    const image = document.createElement('img');
    image.className = 'chat-emoji';
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
    const urlByKey = new Map();
    for (const emoticon of list || []) {
      const key = typeof emoticon?.key === 'string' ? emoticon.key : '';
      const url = typeof emoticon?.url === 'string' ? emoticon.url : '';
      if (key && url && !urlByKey.has(key)) urlByKey.set(key, url);
    }
    if (!urlByKey.size) {
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
    const keys = [...urlByKey.keys()].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      if (at > cursor) node.appendChild(document.createTextNode(text.slice(cursor, at)));
      node.appendChild(chatEmojiImage(match[0], urlByKey.get(match[0])));
      cursor = at + match[0].length;
    }
    if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  }

  function appendChatLine(message) {
    const empty = chatList.querySelector('.chat-placeholder');
    if (empty) empty.remove();
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
    const pinned = chatGapToBottom() < CHAT_PIN_GAP;
    chatList.appendChild(line);
    while (chatList.childElementCount > 320) chatList.firstElementChild?.remove();
    if (pinned) chatList.scrollTop = chatList.scrollHeight;
    updateChatToBottom();
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
        chatList.appendChild(placeholder(all.length ? '关注的主播都还没开播' : '你还没有关注其他主播', 'heart'));
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
    wrap.innerHTML = `
      <div class="chat-settings-group">
        <h4>弹幕设置</h4>
        <div class="chat-setting-row"><span>弹幕开关</span><button class="switch" id="cs-enabled" aria-checked="${session.danmakuEnabled}"></button></div>
        <div class="chat-setting-row"><span>弹幕表情</span><button class="switch" id="cs-emoji" aria-checked="${config.emoji !== false}"></button></div>
        <div class="chat-setting-row"><span>不透明度</span><input type="range" id="cs-opacity" min="20" max="100" step="5" value="${config.opacity}" /><em>${config.opacity}%</em></div>
        <div class="chat-setting-row"><span>显示区域</span><input type="range" id="cs-area" min="15" max="100" step="5" value="${config.area}" /><em>${config.area}%</em></div>
        <div class="chat-setting-row"><span>显示行数</span><input type="number" class="chat-setting-input" id="cs-lines" min="1" max="30" step="1" value="${config.lines}" /><em></em></div>
        <div class="chat-setting-row"><span>字体大小</span><input type="number" class="chat-setting-input" id="cs-font" min="12" max="40" step="1" value="${config.font}" /><em>px</em></div>
        <div class="chat-setting-row"><span>字体粗细</span><select class="chat-setting-select" id="cs-weight">
          ${[[300, '极细'], [400, '很细'], [500, '正常'], [600, '小粗'], [700, '偏粗'], [800, '很粗'], [900, '极粗']].map(([value, label]) => `<option value="${value}"${Number(config.weight) === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div class="chat-setting-row"><span>滚动速度</span><input type="range" id="cs-speed" min="3" max="20" step="1" value="${config.speed}" /><em>${config.speed}s</em></div>
        <div class="chat-setting-row"><span>弹幕描边</span><button class="switch" id="cs-stroke" aria-checked="${config.stroke}"></button></div>
        <div class="chat-setting-row"><span>描边宽度</span><input type="number" class="chat-setting-input" id="cs-stroke-width" min="0" max="5" step="0.5" value="${config.strokeWidth}" /><em>px</em></div>
        <div class="chat-setting-row"><span>顶部边距</span><input type="number" class="chat-setting-input" id="cs-safe-top" min="0" max="60" step="1" value="${config.safeTop}" /><em>px</em></div>
        <div class="chat-setting-row"><span>底部边距</span><input type="number" class="chat-setting-input" id="cs-safe-bottom" min="0" max="60" step="1" value="${config.safeBottom}" /><em>px</em></div>
        <div class="chat-setting-row"><span>性能档位</span><select class="chat-setting-select" id="cs-perf">
          ${PERF_OPTIONS.map((option) => `<option value="${option.value}"${config.perf === option.value ? ' selected' : ''}>${option.label}</option>`).join('')}
        </select></div>
        <div class="chat-setting-row"><span>帧率上限</span><select class="chat-setting-select" id="cs-fps">
          ${FPS_OPTIONS.map((option) => `<option value="${option.value}"${Number(config.fps) === option.value ? ' selected' : ''}>${option.label}</option>`).join('')}
        </select></div>
      </div>
      <div class="chat-settings-group">
        <h4>屏蔽设置</h4>
        <div class="chat-setting-row"><span>启用屏蔽</span><button class="switch" id="cs-block" aria-checked="${config.block}"></button></div>
        <label class="chat-setting-field"><span>关键词屏蔽</span><textarea class="chat-setting-textarea" id="cs-block-keywords" placeholder="每行一个关键词">${escapeHtml(config.blockKeywords || '')}</textarea></label>
        <label class="chat-setting-field"><span>用户屏蔽</span><textarea class="chat-setting-textarea" id="cs-block-users" placeholder="每行一个用户名">${escapeHtml(config.blockUsers || '')}</textarea></label>
        <div class="chat-setting-row"><span>重复过滤</span><button class="switch" id="cs-dedupe" aria-checked="${config.dedupe}"></button></div>
        <div class="chat-setting-row"><span>过滤模式</span><select class="chat-setting-select" id="cs-dedupe-mode">
          ${[['content', '按内容'], ['user', '按用户'], ['strict', '刷屏严格']].map(([value, label]) => `<option value="${value}"${config.dedupeMode === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div class="chat-setting-row"><span>过滤窗口</span><input type="number" class="chat-setting-input" id="cs-dedupe-window" min="1" max="60" step="1" value="${config.dedupeWindow}" /><em>秒</em></div>
        <div class="chat-setting-row"><span>过滤步长</span><input type="number" class="chat-setting-input" id="cs-dedupe-step" min="1" max="10" step="1" value="${config.dedupeStep}" /><em></em></div>
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
    const bindRange = (id, key, format) => {
      const input = wrap.querySelector(`#${id}`);
      const label = input.nextElementSibling;
      input.addEventListener('input', () => {
        const value = Number(input.value);
        setConfig(key, value);
        label.textContent = format(value);
      });
    };
    const bindNumber = (id, key, min, max) => {
      const input = wrap.querySelector(`#${id}`);
      input.addEventListener('change', () => {
        let value = Number(input.value);
        if (!Number.isFinite(value)) value = min;
        value = Math.min(max, Math.max(min, value));
        input.value = String(value);
        setConfig(key, value);
      });
    };
    const bindSelect = (id, key, numeric = false) => {
      const select = wrap.querySelector(`#${id}`);
      select.addEventListener('change', () => setConfig(key, numeric ? Number(select.value) : select.value));
    };
    const bindTextarea = (id, key) => {
      const area = wrap.querySelector(`#${id}`);
      area.addEventListener('input', () => setConfig(key, area.value));
    };

    bindSwitch('cs-enabled', 'enabled');
    bindSwitch('cs-emoji', 'emoji');
    bindRange('cs-opacity', 'opacity', (value) => `${value}%`);
    bindRange('cs-area', 'area', (value) => `${value}%`);
    bindNumber('cs-lines', 'lines', 1, 30);
    bindNumber('cs-font', 'font', 12, 40);
    bindSelect('cs-weight', 'weight', true);
    bindRange('cs-speed', 'speed', (value) => `${value}s`);
    bindSwitch('cs-stroke', 'stroke');
    bindNumber('cs-stroke-width', 'strokeWidth', 0, 5);
    bindNumber('cs-safe-top', 'safeTop', 0, 60);
    bindNumber('cs-safe-bottom', 'safeBottom', 0, 60);
    bindSelect('cs-perf', 'perf');
    bindSelect('cs-fps', 'fps', true);
    bindSwitch('cs-block', 'block');
    bindTextarea('cs-block-keywords', 'blockKeywords');
    bindTextarea('cs-block-users', 'blockUsers');
    bindSwitch('cs-dedupe', 'dedupe');
    bindSelect('cs-dedupe-mode', 'dedupeMode');
    bindNumber('cs-dedupe-window', 'dedupeWindow', 1, 60);
    bindNumber('cs-dedupe-step', 'dedupeStep', 1, 10);
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
    updateComposer();
  }

  // 发送弹幕的输入框默认隐藏（设置 → 弹幕设置 → 允许发送弹幕），
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
    $('ctrl-quality').innerHTML = `${escapeHtml(quality || '清晰度')} ${icon('chevronUp', 13)}`;
    $('ctrl-line').innerHTML = `线路 ${session.lineIndex + 1}${suffix} ${icon('chevronUp', 13)}`;
  }

  function showQualityMenu() {
    if (!session.qualities.length) return;
    openMenu($('ctrl-quality'), session.qualities.map((name, index) => ({
      label: name,
      active: index === session.qualityIndex,
      onClick: () => selectQuality(index),
    })), { align: 'end', placement: 'top' });
  }

  function showLineMenu() {
    if (session.lines.length <= 1) {
      toast('当前只有一条线路');
      return;
    }
    openMenu($('ctrl-line'), session.lines.map((line, index) => ({
      label: line.protocol === 'hls' ? `线路 ${index + 1} · HLS` : `线路 ${index + 1}`,
      value: line.url.includes('127.0.0.1') ? '' : shortHost(line.url),
      active: index === session.lineIndex,
      onClick: () => playLine(index),
    })), { align: 'end', placement: 'top' });
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

  function destroyPlayer() {
    // 换线/重连会先把旧播放器拆掉，这里先结算这一段观看时长。
    stopWatchClock();
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
  function onLineError(detail) {
    if (session.destroyed) return;
    if (state.settings.player.autoSwitchLine && session.lineIndex + 1 < session.lines.length) {
      toast('当前线路播放失败，正在切换线路…');
      setTimeout(() => playLine(session.lineIndex + 1), 300);
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
    if (Hls && Hls.isSupported()) {
      try {
        const hls = new Hls({
          // 直播只保留最近几个分片：窗口越小，延迟越不容易越积越大。
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 8,
          maxBufferLength: 20,
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
        resumePlayback();
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
  function resumePlayback() {
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
        // 虎牙/斗鱼 CDN 抖动较多，保留 1MB 初始缓冲，不做激进的延迟追帧，
        // 否则网络稍抖就会触发 seek，表现为断断续续。
        enableStashBuffer: true,
        stashInitialSize: 1024,
        autoCleanupSourceBuffer: true,
        // 库默认向后保留 120~180 秒。直播用不到这么长的历史，一旦播放点落后，
        // 这段数据只会白占内存、并拖慢每次 appendBuffer，所以收紧到 30~60 秒。
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
        liveBufferLatencyChasing: false,
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
      const payload = await api.play(session.key, session.qualityIndex);
      if (session.destroyed) return;
      session.lines = buildLines(payload);
      session.headers = payload.headers || [];
      session.lineIndex = 0;
      session.lineFailures = 0;
      setQualityLabel();
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

  function updatePlayIcon() {
    page.classList.toggle('is-paused', video.paused);
  }

  async function toggleFullscreen() {
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
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      toast('当前画面不支持画中画');
    }
  }

  video.addEventListener('playing', () => {
    setHint(null);
    updatePlayIcon();
    session.failed = false;
    session.playStartedAt = Date.now();
    session.lastProgressTime = video.currentTime;
    session.lastProgressAt = Date.now();
    // 真正出画了才开始计观看时长。
    startWatchClock();
    setTimeout(() => {
      if (!session.destroyed && !video.paused && video.currentTime > 3) session.reconnectAttempts = 0;
    }, 5000);
  });
  video.addEventListener('ended', () => {
    if (session.destroyed) return;
    // 流断了就不该继续累计时长，重连上会由 playing 重新开始计时。
    stopWatchClock();
    // 有些线路第一次会返回一个只有几百毫秒的失效分片，自动重取一次。
    if (session.reconnectAttempts < 2) {
      session.reconnectAttempts += 1;
      setHint({ spinner: true, text: '直播流意外结束，正在重新连接…' });
      setTimeout(() => refreshStream(), 700);
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
  video.addEventListener('click', wake);
  video.addEventListener('dblclick', toggleFullscreen);

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
    if (guards > 0) dataBits.push(`<span class="guard">${icon('spark', 11)}${guards} 大航海</span>`);
    $('chat-meta').innerHTML =
      `${platformBadge(session.platform)}<span>${detail.live ? '直播中' : '未开播'}</span>` +
      (dataBits.length ? `<span class="chat-head-data">${dataBits.join('<span class="sep">·</span>')}</span>` : '');
    document.title = `${detail.title || '直播间'} · 星幕直播`;
    if (cover) {
      $('stage-bg').style.backgroundImage = `url("${cover}")`;
    }
  }

  function renderFollowState() {
    session.follow = isFollowing(session.platform, session.roomId);
    for (const button of [$('room-follow'), $('footer-follow'), $('chat-follow')]) {
      button.classList.toggle('active', session.follow);
    }
    const heart = session.follow ? 'heartFilled' : 'heart';
    $('room-follow').innerHTML = `${icon(heart, 16)}<span class="label">${session.follow ? '已关注' : '关注'}</span>`;
    $('chat-follow').innerHTML = icon(heart, 17);
    $('chat-follow').title = session.follow ? '取消关注' : '关注';
    $('footer-follow').innerHTML = `${icon(heart, 17)}<span>${session.follow ? '已关注' : '关注'}</span>`;
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

  function copyStream() {
    const url = session.lines[session.lineIndex]?.url;
    if (!url) {
      toast('还没有取到直播流地址');
      return;
    }
    copyText(url, '直播流地址已复制');
  }

  function showMoreMenu() {
    openMenu($('room-more'), [
      { label: '刷新直播流', icon: 'refresh', onClick: () => manualRefreshStream() },
      { label: '在浏览器打开', icon: 'link', onClick: () => openExternal(session.detail?.url || roomUrl(session.platform, session.roomId)) },
      { label: '复制直播流', icon: 'copy', onClick: copyStream },
      { label: '复制直播间链接', icon: 'copy', onClick: copyRoomLink },
      { separator: true },
      { label: '房间信息', icon: 'info', onClick: showRoomInfo },
      { label: '播放统计', icon: 'signal', onClick: showPlaybackStats },
    ]);
  }

  /// 播放统计：清晰度 / 线路 / 分辨率、缓冲与播放状态、已解码与丢帧。
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
      const extra = Object.entries(stats)
        .filter(([key, value]) => !['playerType', 'decodedFrames', 'droppedFrames'].includes(key) && typeof value !== 'object')
        .map(([key, value]) => `<div><span>${escapeHtml(key)}</span><b>${escapeHtml(String(value))}</b></div>`)
        .join('');
      table.innerHTML = `
        <div><span>清晰度</span><b>${escapeHtml(quality)}</b></div>
        <div><span>线路</span><b>${escapeHtml(lines)}</b></div>
        <div><span>分辨率</span><b>${escapeHtml(resolution)}</b></div>
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
          <div><span>直播流</span><b>${session.lines.length} 条线路 / ${session.qualities.length} 档清晰度</b></div>
        </div>`,
      actions: [{ label: '关闭', kind: 'primary' }],
    });
  }

  function openDanmakuSettingsModal() {
    const body = document.createElement('div');
    body.className = 'room-settings-modal';
    openModal({
      title: '直播设置',
      subtitle: '弹幕设置 / 屏蔽设置',
      width: 420,
      body,
    });
    renderChatSettings(body);
  }

  function openQuickSettings() {
    openMenu($('ctrl-settings'), [
      { label: '弹幕开关', icon: 'danmaku', active: session.danmakuEnabled, onClick: () => setDanmakuEnabled(!session.danmakuEnabled) },
      {
        label: '弹幕设置',
        icon: 'text',
        onClick: () => {
          if (document.fullscreenElement) {
            openDanmakuSettingsModal();
          } else {
            setChatCollapsed(false);
            setChatTab('settings');
          }
        },
      },
      { label: '播放器设置', icon: 'player', onClick: () => toast('完整播放设置请到 设置 → 播放页设置') },
      { label: '刷新直播流', icon: 'refresh', onClick: () => manualRefreshStream() },
      { separator: true },
      { label: '复制直播流', icon: 'copy', onClick: copyStream },
      { label: '打开网页版', icon: 'link', onClick: () => openExternal(session.detail?.url || roomUrl(session.platform, session.roomId)) },
    ], { align: 'end', placement: 'top' });
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
  async function prepareDanmakuSignature() {
    if (session.platform !== 'douyin') return {};
    // RoomExtra 是枚举，序列化出来是 `{ Douyin: { room_id } }`；
    // 顺手兼容一次「已经摊平」的形状，免得两边改来改去对不上。
    const extra = session.detail?.extra || {};
    const roomInnerId = extra?.Douyin?.room_id || extra?.room_id || '';
    if (!roomInnerId) {
      // 未开播的抖音房间往往还没下发 19 位房间号，签名算不出来。
      throw new Error('没拿到抖音房间号（未开播时连不了弹幕），开播后重进试试');
    }
    const { signature, userId } = await signDouyinDanmaku(roomInnerId);
    return { signature, userId };
  }

  async function startDanmaku() {
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
      const options = await prepareDanmakuSignature();
      if (session.destroyed) return;
      await api.startDanmaku(session.key, options);
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
      const defaultQuality = detailPlatform === 'huya' && huyaDefault >= 0 ? huyaDefault : 0;
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
        // 延迟兜底。关掉 liveBufferLatencyChasing 后，任何一次卡顿（窗口被切走、
        // 网络抖一下、解码跟不上）都会让播放点永久落后：之后收到的数据只会继续
        // 往后 append，播放点按 1 倍速再也追不回来，延迟和缓冲一起膨胀到几分钟，
        // 内存与 appendBuffer 压力反过来让小卡更多——就是「越看越卡、最后重连」。
        // 只在落后超过 30 秒时跳一次回到最新位置，日常小抖动不参与，避免频繁跳帧。
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
      const friendly = String(error).includes('斗鱼')
        ? '斗鱼的取流签名脚本暂时不可用，当前版本先支持哔哩哔哩和虎牙的播放。可以先用浏览器观看这个房间。'
        : `打不开这个直播间：${error}`;
      setHint({
        text: friendly,
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
      if (document.fullscreenElement) return;
      if (page.querySelector('.stage-menu')) return;
      event.preventDefault();
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
    if (!active) page.classList.remove('ui-idle');
    wake();
    if (active) {
      setTimeout(() => {
        if (document.fullscreenElement && !document.querySelector('.menu-overlay')) {
          page.classList.add('ui-idle');
        }
      }, 3000);
    }
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  video.volume = 0.8;
  video.style.objectFit = state.settings.player.scaleMode === 'cover' ? 'cover' : state.settings.player.scaleMode === 'fill' ? 'fill' : 'contain';
  updateVolumeIcon();
  updatePlayIcon();
  document.getElementById('view').appendChild(page);
  boot();

  return () => {
    session.destroyed = true;
    // 退出直播间前把最后一段时长落盘，这也是「关窗即退出」时唯一可靠的结算点。
    stopWatchClock();
    clearInterval(session.watchTimer);
    window.removeEventListener('pagehide', flushWatchOnHide);
    document.removeEventListener('visibilitychange', resumeWatchOnShow);
    clearTimeout(session.idleTimer);
    clearInterval(session.clockTimer);
    clearInterval(session.statsTimer);
    clearInterval(session.stallTimer);
    for (const timer of session.scTimers.values()) clearTimeout(timer);
    session.scTimers.clear();
    clearInterval(session.scSweep);
    danmaku?.destroy();
    session.resizerCleanup?.();
    session.resizerCleanup = null;
    video.removeEventListener('timeupdate', purgeExpiredSc);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
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
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.title = '星幕直播';
    state.room = null;
  };
}

function platformBadge(platform) {
  return `<span class="platform-badge">${platformIcon(platform, 15)}</span>`;
}
