// 应用入口：路由、左侧导航、平台切换、主题与首次启动免责声明。
import { ALL_PLATFORMS, api, ENABLED_PLATFORMS, isPlatformEnabled } from './api.js';
import { icon, PLATFORM_META, platformIcon } from './icons.js';
import {
  applyTheme,
  followKey,
  isFollowing,
  loadFollow,
  loadLogin,
  saveSettings,
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

const view = document.getElementById('view');
const rail = document.getElementById('rail');
const topbar = document.getElementById('topbar');
const platformTabs = document.getElementById('platform-tabs');
const searchButton = document.getElementById('topbar-search');

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
let cleanup = null;
let currentKey = '';
const scrollPositions = new Map();
let timerHandle = 0;

const ctx = {
  go,
  back,
  refresh: () => render({ keepScroll: false }),
  route: () => state.page,
  params: () => state.routeParams,
  selectPlatform,
  openRoom,
  openCategoryRooms,
  isFollowing: (platform, roomId) => isFollowing(platform, roomId),
  followFromCard,
  restartTimer,
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
    state.page = 'home';
    state.routeParams = {};
    render();
    return;
  }
  state.page = previous.route;
  state.routeParams = previous.params;
  render({ keepScroll: true });
}

function openRoom(platform, roomId) {
  if (!isPlatformEnabled(platform)) {
    showPlatformLocked(platform);
    return;
  }
  state.platform = platform;
  state.settings.home.platform = platform;
  saveSettings();
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

function selectPlatform(platform, options = {}) {
  if (!isPlatformEnabled(platform)) {
    if (!options.silent) showPlatformLocked(platform);
    return false;
  }
  if (state.platform === platform) return true;
  state.platform = platform;
  state.settings.home.platform = platform;
  saveSettings();
  state.home = { items: [], page: 0, loading: false, done: false, error: '' };
  state.category = { tree: [], expanded: {}, loading: false, error: '' };
  state.search.results = [];
  state.search.keyword = '';
  syncPlatformTabs();
  if (state.page === 'home' || state.page === 'category') {
    render({ keepScroll: false });
  }
  return true;
}

function syncPlatformTabs() {
  for (const tab of platformTabs.querySelectorAll('.platform-tab')) {
    tab.classList.toggle('active', tab.dataset.platform === state.platform);
  }
}

function renderPlatformTabs() {
  platformTabs.innerHTML = ALL_PLATFORMS.map((platform) => {
    const envEnabled = ENABLED_PLATFORMS.includes(platform);
    const active = platform === state.platform;
    return `<button class="platform-tab${active ? ' active' : ''}${envEnabled ? '' : ' is-disabled'}" data-platform="${platform}" role="tab" aria-selected="${active}" title="${escapeHtml(PLATFORM_META[platform].name)}${envEnabled ? '' : '（即将支持）'}">${platformIcon(platform, 23)}<span>${escapeHtml(PLATFORM_META[platform].name)}</span></button>`;
  }).join('');
  for (const tab of platformTabs.querySelectorAll('.platform-tab')) {
    tab.addEventListener('click', () => selectPlatform(tab.dataset.platform));
  }
}

function renderChrome() {
  const config = PAGES[state.page] || PAGES.home;
  rail.classList.toggle('is-hidden', !config.rail);
  topbar.classList.toggle('is-hidden', !config.topbar);
  searchButton.classList.toggle('is-hidden', !config.search);
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

function render({ keepScroll = false } = {}) {
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
}

function initRail() {
  searchButton.innerHTML = icon('search', 20);
  const icons = { home: 'home', follow: 'heart', category: 'grid', settings: 'settings' };
  for (const button of rail.querySelectorAll('.rail-btn[data-nav]')) {
    button.innerHTML = icon(icons[button.dataset.nav], 25);
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
  const themeButton = rail.querySelector('[data-action="theme"]');
  themeButton.innerHTML = icon('moon', 20);
  themeButton.addEventListener('click', () => {
    const mode = toggleTheme();
    themeButton.innerHTML = icon(mode === 'light' ? 'sun' : mode === 'system' ? 'settings' : 'moon', 20);
    toast(mode === 'light' ? '已切换到浅色模式' : mode === 'system' ? '已跟随系统主题' : '已切换到深色模式');
    if (state.page === 'settingsDetail') render({ keepScroll: false });
  });
  refreshThemeButton();
}

function refreshThemeButton() {
  const button = rail.querySelector('[data-action="theme"]');
  if (!button) return;
  const mode = state.settings.appearance?.theme || 'dark';
  button.innerHTML = icon(mode === 'light' ? 'sun' : mode === 'system' ? 'settings' : 'moon', 20);
  button.title = mode === 'light' ? '当前浅色，点击跟随系统' : mode === 'system' ? '当前跟随系统，点击深色' : '当前深色，点击浅色';
}

function showDisclaimer() {
  if (state.settings.disclaimerAccepted) return;
  const body = document.createElement('div');
  body.innerHTML = `
    <p class="modal-text">欢迎使用星幕直播。本应用是一个聚合直播客户端，用于学习和研究桌面端开发。</p>
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
          toast('欢迎使用星幕直播', 'success');
        },
      },
    ],
    onClose: () => {},
  });
}

function restartTimer() {
  clearTimeout(timerHandle);
  timerHandle = 0;
  if (!state.settings.timer.enabled) return;
  const minutes = Math.max(1, Number(state.settings.timer.minutes) || 60);
  timerHandle = setTimeout(() => {
    toast('定时关闭时间到，正在退出…');
    setTimeout(() => api.quitApp().catch(() => window.close()), 900);
  }, minutes * 60 * 1000);
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
      event.preventDefault();
      back();
    }
  });
  searchButton.addEventListener('click', () => go('search', {}));
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (state.settings.appearance?.theme === 'system') applyTheme();
  });
}

const WINDOW_STATE_KEY = 'starveil.window.v1';
let windowRestoring = false;
let windowSaveTimer = 0;

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
    await win.setSize(new tauri.PhysicalSize(saved.width, saved.height));
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      let visible = true;
      try {
        const monitors = await tauri.availableMonitors();
        visible = monitors.some(
          (monitor) =>
            saved.x < monitor.position.x + monitor.size.width &&
            saved.x + saved.width > monitor.position.x &&
            saved.y < monitor.position.y + monitor.size.height &&
            saved.y + saved.height > monitor.position.y
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

async function setupWindowState() {
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

function init() {
  // 禁用 WebView 默认右键菜单，避免露出浏览器菜单/刷新等开发项。
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  applyTheme();
  document.body.dataset.density = state.settings.appearance?.density || 'comfortable';
  document.body.dataset.cardSize = state.settings.home?.cardSize || 'medium';
  state.platform = state.settings.home?.platform && isPlatformEnabled(state.settings.home.platform) ? state.settings.home.platform : 'bilibili';
  initRail();
  window.addEventListener('simple-live:theme', refreshThemeButton);
  renderPlatformTabs();
  initGlobalShortcuts();
  state.page = 'home';
  state.routeParams = {};
  render({ keepScroll: false });
  setupWindowState();
  showDisclaimer();
  restartTimer();
  // 恢复上次登录的平台 Cookie；后端每个平台独立持有 LiveCore。
  for (const platform of ['bilibili', 'douyu']) {
    const login = loadLogin(platform);
    if (login?.cookie) {
      api.setCookie(platform, login.cookie).catch((error) => console.warn('恢复登录态失败', platform, error));
    }
  }
  // 预加载分类树，切换分类页更快
  setTimeout(() => {
    if (!state.category.tree.length && !state.category.loading) {
      api.categories(state.platform).then((tree) => {
        if (!state.category.tree.length) state.category.tree = tree;
      }).catch(() => {});
    }
  }, 1200);
}

init();
