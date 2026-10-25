// 直播间：mpegts 播放、滚动弹幕、聊天面板、清晰度/线路、全屏。
import { api, canonicalImage, formatOnline, normalizePlatform, roomUrl } from '../api.js';
import { createDanmakuLayer, flyBarrageAvailable } from '../danmaku.js';
import { icon, PLATFORM_META, platformIcon } from '../icons.js';
import {
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
        <div class="chat-list" id="chat-list"></div>
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

  const session = {
    platform,
    roomId,
    key: '',
    detail: null,
    qualities: [],
    qualityIndex: 0,
    urls: [],
    headers: [],
    lineIndex: 0,
    player: null,
    messages: [],
    tab: 'chat',
    chatCollapsed: false,
    loading: true,
    failed: false,
    idleTimer: 0,
    clockTimer: 0,
    refreshTimer: 0,
    scMessages: [],
    scHistory: [],
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
    playStartedAt: 0,
    stallTimer: 0,
    lastProgressTime: 0,
    lastProgressAt: 0,
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
  $('footer-refresh').addEventListener('click', () => refreshStream());
  $('room-more').addEventListener('click', showMoreMenu);
  $('chat-collapse').addEventListener('click', () => setChatCollapsed(true));
  $('chat-expand').addEventListener('click', () => setChatCollapsed(false));
  $('chat-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.chat-tab')?.dataset.tab;
    if (!tab) return;
    setChatTab(tab);
  });
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
    danmaku = createDanmakuLayer(layer, video);
    danmaku.update(state.settings.danmaku);
    danmaku.setEnabled(session.danmakuEnabled);
  }

  function applyDanmakuStyle() {
    const config = state.settings.danmaku;
    // 顶部/底部安全边距交给容器留白，库只负责在剩余区域内排轨道。
    // 顶部至少让开房间标题浮层（约 64px），否则弹幕会压在标题和主播信息上。
    const HEADER_INSET = 64;
    layer.style.top = `${Math.max(Number(config.safeTop) || 0, HEADER_INSET)}px`;
    layer.style.bottom = `${Number(config.safeBottom) || 0}px`;
    danmaku?.update(config);
  }

  function setDanmakuEnabled(enabled) {
    session.danmakuEnabled = enabled;
    state.settings.danmaku.enabled = enabled;
    saveSettings();
    $('ctrl-danmaku').classList.toggle('active', enabled);
    danmaku?.setEnabled(enabled);
    if (session.tab === 'chat' || session.tab === 'sc') renderChatTab();
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
    // 库内部不回收已下屏的弹幕实例，长时间观看要定期重建，避免内存一直涨。
    if (danmaku.sent > danmaku.limit) danmaku.reset();
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
      text: message.text || '',
      color: message.color,
      system: Boolean(message.system),
      position: Number(message.position) || 0,
      sc: message.sc || null,
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
        text.textContent = message.text;
        line.append(tag, who, text);
      } else {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `${message.user}：`;
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = message.text;
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
    const pinned = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
    chatList.appendChild(line);
    while (chatList.childElementCount > 320) chatList.firstElementChild?.remove();
    if (pinned) chatList.scrollTop = chatList.scrollHeight;
  }

  function scSectionTitle(text) {
    const title = document.createElement('div');
    title.className = 'sc-section-title';
    title.textContent = text;
    return title;
  }

  function placeholder(text, iconName = 'danmaku') {
    const box = document.createElement('div');
    box.className = 'chat-placeholder';
    box.innerHTML = `${icon(iconName, 26)}<div>${escapeHtml(text)}</div>`;
    return box;
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
    chatList.innerHTML = '';
    if (session.tab === 'chat') {
      if (!session.messages.length) {
        chatList.appendChild(placeholder('正在连接弹幕服务器…', 'danmaku'));
        return;
      }
      for (const message of session.messages) appendChatLine(message);
      chatList.scrollTop = chatList.scrollHeight;
      return;
    }
    if (session.tab === 'sc') {
      // 分两块：正在显示的 SC（可删除）与历史 SC（删除/过期后归档，带结束时间）。
      if (!session.scMessages.length && !session.scHistory.length) {
        chatList.appendChild(placeholder('当前直播还没有醒目留言（SC）', 'spark'));
        return;
      }
      if (session.scMessages.length) {
        chatList.appendChild(scSectionTitle(`正在显示 · ${session.scMessages.length}`));
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
      }
      if (session.scHistory.length) {
        chatList.appendChild(scSectionTitle(`历史 SC · ${session.scHistory.length}`));
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
      }
      bindImageFallback(chatList);
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
      <div class="chat-setting-tip">修改会立即保存并作用于当前弹幕；弹幕轨道会按实际位置避让，不再叠字。</div>`;
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

  function resetDanmakuSurface() {
    danmaku?.clear();
  }

  function setConfig(key, value) {
    state.settings.danmaku[key] = value;
    if (key === 'enabled') {
      session.danmakuEnabled = Boolean(value);
      $('ctrl-danmaku').classList.toggle('active', session.danmakuEnabled);
      if (!session.danmakuEnabled) danmaku?.setEnabled(false);
    }
    saveSettings();
    if (key === 'speed') danmaku?.update(state.settings.danmaku, { relayout: false });
    // 字号/行数/区域变化后旧弹幕的 top 已经失效，清屏重新排轨，避免和新轨道叠字。
    if (['lines', 'font', 'area', 'safeTop', 'safeBottom'].includes(key)) {
      resetDanmakuSurface();
    }
    if (['opacity', 'lines', 'area', 'font', 'weight', 'stroke', 'strokeWidth', 'safeTop', 'safeBottom'].includes(key)) {
      applyDanmakuStyle();
    }
  }

  function setChatTab(tab) {
    session.tab = tab;
    for (const button of page.querySelectorAll('.chat-tab')) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }
    renderChatTab();
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
    $('ctrl-quality').innerHTML = `${escapeHtml(quality || '清晰度')} ${icon('chevronUp', 13)}`;
    $('ctrl-line').innerHTML = `线路 ${session.lineIndex + 1} ${icon('chevronUp', 13)}`;
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
    if (session.urls.length <= 1) {
      toast('当前只有一条线路');
      return;
    }
    openMenu($('ctrl-line'), session.urls.map((url, index) => ({
      label: `线路 ${index + 1}`,
      value: url.includes('127.0.0.1') ? '' : shortHost(url),
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
    if (session.player) {
      try {
        session.player.pause();
        session.player.unload();
        session.player.detachMediaElement();
        session.player.destroy();
      } catch {
        /* 忽略销毁异常 */
      }
      session.player = null;
    }
    session.playerReady = false;
  }

  function playLine(index) {
    const url = session.urls[index];
    if (!url) {
      setHint({ text: '没有可用的播放地址', actions: '<button class="btn" id="hint-retry">重试</button>' });
      bindHintActions();
      return;
    }
    session.lineIndex = index;
    setQualityLabel();
    danmaku?.reset();
    setHint({ spinner: true, text: '正在连接视频流…' });
    destroyPlayer();
    if (!window.mpegts || !mpegts.isSupported()) {
      setHint({ text: '当前 WebView 不支持 FLV（MSE）播放' });
      return;
    }
    const source = { type: 'flv', url, isLive: true, cors: true };
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
        liveBufferLatencyChasing: false,
        fixAudioTimestampGap: true,
      });
      player.attachMediaElement(video);
      player.on(mpegts.Events.ERROR, (_type, detail) => {
        console.error('mpegts error', _type, detail);
        if (session.destroyed) return;
        if (state.settings.player.autoSwitchLine && session.lineIndex + 1 < session.urls.length) {
          toast('当前线路播放失败，正在切换线路…');
          setTimeout(() => playLine(session.lineIndex + 1), 300);
          return;
        }
        setHint({
          text: `播放失败：${detail || '无法连接视频流'}`,
          actions: '<button class="btn" id="hint-switch">换线</button><button class="btn primary" id="hint-retry">重试</button>',
        });
        bindHintActions();
      });
      player.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (!session.destroyed && video.paused) setHint({ text: '直播流已结束，可以尝试刷新', actions: '<button class="btn primary" id="hint-retry">刷新</button>' });
        bindHintActions();
      });
      player.load();
      session.player = player;
      session.playerReady = true;
      const promise = video.play();
      if (promise?.catch) promise.catch(() => {
        if (!session.destroyed) {
          // 自动播放被拦截时静音兜底，不再弹“点击画面开始播放”的遮挡提示。
          video.muted = true;
          video.play().catch(() => {});
        }
      });
    } catch (error) {
      setHint({ text: `创建播放器失败：${error}`, actions: '<button class="btn primary" id="hint-retry">重试</button>' });
      bindHintActions();
    }
  }

  function bindHintActions() {
    hint.querySelector('#hint-retry')?.addEventListener('click', () => refreshStream());
    hint.querySelector('#hint-switch')?.addEventListener('click', () => {
      if (session.urls.length > 1) playLine((session.lineIndex + 1) % session.urls.length);
      else toast('当前没有其他线路');
    });
    hint.querySelector('#hint-browser')?.addEventListener('click', () => {
      api.openUrl(session.detail?.url || roomUrl(session.platform, session.roomId));
    });
    hint.querySelector('#hint-back-home')?.addEventListener('click', () => ctx.go('home'));
  }

  async function refreshStream(resetQuality = false) {
    if (!session.key) return;
    setHint({ spinner: true, text: '正在获取播放地址…' });
    try {
      const payload = await api.play(session.key, session.qualityIndex);
      if (session.destroyed) return;
      session.urls = payload.urls || [];
      session.headers = payload.headers || [];
      session.lineIndex = 0;
      session.lineFailures = 0;
      setQualityLabel();
      if (!session.urls.length) {
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
    setTimeout(() => {
      if (!session.destroyed && !video.paused && video.currentTime > 3) session.reconnectAttempts = 0;
    }, 5000);
  });
  video.addEventListener('ended', () => {
    if (session.destroyed) return;
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
  });
  video.addEventListener('volumechange', updateVolumeIcon);
  video.addEventListener('error', () => {
    if (session.destroyed) return;
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
    // 聊天区不再显示人气（热度）；B 站有真实在线人数时单独显示人数。
    const viewers = Number(detail.viewers) || 0;
    const viewerText = viewers > 0 ? `<span>·</span><span class="online">${icon('users', 11)}${formatOnline(viewers)} 人在看</span>` : '';
    $('chat-meta').innerHTML = `${platformBadge(session.platform)}<span>${detail.live ? '直播中' : '未开播'}</span>${viewerText}`;
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

  function shareRoom() {
    api.copyText(session.detail?.url || roomUrl(session.platform, session.roomId)).then(() => toast('直播间链接已复制', 'success'));
  }

  function copyRoomLink() {
    api.copyText(session.detail?.url || roomUrl(session.platform, session.roomId)).then(() => toast('直播间链接已复制', 'success'));
  }

  function copyStream() {
    const url = session.urls[session.lineIndex];
    if (!url) {
      toast('还没有取到直播流地址');
      return;
    }
    api.copyText(url).then(() => toast('直播流地址已复制', 'success'));
  }

  function showMoreMenu() {
    openMenu($('room-more'), [
      { label: '刷新直播流', icon: 'refresh', onClick: () => refreshStream() },
      { label: '在浏览器打开', icon: 'link', onClick: () => api.openUrl(session.detail?.url || roomUrl(session.platform, session.roomId)) },
      { label: '复制直播流', icon: 'copy', onClick: copyStream },
      { label: '复制直播间链接', icon: 'copy', onClick: copyRoomLink },
      { separator: true },
      { label: '房间信息', icon: 'info', onClick: showRoomInfo },
      { label: '播放统计' },
    ]);
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
          <div><span>直播流</span><b>${session.urls.length} 条线路 / ${session.qualities.length} 档清晰度</b></div>
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
      { label: '刷新直播流', icon: 'refresh', onClick: () => refreshStream() },
      { separator: true },
      { label: '复制直播流', icon: 'copy', onClick: copyStream },
      { label: '打开网页版', icon: 'link', onClick: () => api.openUrl(session.detail?.url || roomUrl(session.platform, session.roomId)) },
    ], { align: 'end', placement: 'top' });
  }

  // ------------------------------------------------------------ 数据连接

  async function startDanmaku() {
    try {
      await api.startDanmaku(session.key);
      if (session.destroyed) return;
      session.messages.push({ system: true, text: '弹幕服务器连接正常', user: '', at: Date.now() });
      if (session.tab === 'chat') appendChatLine(session.messages.at(-1));
      const unlisten = await api.onDanmaku((message) => {
        if (!session.destroyed) pushMessage(message);
      });
      if (session.destroyed) {
        unlisten?.();
        return;
      }
      state.unlistenDanmaku = unlisten;
    } catch (error) {
      if (session.destroyed) return;
      session.messages.push({ system: true, text: `弹幕连接失败：${error}`, user: '', at: Date.now() });
      if (session.tab === 'chat') appendChatLine(session.messages.at(-1));
    }
  }

  async function boot() {
    session.scSweep = setInterval(purgeExpiredSc, 1000);
    video.addEventListener('timeupdate', purgeExpiredSc);
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
      if (!payload.detail.live || !session.qualities.length) {
        // 未开播也要保留房间头、关注/取关和主播信息，只是不取流。
        $('ctrl-quality').disabled = true;
        $('ctrl-line').disabled = true;
        setHint({
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
      await startDanmaku();
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
        if (session.destroyed || video.paused || video.readyState < 2) return;
        const now = Date.now();
        if (Math.abs(video.currentTime - session.lastProgressTime) > 0.4) {
          session.lastProgressTime = video.currentTime;
          session.lastProgressAt = now;
          return;
        }
        if (now - session.lastProgressAt < 6000) return;
        session.lastProgressAt = now;
        if (!state.settings.player.autoRefresh) {
          setHint({ text: '直播流已停止，可以刷新继续观看', actions: '<button class="btn primary" id="hint-retry">刷新</button>' });
          bindHintActions();
          return;
        }
        // 优先换线；线路用尽后重取流。两种情况都不需要用户操作。
        if (session.urls.length > 1 && session.lineFailures < session.urls.length) {
          session.lineFailures += 1;
          toast('直播流卡顿，正在切换线路…');
          playLine((session.lineIndex + 1) % session.urls.length);
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
    clearTimeout(session.idleTimer);
    clearInterval(session.clockTimer);
    clearInterval(session.stallTimer);
    for (const timer of session.scTimers.values()) clearTimeout(timer);
    session.scTimers.clear();
    clearInterval(session.scSweep);
    danmaku?.destroy();
    video.removeEventListener('timeupdate', purgeExpiredSc);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (typeof state.unlistenDanmaku === 'function') state.unlistenDanmaku();
    state.unlistenDanmaku = null;
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
