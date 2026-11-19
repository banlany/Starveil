// 应用入口：路由、左侧导航、平台切换、主题与首次启动免责声明。
import { ALL_PLATFORMS, api, ENABLED_PLATFORMS, isPlatformEnabled } from './api.js';
import { icon, PLATFORM_META } from './icons.js';
import {
  ACCOUNT_PLATFORMS,
  applyTheme,
  followKey,
  isFollowing,
  loadFollow,
  loadLogin,
  loadSkinIcons,
  saveSettings,
  skinLockedMode,
  state,
  toggleFollow,
  toggleTheme,
} from './store.js';
import { escapeHtml, openModal, toast } from './ui.js';
import { renderHome } from './pages/home.js';
import { renderCategory } from './pages/category.js';
import { renderCategoryRooms } from './pages/category-rooms.js';
import { renderFollow } from './pages/follow.js';
import { renderSearch } from './pages/search.js';
import { renderSettings, renderSettingsDetail } from './pages/settings.js';
import { renderRoom } from './pages/room.js';
import { importData } from './importer.js';
import { initTitlebar } from './titlebar.js';
import { bindHorizontalSwipe } from './swipe.js';
import { initTooltips } from './tooltip.js';
import { applyPlatformFlags, IS_MOBILE } from './platform.js';

const view = document.getElementById('view');
const rail = document.getElementById('rail');
const topbar = document.getElementById('topbar');
const platformTabs = document.getElementById('platform-tabs');
const searchButton = document.getElementById('topbar-search');
const refreshButton = document.getElementById('topbar-refresh');

const PAGES = {
  home: { render: renderHome, rail: true, topbar: true, search: true, className: '' },
  category: { render: renderCategory, rail: true, topbar: true, search: false, className: '' },
  follow: { render: renderFollow, rail: true, topbar: false, search: false, className: '' },
  settings: { render: renderSettings, rail: true, topbar: false, search: false, className: '' },
  settingsDetail: { render: renderSettingsDetail, rail: false, topbar: false, search: false, className: '' },
  categoryRooms: { render: renderCategoryRooms, rail: false, topbar: false, search: false, className: '' },
  search: { render: renderSearch, rail: false, topbar: false, search: false, className: '' },
  room: { render: renderRoom, rail: false, topbar: false, search: false, className: 'is-room' },
};

const backStack = [];
// 进房前所在的一级页面，即退出直播间后的返回目标。
let roomRoot = 'home';
let roomRootParams = {};
// 进入直播间时的返回栈深度；退出时恢复到该深度。
let roomStackDepth = 0;
let cleanup = null;
let currentKey = '';
const scrollPositions = new Map();
let timerHandle = 0;
// 定时关闭的到点时刻，供「更多」菜单显示剩余时间。
let timerDeadline = 0;
// 首页把「刷新推荐」的动作注册到这里，顶栏那个按钮只负责触发。
let homeRefreshHandler = null;
// 信息流页面注册的下拉刷新动作（首页 / 关注 / 分类列表各自提供）。
let pullRefreshHandler = null;

const ctx = {
  go,
  back,
  exitRoom,
  refresh: () => render({ keepScroll: false }),
  route: () => state.page,
  params: () => state.routeParams,
  selectPlatform,
  openRoom,
  openCategoryRooms,
  isFollowing: (platform, roomId) => isFollowing(platform, roomId),
  followFromCard,
  restartTimer,
  sleepTimer: sleepTimerState,
  setSleepTimer,
  setHomeRefresh(handler) {
    homeRefreshHandler = typeof handler === 'function' ? handler : null;
  },
  setHomeRefreshing(loading) {
    refreshButton?.classList.toggle('is-loading', Boolean(loading));
  },
  /// 注册/清除当前页面的下拉刷新动作（页面 cleanup 时传 null）。
  setPullRefresh(handler) {
    pullRefreshHandler = typeof handler === 'function' ? handler : null;
  },
};

function routeKey(route, params) {
  return `${route}:${JSON.stringify(params || {})}`;
}

function go(route, params = {}, options = {}) {
  if (!PAGES[route]) return;
  const nextKey = routeKey(route, params);
  if (nextKey === routeKey(state.page, state.routeParams)) {
    if (!options.keepScroll) render({ keepScroll: options.keepScroll });
    return;
  }
  if (!options.replace && state.page) {
    backStack.push({ route: state.page, params: state.routeParams, key: currentKey });
    if (backStack.length > 40) backStack.shift();
  }
  state.page = route;
  state.routeParams = params;
  render({ keepScroll: options.keepScroll });
}

function back() {
  const previous = backStack.pop();
  if (!previous) {
    // 栈已经空了：直播间里退出一级页面，其余情况回首页。
    if (state.page === 'room') {
      exitRoom();
      return;
    }
    state.page = 'home';
    state.routeParams = {};
    render({ dir: 'back' });
    return;
  }
  state.page = previous.route;
  state.routeParams = previous.params;
  render({ keepScroll: true, dir: 'back' });
}

function exitRoom() {
  // 返回：回到进入直播间前的一级页面，并保留更早的来路。
  if (roomStackDepth >= 0 && roomStackDepth < backStack.length) {
    backStack.length = roomStackDepth;
  }
  state.page = roomRoot && PAGES[roomRoot] ? roomRoot : 'home';
  state.routeParams = roomRoot && PAGES[roomRoot] ? roomRootParams : {};
  render({ keepScroll: true, dir: 'back' });
}

function openRoom(platform, roomId) {
  if (!isPlatformEnabled(platform)) {
    showPlatformLocked(platform);
    return;
  }
  // 只有从非直播间页面进来时才更新根页面；直播间之间跳转保持原来的根。
  if (state.page && state.page !== 'room') {
    roomRoot = state.page;
    roomRootParams = state.routeParams;
    roomStackDepth = backStack.length;
  }
  // 同平台进房（从搜索结果/首页点卡片）不要动缓存，否则返回后列表和关键词都没了。
  const platformChanged = platform !== state.platform;
  state.platform = platform;
  state.settings.home.platform = platform;
  saveSettings();
  if (platformChanged) {
    // 切换平台时清掉上一平台的列表缓存。
    resetPlatformCaches();
    syncPlatformTabs();
  }
  go('room', { platform, roomId: String(roomId) });
}

function openCategoryRooms(params) {
  go('categoryRooms', params);
}

function followFromCard(room) {
  const platform = room.platform || state.platform;
  const following = toggleFollow({ ...room, platform });
  toast(following ? '已加入关注' : '已取消关注', following ? 'success' : 'info');
  return following;
}

function showPlatformLocked(platform) {
  openModal({
    title: `${PLATFORM_META[platform]?.name || platform} 接口接入中`,
    subtitle: '当前版本先完成三站核心体验',
    body: `<p class="modal-text">这一版先接入哔哩哔哩、斗鱼、虎牙的推荐、分类、搜索、取流与弹幕；抖音和快手的接口（签名、protobuf 弹幕、播放地址）还在移植中。</p><p class="modal-text" style="margin-top:10px">界面已经预留平台入口，接入后不需要再改导航结构。</p>`,
    actions: [{ label: '知道了', kind: 'primary' }],
  });
}

/// 切平台后清掉上一平台的列表缓存。
function resetPlatformCaches() {
  state.home = { items: [], page: 0, loading: false, done: false, error: '' };
  state.category = { tree: [], expanded: {}, loading: false, error: '' };
  state.search.results = [];
  state.search.keyword = '';
}

function selectPlatform(platform, options = {}) {
  if (!isPlatformEnabled(platform)) {
    if (!options.silent) showPlatformLocked(platform);
    return false;
  }
  if (state.platform === platform) return true;
  state.platform = platform;
  state.settings.home.platform = platform;
  saveSettings();
  resetPlatformCaches();
  syncPlatformTabs();
  if (state.page === 'home' || state.page === 'category') {
    render({ keepScroll: false });
  }
  return true;
}

/// 把平台标签下方的主色条移到当前标签下。
let platformUnderlineReady = false;
function placePlatformUnderline(active) {
  const underline = platformTabs.querySelector('.tab-underline');
  if (!underline || !active) return;
  const inset = parseFloat(getComputedStyle(platformTabs).getPropertyValue('--tab-underline-inset')) || 0;
  if (!platformUnderlineReady) underline.style.transition = 'none';
  underline.style.width = `${Math.max(0, active.offsetWidth - inset * 2)}px`;
  underline.style.transform = `translateX(${active.offsetLeft + inset}px)`;
  if (!platformUnderlineReady) {
    // 首帧直接定位，别让色条从最左边滑进第一个标签。
    void underline.offsetWidth;
    underline.style.transition = '';
    platformUnderlineReady = true;
  }
}

/// 重新测量并移动色条：ResizeObserver 观察标签条，resize/orientationchange 兜底，debounce 120ms。
function initUnderlineTracking() {
  let timer = 0;
  const sync = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // 直播间里顶栏是 display:none，量出来全是 0，跳过这一轮。
      if (!platformTabs.offsetWidth) return;
      syncPlatformTabs();
    }, 120);
  };
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(platformTabs);
}

function syncPlatformTabs() {
  let active = null;
  for (const tab of platformTabs.querySelectorAll('.platform-tab')) {
    const current = tab.dataset.platform === state.platform;
    tab.classList.toggle('active', current);
    if (current) active = tab;
  }
  // 切页后把当前标签滚入视野（移动端标签条可横向滚动）。
  if (IS_MOBILE) active?.scrollIntoView({ inline: 'center', block: 'nearest' });
  placePlatformUnderline(active);
}

function renderPlatformTabs() {
  platformTabs.innerHTML = ALL_PLATFORMS.map((platform) => {
    const envEnabled = ENABLED_PLATFORMS.includes(platform);
    const active = platform === state.platform;
    const meta = PLATFORM_META[platform];
    const label = meta.tab || meta.name;
    // 平台标签只放文字。
    return `<button class="platform-tab${active ? ' active' : ''}${envEnabled ? '' : ' is-disabled'}" data-platform="${platform}" role="tab" aria-selected="${active}" title="${escapeHtml(meta.name)}${envEnabled ? '' : '（即将支持）'}"><span>${escapeHtml(label)}</span></button>`;
  }).join('') + '<span class="tab-underline" aria-hidden="true"></span>';
  for (const tab of platformTabs.querySelectorAll('.platform-tab')) {
    tab.addEventListener('click', () => selectPlatform(tab.dataset.platform));
  }
}

/// 按已启用平台顺序翻一页，到两端停住；返回是否发生切换。
function cyclePlatform(direction) {
  const list = ALL_PLATFORMS.filter((platform) => isPlatformEnabled(platform));
  if (list.length < 2) return false;
  const index = list.indexOf(state.platform);
  if (index < 0) return false;
  const next = list[index + (direction === 'left' ? 1 : -1)];
  if (!next) return false;
  return selectPlatform(next, { silent: true });
}

/// 左右滑动切平台，仅首页与分类页。
function initSwipe() {
  if (!IS_MOBILE) return;
  bindHorizontalSwipe(view, (direction) => {
    if (state.page !== 'home' && state.page !== 'category') return false;
    // 有浮层时手势归浮层，别在下面偷偷切平台。
    if (document.querySelector('.modal-overlay, .menu-overlay:not(.closing)')) return false;
    if (!cyclePlatform(direction)) return false;
    // 入场动画由 render() 负责，这里不再叠加。
    return true;
  });
}

function renderChrome() {
  const config = PAGES[state.page] || PAGES.home;
  rail.classList.toggle('is-hidden', !config.rail);
  topbar.classList.toggle('is-hidden', !config.topbar);
  searchButton.classList.toggle('is-hidden', !config.search);
  // 刷新按钮钉在顶栏左上角（和关注页同一个位置），只在首页出现。
  if (refreshButton) refreshButton.hidden = state.page !== 'home';
  topbar.classList.toggle('has-refresh', state.page === 'home');
  view.className = `view ${config.className || ''}`.trim();
  const activeRail =
    state.page === 'home' || state.page === 'categoryRooms' || state.page === 'search'
      ? 'home'
      : state.page === 'settings' || state.page === 'settingsDetail'
        ? 'settings'
        : state.page;
  for (const button of rail.querySelectorAll('.rail-btn[data-nav]')) {
    button.classList.toggle('active', button.dataset.nav === activeRail);
  }
  syncPlatformTabs();
}

function render({ keepScroll = false, dir = 'forward' } = {}) {
  // 路由切换时关掉可能还没关的浮层菜单，避免它跟着进入下一个页面。
  for (const overlay of document.querySelectorAll('.menu-overlay')) overlay.remove();
  if (cleanup) {
    try {
      cleanup();
    } catch (error) {
      console.error('cleanup', error);
    }
    cleanup = null;
  }
  if (currentKey) scrollPositions.set(currentKey, view.scrollTop);
  currentKey = routeKey(state.page, state.routeParams);
  renderChrome();
  view.innerHTML = '';
  view.scrollTop = 0;
  const config = PAGES[state.page] || PAGES.home;
  try {
    cleanup = config.render(ctx, state.routeParams) || null;
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="page-error" style="margin:40px"><span>页面渲染失败：${escapeHtml(error)}</span><button class="btn small" id="render-retry">回到首页</button></div>`;
    view.querySelector('#render-retry')?.addEventListener('click', () => {
      backStack.length = 0;
      go('home', {}, { replace: true });
    });
  }
  if (keepScroll) {
    const target = scrollPositions.get(currentKey) || 0;
    requestAnimationFrame(() => {
      view.scrollTop = target;
    });
  }
  // 页面入场动画；直播间跳过。
  const pageEl = view.firstElementChild;
  if (pageEl && state.page !== 'room') {
    pageEl.classList.add('page-enter');
    // 返回上一层从上方落下，前进则从下方浮起，方向对得上操作。
    if (dir === 'back') pageEl.classList.add('back');
  }
}

function initRail() {
  searchButton.innerHTML = icon('search', 20);
  if (refreshButton) {
    refreshButton.innerHTML = icon('refresh', 19);
    refreshButton.addEventListener('click', () => homeRefreshHandler?.());
  }
  // 导航图标两版（线框/实心）同时写入 DOM，由 CSS 按 .active 切换。
  // 第四项显示为「我的」，路由名仍为 settings。
  const icons = {
    home: ['home', 'homeFilled'],
    follow: ['follow', 'followFilled'],
    category: ['grid', 'gridFilled'],
    settings: ['account', 'accountFilled'],
  };
  for (const button of rail.querySelectorAll('.rail-btn[data-nav]')) {
    const [line, fill] = icons[button.dataset.nav] || ['info', 'info'];
    button.innerHTML =
      `<span class="rail-ico rail-ico-line">${icon(line, 25)}</span>` +
      `<span class="rail-ico rail-ico-fill">${icon(fill, 25)}</span>`;
    button.addEventListener('click', () => {
      const route = button.dataset.nav;
      if (state.page === route) {
        view.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      // 一级导航作为新起点，清空返回栈
      backStack.length = 0;
      go(route, {}, { replace: true });
    });
  }
  // 移动端不留快捷主题按钮：底栏/侧栏只放导航，主题在设置里改。
  if (IS_MOBILE) {
    rail.querySelector('.rail-bottom')?.remove();
  } else {
    const themeButton = rail.querySelector('[data-action="theme"]');
    themeButton.innerHTML = icon(themeIcon(displayThemeMode()), 20);
    themeButton.addEventListener('click', () => {
      // 皮肤只有一套配色时禁用明暗切换，并给出说明。
      const locked = skinLockedMode();
      if (locked) {
        toast(`当前皮肤只提供${locked === 'light' ? '浅色' : '深色'}主题`);
        return;
      }
      const mode = toggleTheme();
      themeButton.innerHTML = icon(themeIcon(mode), 20);
      toast(mode === 'light' ? '已切换到浅色模式' : mode === 'system' ? '已跟随系统主题' : '已切换到深色模式');
      if (state.page === 'settingsDetail') render({ keepScroll: false });
    });
  }
  refreshThemeButton();
}

/// 主题按钮图标：浅色太阳、深色月亮、跟随系统半亮半暗。
function themeIcon(mode) {
  if (mode === 'light') return 'sun';
  if (mode === 'system') return 'contrast';
  return 'moon';
}

/// 按钮按实际生效的明暗档显示：皮肤只有一档时显示那一档。
function displayThemeMode() {
  return skinLockedMode() || state.settings.appearance?.theme || 'dark';
}

function refreshThemeButton() {
  const button = rail.querySelector('[data-action="theme"]');
  if (!button) return;
  const mode = displayThemeMode();
  const locked = skinLockedMode();
  button.innerHTML = icon(themeIcon(mode), 20);
  if (locked) {
    button.title = `当前皮肤只提供${locked === 'light' ? '浅色' : '深色'}主题`;
    return;
  }
  button.title = mode === 'light' ? '当前浅色，点击跟随系统' : mode === 'system' ? '当前跟随系统，点击深色' : '当前深色，点击浅色';
}

function showDisclaimer() {
  if (state.settings.disclaimerAccepted) return;
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">欢迎使用 Starveil。本应用是一个聚合直播客户端，用于学习和研究桌面端开发。</p>
    <p class="modal-text" style="margin-top:10px">应用不提供、不存储、不转播任何直播内容；所有视频流、弹幕、封面与商标均归各直播平台及主播所有。请遵守所在地区法律法规和各平台服务条款。</p>
    <p class="modal-text" style="margin-top:10px">继续使用即表示你已阅读并同意上述说明。若你不希望自己的直播间被展示，请通过平台渠道处理。</p>`;
  openModal({
    title: '免责声明',
    subtitle: '首次使用前请阅读',
    width: 480,
    body,
    actions: [
      { label: '退出应用', kind: 'ghost', onClick: () => api.quitApp().catch(() => window.close()) },
      {
        label: '已阅读并同意',
        kind: 'primary',
        onClick: () => {
          state.settings.disclaimerAccepted = true;
          state.settings.firstRun = false;
          saveSettings();
          toast('欢迎使用 Starveil', 'success');
        },
      },
    ],
    onClose: () => {},
  });
}

function restartTimer() {
  clearTimeout(timerHandle);
  timerHandle = 0;
  const minutes = Math.max(1, Number(state.settings.timer.minutes) || 60);
  if (!state.settings.timer.enabled) {
    timerDeadline = 0;
    return;
  }
  timerDeadline = Date.now() + minutes * 60 * 1000;
  timerHandle = setTimeout(() => {
    const once = Boolean(state.settings.timer.once);
    if (once) {
      // 先落盘开关再退出，保证「只生效一次」。
      state.settings.timer.enabled = false;
      saveSettings();
    }
    timerDeadline = 0;
    toast(once ? '定时关闭已生效，正在退出（下次启动不会再自动计时）' : '定时关闭时间到，正在退出…');
    setTimeout(() => api.quitApp().catch(() => window.close()), 900);
  }, minutes * 60 * 1000);
}

/// 定时关闭的实时状态，设置页与「更多」菜单共用。
function sleepTimerState() {
  const minutes = Math.max(1, Number(state.settings.timer.minutes) || 60);
  const remaining = timerDeadline > 0 ? Math.max(0, timerDeadline - Date.now()) : 0;
  return { enabled: Boolean(state.settings.timer.enabled) && remaining > 0, minutes, remaining };
}

/// 设置/取消定时关闭（分钟，0 取消）。
function setSleepTimer(minutes) {
  const value = Math.round(Number(minutes) || 0);
  state.settings.timer.enabled = value > 0;
  if (value > 0) state.settings.timer.minutes = Math.max(1, Math.min(720, value));
  saveSettings();
  restartTimer();
  return sleepTimerState();
}

/// 安卓返回键：关浮层 → 退全屏 → 出直播间 → 返回栈上一页 → 回首页 → 结束应用。
function handleAndroidBack() {
  const menu = document.querySelector('.menu-overlay:not(.closing)');
  if (menu) {
    // 菜单的「点外面关闭」是监听在 document 上的 mousedown，这里补一个同样的事件。
    menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return;
  }
  const modal = document.querySelector('.modal-overlay');
  if (modal) {
    modal.querySelector('.modal-close')?.click();
    return;
  }
  // 全屏时先退全屏；两处标记都要判断。
  if (
    document.documentElement.classList.contains('is-theater') ||
    document.querySelector('.room-page.is-theater')
  ) {
    window.dispatchEvent(new CustomEvent('simple-live:exit-theater'));
    return;
  }
  if (state.page === 'room') {
    exitRoom();
    return;
  }
  if (backStack.length) {
    back();
    return;
  }
  if (state.page !== 'home') {
    go('home', {}, { replace: true });
    return;
  }
  // 退无可退：结束应用（安卓走 finishAffinity，任务栈不会留空壳）。
  api.exitApp().catch(() => {});
}

function initGlobalShortcuts() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'f' && state.page !== 'room') {
      event.preventDefault();
      go('search', {});
    }
    if (event.altKey && event.key === 'ArrowLeft' && state.page !== 'room') {
      event.preventDefault();
      back();
    }
    if (event.key === 'Escape' && ['settingsDetail', 'categoryRooms', 'search'].includes(state.page)) {
      // 有浮层开着时 Escape 只关浮层。
      if (document.querySelector('.modal-overlay, .menu-overlay:not(.closing)')) return;
      event.preventDefault();
      back();
    }
  });
  searchButton.addEventListener('click', () => go('search', {}));
  // 安卓物理返回键：由 MainActivity.onBackPressed 通过 evaluateJavascript 调用。
  if (IS_MOBILE) {
    window.__starveilBack = () => {
      try {
        handleAndroidBack();
      } catch (error) {
        console.warn('返回键处理失败', error);
      }
    };
  }
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (state.settings.appearance?.theme === 'system') applyTheme();
  });
}

/// 下拉刷新：仅在列表顶部生效，松手超过阈值触发当前页的刷新动作。
function initPullRefresh() {
  const indicator = document.createElement('div');
  indicator.className = 'pull-refresh';
  indicator.innerHTML = '<span class="pull-arrow"></span><span class="pull-text">下拉刷新</span>';
  document.body.appendChild(indicator);
  const label = indicator.querySelector('.pull-text');

  const THRESHOLD = 64;
  const MAX = 96;
  let startX = 0;
  let startY = 0;
  let pulling = false;
  let distance = 0;

  const reset = () => {
    pulling = false;
    distance = 0;
    indicator.classList.remove('ready', 'loading');
    indicator.style.transform = '';
    label.textContent = '下拉刷新';
  };

  view.addEventListener('touchstart', (event) => {
    if (!pullRefreshHandler || view.scrollTop > 0 || event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    pulling = true;
    distance = 0;
  }, { passive: true });

  view.addEventListener('touchmove', (event) => {
    if (!pulling) return;
    const touch = event.touches[0];
    const delta = touch.clientY - startY;
    // 横向为主的那一下是翻页（swipe.js），别在顶上冒一个下拉胶囊出来。
    if (Math.abs(touch.clientX - startX) > Math.abs(delta)) {
      reset();
      return;
    }
    if (delta <= 0) {
      reset();
      return;
    }
    // 0.5 的阻尼：拖一屏只走半屏，手感接近原生下拉。
    distance = Math.min(MAX, delta * 0.5);
    indicator.style.transform = `translate(-50%, ${distance}px)`;
    const ready = distance >= THRESHOLD;
    indicator.classList.toggle('ready', ready);
    label.textContent = ready ? '松开刷新' : '下拉刷新';
  }, { passive: true });

  view.addEventListener('touchend', async () => {
    if (!pulling) return;
    const trigger = distance >= THRESHOLD;
    pulling = false;
    if (!trigger) {
      reset();
      return;
    }
    indicator.classList.add('loading');
    indicator.classList.remove('ready');
    label.textContent = '正在刷新…';
    indicator.style.transform = 'translate(-50%, 56px)';
    try {
      await pullRefreshHandler?.();
    } catch {
      /* 页面自己会把失败原因显示出来 */
    }
    reset();
  }, { passive: true });

  view.addEventListener('touchcancel', reset, { passive: true });
}

const WINDOW_STATE_KEY = 'starveil.window.v1';
let windowRestoring = false;
let windowSaveTimer = 0;

// 窗口尺寸下限，须与 tauri.conf.json 的 minWidth / minHeight 一致。
const MIN_WINDOW_WIDTH = 1080;
const MIN_WINDOW_HEIGHT = 640;

function isUsableWindowSize(width, height) {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= MIN_WINDOW_WIDTH &&
    height >= MIN_WINDOW_HEIGHT
  );
}

async function restoreWindowState() {
  if (!state.settings.other?.rememberWindow) return;
  const tauri = window.__TAURI__?.window;
  if (!tauri?.getCurrentWindow) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(WINDOW_STATE_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return;
  const win = tauri.getCurrentWindow();
  windowRestoring = true;
  try {
    if (saved.maximized) {
      await win.maximize();
      return;
    }
    // 存下来的是退化尺寸（窗口被拖到最小）时，用配置里的默认尺寸兜底。
    const width = Math.max(MIN_WINDOW_WIDTH, Math.round(saved.width));
    const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(saved.height));
    await win.setSize(new tauri.PhysicalSize(width, height));
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      let visible = true;
      try {
        const monitors = await tauri.availableMonitors();
        visible = monitors.some(
          (monitor) =>
            saved.x < monitor.position.x + monitor.size.width &&
            saved.x + width > monitor.position.x &&
            saved.y < monitor.position.y + monitor.size.height &&
            saved.y + height > monitor.position.y
        );
      } catch {
        visible = true;
      }
      if (visible) await win.setPosition(new tauri.PhysicalPosition(saved.x, saved.y));
    }
  } catch (error) {
    console.warn('恢复窗口尺寸失败', error);
  } finally {
    setTimeout(() => {
      windowRestoring = false;
    }, 500);
  }
}

async function saveWindowState() {
  if (windowRestoring || !state.settings.other?.rememberWindow) return;
  const tauri = window.__TAURI__?.window;
  if (!tauri?.getCurrentWindow) return;
  try {
    const win = tauri.getCurrentWindow();
    const [position, size, maximized] = await Promise.all([
      win.outerPosition(),
      win.innerSize(),
      win.isMaximized(),
    ]);
    // 退化尺寸直接丢弃，别覆盖掉之前存好的正常值。
    if (!maximized && !isUsableWindowSize(size.width, size.height)) return;
    localStorage.setItem(
      WINDOW_STATE_KEY,
      JSON.stringify({
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
      })
    );
  } catch (error) {
    console.warn('保存窗口尺寸失败', error);
  }
}

function debounceWindowSave() {
  clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(saveWindowState, 400);
}

/// 应用屏幕方向（auto / portrait / landscape）；桌面端为空实现。
function applyScreenOrientation() {
  const mode = state.settings.appearance?.orientation || 'auto';
  api.setScreenOrientation(mode).catch((error) => console.warn('设置屏幕方向失败', error));
}

async function setupWindowState() {
  // 移动端窗口由系统全屏管理，记住尺寸没有意义（也没法恢复）。
  if (IS_MOBILE) return;
  const tauri = window.__TAURI__?.window;
  if (!tauri?.getCurrentWindow) return;
  await restoreWindowState();
  try {
    const win = tauri.getCurrentWindow();
    await win.onResized(debounceWindowSave);
    await win.onMoved(debounceWindowSave);
  } catch (error) {
    console.warn('注册窗口尺寸监听失败', error);
  }
}

/// 启动时拉取 WebDAV 包：仅当云端比本机上次同步更新时应用，失败只写控制台。
async function autoPullSync() {
  const config = state.settings.sync?.webdav;
  if (!config?.autoPull || !config.url) return;
  const path = String(config.path || 'starveil-sync.json').trim().replace(/^\/+/, '');
  const url = config.url.endsWith('/') ? `${config.url}${path}` : `${config.url}/${path}`;
  try {
    const payload = await api.webdavDownload(url, config.username, config.password, config.insecureTls);
    const bundle = JSON.parse(payload.content);
    const remoteAt = Date.parse(bundle.exportedAt || '') || 0;
    if (!remoteAt || remoteAt <= (Number(state.settings.sync.lastSyncAt) || 0)) return;
    const summary = importData(bundle);
    // 包内含登录信息时把 Cookie 注回后端。
    for (const platform of summary.accounts || []) {
      const login = loadLogin(platform);
      if (login?.cookie) await api.setCookie(platform, login.cookie).catch(() => {});
    }
    state.settings.sync.lastSyncAt = Date.now();
    saveSettings();
    toast('已从云端同步数据', 'success');
    render({ keepScroll: true });
  } catch (error) {
    console.warn('自动拉取云端同步失败', error);
  }
}

function init() {
  // 平台标记须在任何渲染之前写入。
  applyPlatformFlags();
  // 禁用 WebView 默认右键菜单，避免露出浏览器菜单/刷新等开发项。
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  applyTheme();
  initTitlebar();
  // 接管页面里的 title：原生提示框是系统样式，跟皮肤无关。
  initTooltips();
  // 尽早应用上次选择的屏幕方向，减少启动时先按系统方向渲染再转过来的观感。
  applyScreenOrientation();
  // GPU 选择以标记文件为准，本机设置可能与实际启动参数不一致。
  if (!IS_MOBILE) {
    api.highPerformanceGpu()
      .then((enabled) => {
        if (state.settings.player.highPerformanceGpu === Boolean(enabled)) return;
        state.settings.player.highPerformanceGpu = Boolean(enabled);
        saveSettings();
      })
      .catch(() => {});
  }
  // 写一行运行日志，便于确认页面真的执行了（出问题时看 starveil.log）。
  window.__TAURI__?.core
    ?.invoke('frontend_log', { message: '页面已初始化，rail=' + document.querySelectorAll('.rail-btn').length })
    ?.catch(() => {});
  document.body.dataset.density = state.settings.appearance?.density || 'comfortable';
  document.body.dataset.cardSize = state.settings.home?.cardSize || 'medium';
  state.platform = state.settings.home?.platform && isPlatformEnabled(state.settings.home.platform) ? state.settings.home.platform : 'bilibili';
  initRail();
  window.addEventListener('simple-live:theme', refreshThemeButton);
  renderPlatformTabs();
  initGlobalShortcuts();
  initPullRefresh();
  initSwipe();
  initUnderlineTracking();
  state.page = 'home';
  state.routeParams = {};
  render({ keepScroll: false });
  setupWindowState();
  showDisclaimer();
  restartTimer();
  // 恢复各平台登录 Cookie。
  for (const platform of ACCOUNT_PLATFORMS) {
    const login = loadLogin(platform);
    if (login?.cookie) {
      api.setCookie(platform, login.cookie).catch((error) => console.warn('恢复登录态失败', platform, error));
    }
  }
  // 启动时自动拉取云端同步包（默认关闭，需在设置里显式打开）。
  setTimeout(autoPullSync, 1500);
  // 预加载分类树，切换分类页更快
  setTimeout(() => {
    if (!state.category.tree.length && !state.category.loading) {
      // 记录发起时的平台，避免回包写到已切换的平台。
      const platform = state.platform;
      state.category.loading = true;
      api.categories(platform).then((tree) => {
        if (platform !== state.platform) return;
        if (!state.category.tree.length) state.category.tree = tree;
      }).catch(() => {}).finally(() => {
        state.category.loading = false;
      });
    }
  }, 1200);
}

/// 启动顺序：先加载皮肤图标表，再 init。
loadSkinIcons()
  .catch(() => {})
  .then(init);
