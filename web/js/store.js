// 本地状态与持久化：设置、关注、观看记录、搜索历史。
import { ALL_PLATFORMS, canonicalImage, roomUrl } from './api.js';

const SETTINGS_KEY = 'simple-live.settings.v2';
const FOLLOW_KEY = 'simple-live.follow.v2';
const HISTORY_KEY = 'simple-live.history.v2';
const SEARCH_KEY = 'simple-live.search.v2';
const LOGIN_PREFIX = 'simple-live.login.v1.';

export function loadLogin(platform) {
  try {
    return JSON.parse(localStorage.getItem(LOGIN_PREFIX + platform) || 'null');
  } catch {
    return null;
  }
}

export function saveLogin(platform, data) {
  localStorage.setItem(LOGIN_PREFIX + platform, JSON.stringify(data));
}

/// 参与备份的登录平台（虎牙目前不支持登录）。
export const ACCOUNT_PLATFORMS = ['bilibili', 'douyu'];

/// 收集本机已登录的平台，供“导出备份”使用。
export function collectAccounts() {
  const accounts = {};
  for (const platform of ACCOUNT_PLATFORMS) {
    const login = loadLogin(platform);
    if (login?.cookie) accounts[platform] = login;
  }
  return accounts;
}

/// 还原备份里的登录信息；返回需要重新注入后端的平台列表。
export function restoreAccounts(accounts) {
  const restored = [];
  for (const platform of ACCOUNT_PLATFORMS) {
    const login = accounts?.[platform];
    if (!login?.cookie) continue;
    saveLogin(platform, login);
    restored.push(platform);
  }
  return restored;
}

export function clearLogin(platform) {
  localStorage.removeItem(LOGIN_PREFIX + platform);
}

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  accent: '#fb7299',
  dynamicColor: false,
  disclaimerAccepted: false,
  firstRun: true,
  home: {
    platform: 'bilibili',
    cardSize: 'medium',
    autoRefresh: true,
    showMore: true,
  },
  appearance: {
    theme: 'dark',
    accent: '#fb7299',
    dynamicColor: false,
    density: 'comfortable',
  },
  player: {
    autoFullscreen: false,
    rememberQuality: true,
    hardwareDecode: true,
    muteOnStart: false,
    autoSwitchLine: true,
    autoRefresh: true,
    showStats: false,
    scaleMode: 'contain',
    forceHttps: true,
    superChatOverlay: false,
    superChatAutoRemove: true,
  },
  live: {
    autoFullscreen: false,
    autoSwitchNext: false,
    allowBackground: true,
    gesture: true,
    hideDanmakuOnMinimize: false,
  },
  danmaku: {
    enabled: true,
    area: 40, // 顶部显示区域，占播放器高度百分比
    lines: 10,
    font: 20,
    weight: 700,
    speed: 8, // 弹幕持续秒数
    opacity: 95,
    stroke: true,
    strokeWidth: 2,
    fps: 60,
    emoji: true,
    dedupe: true,
    dedupeMode: 'content',
    dedupeWindow: 10,
    dedupeStep: 2,
    block: false,
    blockKeywords: '',
    blockUsers: '',
    showEvents: false,
    safeTop: 8,
    safeBottom: 8,
    delay: 0,
  },
  follow: {
    autoUpdate: true,
    interval: 10,
    threads: 0,
    pageSize: 200,
  },
  timer: {
    enabled: false,
    minutes: 60,
  },
  other: {
    rememberWindow: true,
    log: false,
    closeToTray: true,
  },
};

export const state = {
  page: 'home',
  platform: 'bilibili',
  previous: null,
  detailKey: null,
  categoryRoomsContext: null,
  home: { items: [], page: 0, loading: false, done: false, error: '', loadedAt: 0 },
  category: { tree: [], expanded: {}, loading: false, error: '' },
  categoryRooms: { items: [], page: 0, loading: false, done: false, title: '', parentId: '', subId: '', error: '' },
  search: { keyword: '', mode: 'room', results: [], anchors: [], loading: false, error: '', recent: loadSearch() },
  room: null,
  // followFilter 统一描述关注页的全部筛选条件：
  // 标签 + 状态/平台 + 搜索关键词。右上角计数永远等于这三条同时生效后的结果数。
  followFilter: { mode: 'status', status: 'all', platform: 'all', tag: 'all', keyword: '' },
  followView: 'grid',
  history: loadHistory(),
  settings: loadSettings(),
  unlistenDanmaku: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      output[key] = merge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    stored = {};
  }
  const settings = merge(clone(DEFAULT_SETTINGS), stored);
  // 兼容旧键
  if (stored.theme) {
    settings.appearance.theme = stored.theme;
    settings.theme = stored.theme;
  }
  if (stored.accent) {
    settings.appearance.accent = stored.accent;
    settings.accent = stored.accent;
  }
  return settings;
}

export function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

export function getSetting(path, fallback = undefined) {
  let node = state.settings;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return fallback;
    node = node[part];
  }
  return node ?? fallback;
}

export function setSetting(path, value) {
  const parts = path.split('.');
  let node = state.settings;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!node[parts[index]] || typeof node[parts[index]] !== 'object') node[parts[index]] = {};
    node = node[parts[index]];
  }
  node[parts.at(-1)] = value;
  saveSettings();
  applyTheme();
  return value;
}

export function resetSettings() {
  state.settings = clone(DEFAULT_SETTINGS);
  saveSettings();
  applyTheme();
}

const ACCENTS = ['#EF5350', '#3498db', '#F06292', '#9575CD', '#26C6DA', '#26A69A', '#FFF176', '#FF9800'];

export { ACCENTS };

export function applyTheme() {
  const mode = state.settings.appearance?.theme || 'dark';
  const systemLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const effective = mode === 'system' ? (systemLight ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = effective;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.setProperty('--accent', state.settings.appearance?.accent || '#fb7299');
  document.documentElement.style.setProperty('--accent-soft', hexToAlpha(state.settings.appearance?.accent || '#fb7299', 0.16));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effective === 'light' ? '#ffffff' : '#101014');
  window.dispatchEvent(new CustomEvent('simple-live:theme'));
}

export function toggleTheme() {
  const order = ['dark', 'light', 'system'];
  const current = state.settings.appearance?.theme || 'dark';
  const next = order[(order.indexOf(current) + 1) % order.length];
  state.settings.appearance.theme = next;
  state.settings.theme = next;
  saveSettings();
  applyTheme();
  return next;
}

function hexToAlpha(hex, alpha) {
  const normalized = String(hex).replace('#', '');
  if (normalized.length !== 6) return `rgba(251,114,153,${alpha})`;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------------------------------------------------------------- 关注

export function loadFollow() {
  try {
    const list = JSON.parse(localStorage.getItem(FOLLOW_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveFollow(list) {
  localStorage.setItem(FOLLOW_KEY, JSON.stringify(list));
}

export function followKey(platform, roomId) {
  return `${platform}:${roomId}`;
}

export function isFollowing(platform, roomId) {
  return loadFollow().some((item) => followKey(item.platform, item.room_id) === followKey(platform, roomId));
}

export function toggleFollow(room) {
  const list = loadFollow();
  const key = followKey(room.platform, room.room_id);
  const index = list.findIndex((item) => followKey(item.platform, item.room_id) === key);
  if (index >= 0) {
    list.splice(index, 1);
    saveFollow(list);
    return false;
  }
  list.unshift({
    platform: room.platform,
    room_id: String(room.room_id),
    user_name: room.user_name || '',
    title: room.title || '',
    avatar: canonicalImage(room.avatar || room.cover || ''),
    cover: canonicalImage(room.cover || ''),
    online: Number(room.online) || 0,
    live: Boolean(room.live),
    area: room.area || '',
    url: room.url || roomUrl(room.platform, room.room_id),
    tag: room.tag || '默认',
    added_at: Date.now(),
  });
  saveFollow(list);
  return true;
}

export function updateFollow(platform, roomId, patch) {
  const list = loadFollow();
  const index = list.findIndex((item) => followKey(item.platform, item.room_id) === followKey(platform, roomId));
  if (index >= 0) {
    list[index] = { ...list[index], ...patch };
    saveFollow(list);
  }
  return list;
}

/// 记录一次进房：关注列表里的主播累加点击次数与最近访问时间，用于关注页排序。
export function touchFollowVisit(platform, roomId) {
  const list = loadFollow();
  const index = list.findIndex((item) => followKey(item.platform, item.room_id) === followKey(platform, roomId));
  if (index < 0) return;
  list[index].clicks = (Number(list[index].clicks) || 0) + 1;
  list[index].lastVisit = Date.now();
  saveFollow(list);
}

export function removeFollow(platform, roomId) {
  const list = loadFollow().filter((item) => followKey(item.platform, item.room_id) !== followKey(platform, roomId));
  saveFollow(list);
  return list;
}

// ---------------------------------------------------------------- 历史

export function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function recordHistory(room) {
  const list = loadHistory();
  const key = followKey(room.platform, room.room_id);
  const filtered = list.filter((item) => followKey(item.platform, item.room_id) !== key);
  filtered.unshift({
    platform: room.platform,
    room_id: String(room.room_id),
    title: room.title || '',
    user_name: room.user_name || '',
    cover: canonicalImage(room.cover || ''),
    online: Number(room.online) || 0,
    area: room.area || '',
    watched_at: Date.now(),
  });
  state.history = filtered.slice(0, 1000);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
}

export function clearHistory() {
  state.history = [];
  localStorage.removeItem(HISTORY_KEY);
}

// ---------------------------------------------------------------- 搜索历史

function loadSearch() {
  try {
    const list = JSON.parse(localStorage.getItem(SEARCH_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addSearchHistory(keyword) {
  const value = keyword.trim();
  if (!value) return;
  const list = [value, ...state.search.recent.filter((item) => item !== value)].slice(0, 12);
  state.search.recent = list;
  localStorage.setItem(SEARCH_KEY, JSON.stringify(list));
}

export function clearSearchHistory() {
  state.search.recent = [];
  localStorage.removeItem(SEARCH_KEY);
}

// ---------------------------------------------------------------- 其他

export function nextPlatform(current, delta = 1) {
  const list = ALL_PLATFORMS;
  const index = list.indexOf(current);
  return list[(index + delta + list.length) % list.length];
}

export function acceptDisclaimer() {
  state.settings.disclaimerAccepted = true;
  state.settings.firstRun = false;
  saveSettings();
}
