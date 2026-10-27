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
import { importData } from './importer.js';
import { initTitlebar } from './titlebar.js';

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
// 进入直播间之前所在的一级页面，用于“从直播间返回一级界面”。
let roomRoot = 'home';
let roomRootParams = {};
// 进入直播间那一刻返回栈的深度。退出直播间时把栈恢复到这个深度，
// 而不是整个清空——清空会把“观看记录 → 直播间”这条来路也一起丢掉，
// 于是回到观看记录后再点返回就没有上一级可退了。
let roomStackDepth = 0;
let cleanup = null;
let currentKey = '';
const scrollPositions = new Map();
let timerHandle = 0;
// 首页把「刷新推荐」的动作注册到这里，顶栏那个按钮只负责触发。
let homeRefreshHandler = null;

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
  setHomeRefresh(handler) {
    homeRefreshHandler = typeof handler === 'function' ? handler : null;
  },
  setHomeRefreshing(loading) {
    refreshButton?.classList.toggle('is-loading', Boolean(loading));
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
    render();
    return;
  }
  state.page = previous.route;
  state.routeParams = previous.params;
  render({ keepScroll: true });
}

function exitRoom() {
  // 直播间里的返回按钮、Esc 都走这里：直接回进入直播间之前的一级页面。
  // 这样“关注栏进 A → 再进 B → 返回”不会退回到 A，而是回到列表页。
  // 返回栈只恢复到进房间时的深度，保留更早的来路（设置 → 观看记录 → 直播间），
  // 这样回到观看记录后还能继续往上一层退。
  if (roomStackDepth >= 0 && roomStackDepth < backStack.length) {
    backStack.length = roomStackDepth;
  }
  state.page = roomRoot && PAGES[roomRoot] ? roomRoot : 'home';
  state.routeParams = roomRoot && PAGES[roomRoot] ? roomRootParams : {};
  render({ keepScroll: true });
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
  // 刷新按钮和搜索按钮同排，只在首页出现。
  if (refreshButton) refreshButton.hidden = state.page !== 'home';
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
  if (refreshButton) {
    refreshButton.innerHTML = icon('refresh', 19);
    refreshButton.addEventListener('click', () => homeRefreshHandler?.());
  }
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
  themeButton.innerHTML = icon(themeIcon(state.settings.appearance?.theme || 'dark'), 20);
  themeButton.addEventListener('click', () => {
    const mode = toggleTheme();
    themeButton.innerHTML = icon(themeIcon(mode), 20);
    toast(mode === 'light' ? '已切换到浅色模式' : mode === 'system' ? '已跟随系统主题' : '已切换到深色模式');
    if (state.page === 'settingsDetail') render({ keepScroll: false });
  });
  refreshThemeButton();
}

/// 主题按钮图标：浅色=太阳、深色=月亮、跟随系统=半太阳半月亮。
/// 以前跟随系统用的是齿轮，和左侧「设置」图标太像，容易看错。
function themeIcon(mode) {
  if (mode === 'light') return 'sun';
  if (mode === 'system') return 'contrast';
  return 'moon';
}

function refreshThemeButton() {
  const button = rail.querySelector('[data-action="theme"]');
  if (!button) return;
  const mode = state.settings.appearance?.theme || 'dark';
  button.innerHTML = icon(themeIcon(mode), 20);
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

// 窗口尺寸的合理下限。Windows 允许窗口被拖到最小（约 39×24），
// 一旦把这个退化值存下来，下次启动窗口就几乎看不见了，
// 所以保存与恢复两侧都要钳制。
// 这两个值必须跟 tauri.conf.json 里的 minWidth / minHeight 一致：
// 系统会在更小的尺寸上直接拦住，前端存一个更小的值没有意义。
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

/// 启动时自动拉取 WebDAV 同步包。
/// 只在「云端比本机上次同步更新」时才应用，避免每次启动都用旧包覆盖本机改动；
/// 失败只写控制台，不弹窗打扰（网络不通是常态，手动同步仍然可用）。
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
    importData(bundle);
    state.settings.sync.lastSyncAt = Date.now();
    saveSettings();
    toast('已从云端同步数据', 'success');
    render({ keepScroll: true });
  } catch (error) {
    console.warn('自动拉取云端同步失败', error);
  }
}

function init() {
  // 禁用 WebView 默认右键菜单，避免露出浏览器菜单/刷新等开发项。
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  applyTheme();
  initTitlebar();
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
  // 启动时自动拉取云端同步包（默认关闭，需在设置里显式打开）。
  setTimeout(autoPullSync, 1500);
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
