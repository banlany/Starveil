// 本地状态与持久化：设置、关注、观看记录、搜索历史。
import { ALL_PLATFORMS, api, canonicalImage, roomUrl } from './api.js';
import { IS_MOBILE } from './platform.js';

const SETTINGS_KEY = 'simple-live.settings.v2';
const FOLLOW_KEY = 'simple-live.follow.v2';
const HISTORY_KEY = 'simple-live.history.v2';
const SEARCH_KEY = 'simple-live.search.v2';
const STATS_KEY = 'simple-live.stats.v2';
const LOGIN_PREFIX = 'simple-live.login.v1.';

/// 观看记录上限。导入 dart 的 profile 时单机历史常常超过一千条，
/// 上限太小会静默截掉一大半。
export const HISTORY_LIMIT = 2000;

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
    density: 'comfortable',
    // 仅移动端生效：auto / portrait / landscape（桌面端命令是空实现）。
    orientation: 'auto',
  },
  player: {
    autoFullscreen: false,
    rememberQuality: true,
    // 没记住清晰度时用哪一档：auto 跟随平台、highest 最高、也可按 1080/720/480/流畅 优先。
    // 「记住清晰度」开着时以记住的为准（那才是用户上一次的真实选择）。
    defaultQuality: 'auto',
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
    // 「进入直播间自动全屏」只有一份：`player.autoFullscreen`。
    // 0.6.1 之前这里还有一份 `live.autoFullscreen`，两处各改各的互不影响，
    // 用户改了哪一处都像是「设置没生效」——0.6.2 把这份删掉了。
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
    // 大表情（B 站收藏集那类只能单独发送的）占几行：1~5，1 行 = 一个弹幕轨道高。
    // 行数既决定画多大，也决定轨道算法给它留几条轨道（弹幕层会按它抬高 maxGrade），
    // 所以设成 2 行就真的会空出上下两条轨道，不会盖住旁边的弹幕。
    bigEmojiLines: 2,
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
    perf: 'balanced',
    // 发送弹幕默认关闭：写操作会用账号 Cookie，让用户主动开启。
    sendEnabled: false,
    // 发送弹幕的入口默认**连设置项都不显示**，要在「关于」页连点版本号 7 次
    // 才会解锁（见 docs/hidden-features.md）。这里只存解锁结果。
    sendUnlocked: false,
  },
  follow: {
    autoUpdate: true,
    // 进入关注页时是否自动刷新直播状态。默认关闭：关注几百个主播时
    // 一进页面就打几百个请求，用户没要求就别替他决定。
    autoRefresh: false,
    interval: 10,
    threads: 0,
    pageSize: 200,
  },
  timer: {
    enabled: false,
    minutes: 60,
    // 到点退出后是否顺手把定时关闭关掉。
    // 关着 = 每次启动应用都会重新计时（老行为），开着 = 只生效一次。
    once: false,
  },
  sync: {
    // 同步包里要不要带这两类数据。默认：观看记录跟着走，登录信息不跟——
    // Cookie 一进包，就跟着 WebDAV 的远端文件和局域网里的 HTTP 服务一起裸奔。
    includeHistory: true,
    includeAccounts: false,
    // WebDAV 局域网同步。密码明文存在本机 localStorage（设置页有风险提示），
    // 只在本机使用、不上传任何第三方。
    webdav: {
      url: '',
      path: 'starveil-sync.json',
      username: '',
      password: '',
      insecureTls: false,
      autoPull: false,
    },
    lastSyncAt: 0,
  },
  other: {
    rememberWindow: true,
    log: false,
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
  unlistenDanmakuStatus: null,
};

/// 深合并：对象逐层递归，其它类型（含数组、null）直接覆盖。
///
/// 导出的目的是给导入/同步用——浅展开会让「只带部分字段」的包把整段默认值顶掉，
/// 例如 `{"danmaku": null}` 会让 `settings.danmaku` 变成 null，进房时读
/// `danmaku.enabled` 直接抛 TypeError，整页渲染失败。
export function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // null 不覆盖已有的对象段。localStorage 里某段是 null（旧版本写的、手工改的、
    // 写入被打断）时，如果照直覆盖，后面读 `danmaku.enabled` 就是 TypeError，
    // 整页渲染失败且坏数据会一直留在盘上。
    if (value === null && base[key] && typeof base[key] === 'object') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      output[key] = merge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    stored = {};
  }
  const settings = merge(clone(DEFAULT_SETTINGS), stored);
  // 早期版本把 theme/accent 放在顶层。只在 `appearance` 缺这一项时才回退，
  // 否则落盘的镜像值会把用户刚改好的主题又盖回去。
  if (stored.theme && !stored.appearance?.theme) {
    settings.appearance.theme = stored.theme;
  }
  if (stored.accent && !stored.appearance?.accent) {
    settings.appearance.accent = stored.accent;
  }
  // 0.6.2 删掉的设置项，从落盘数据里清掉，避免导出备份时又把这些死字段带出去。
  delete settings.dynamicColor;
  delete settings.appearance?.dynamicColor;
  // 「进入直播间自动全屏」原先在 live 段里也有一份，从没被读过。老版本改过它的人
  // 升级后会看到开关自己关了，这里把那一次选择补到唯一生效的 player 段上。
  if (stored.live?.autoFullscreen === true && stored.player?.autoFullscreen === undefined) {
    settings.player.autoFullscreen = true;
  }
  delete settings.live?.autoFullscreen;
  return settings;
}

export function saveSettings() {
  // 顶层 theme/accent 只当镜像：每次落盘从 appearance 回填，保证两条路径一致。
  const appearance = state.settings?.appearance;
  if (appearance) {
    state.settings.theme = appearance.theme;
    state.settings.accent = appearance.accent;
  }
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
  // 只有外观类设置需要重算样式（applyTheme 会改 CSS 变量并广播事件，
  // 侧边栏主题按钮也会跟着重建）。拖弹幕不透明度这种滑块时每移动一格都重算，
  // 主线程会被这些无关的 DOM 操作占住，手感明显发涩。
  if (path.startsWith('appearance.')) applyTheme();
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
  syncSystemBar(effective);
  window.dispatchEvent(new CustomEvent('simple-live:theme'));
}

/// 安卓系统栏跟着主题走。
///
/// 取的是 `--bg` 的实际值（深色 #101014 / 浅色 #f5f5f8），与页面背景严丝合缝；
/// 不改的话浅色主题下会顶着一条黑边。只在移动端调，桌面窗口没有系统栏。
const SYSTEM_BAR_COLORS = { dark: '#101014', light: '#f5f5f8' };
let lastSystemBar = '';

function syncSystemBar(effective) {
  if (!IS_MOBILE) return;
  const color = SYSTEM_BAR_COLORS[effective] || SYSTEM_BAR_COLORS.dark;
  const key = `${effective}:${color}`;
  if (key === lastSystemBar) return;
  lastSystemBar = key;
  api.setSystemBar(color, effective === 'light').catch(() => {});
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
  state.history = filtered.slice(0, HISTORY_LIMIT);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  // 进房同时累加统计里的「点进次数」，两处数据保持一致。
  bumpStatsVisit(room);
}

export function saveHistory(list) {
  state.history = (Array.isArray(list) ? list : []).slice(0, HISTORY_LIMIT);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  return state.history;
}

export function clearHistory() {
  state.history = [];
  localStorage.removeItem(HISTORY_KEY);
}

// ---------------------------------------------------------------- 观看统计
//
// 与 history 分开存：history 是「最近看过谁」的列表（会被去重、有上限），
// 统计要的是「每个主播累计看了多久、点进几次」，写的是累加值，
// 混在一起会互相踩。底层粒度只存「按天」，周/月/年由展示层聚合，避免多份冗余。

const STATS_DAY_LIMIT = 400; // 每个主播保留最近 400 天
const STATS_ROOM_LIMIT = 300; // 最多统计 300 个主播
const STATS_BYTE_BUDGET = 2.4 * 1024 * 1024; // localStorage 单域约 5MB，留出余量

function statsKey(platform, roomId) {
  return `${platform}:${roomId}`;
}

/// 本地时区的「日」键，不能用 toISOString（那是 UTC，跨时区会把凌晨的观看算到前一天）。
export function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyStats() {
  return { v: 1, rooms: {} };
}

export function loadStats() {
  try {
    const data = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (data && typeof data === 'object' && data.rooms && typeof data.rooms === 'object') return data;
  } catch {
    /* 损坏时重建 */
  }
  return emptyStats();
}

/// 裁剪：先按天保留窗口，再按主播数上限淘汰最久没看的。
function trimStats(stats) {
  const cutoff = Date.now() - STATS_DAY_LIMIT * 86400000;
  for (const entry of Object.values(stats.rooms)) {
    for (const day of Object.keys(entry.daily || {})) {
      const timestamp = Date.parse(`${day}T00:00:00`);
      if (Number.isNaN(timestamp) || timestamp < cutoff) delete entry.daily[day];
    }
  }
  const keys = Object.keys(stats.rooms);
  if (keys.length > STATS_ROOM_LIMIT) {
    keys
      .sort((a, b) => (Number(stats.rooms[b].last_at) || 0) - (Number(stats.rooms[a].last_at) || 0))
      .slice(STATS_ROOM_LIMIT)
      .forEach((key) => delete stats.rooms[key]);
  }
}

function saveStats(stats) {
  trimStats(stats);
  let text = JSON.stringify(stats);
  // 极端情况下（几百个主播 × 400 天）体积仍可能顶到上限，按最久未看逐个丢弃再试。
  while (text.length > STATS_BYTE_BUDGET) {
    const oldest = Object.keys(stats.rooms).sort(
      (a, b) => (Number(stats.rooms[a].last_at) || 0) - (Number(stats.rooms[b].last_at) || 0)
    )[0];
    if (!oldest) break;
    delete stats.rooms[oldest];
    text = JSON.stringify(stats);
  }
  try {
    localStorage.setItem(STATS_KEY, text);
  } catch {
    /* 空间不足时放弃本次统计写入，不影响播放 */
  }
}

function ensureStatsRoom(stats, room) {
  const key = statsKey(room.platform, room.room_id);
  let entry = stats.rooms[key];
  if (!entry) {
    entry = {
      platform: room.platform,
      room_id: String(room.room_id),
      user_name: '',
      cover: '',
      total_ms: 0,
      visits: 0,
      last_at: 0,
      daily: {},
    };
    stats.rooms[key] = entry;
  }
  // 主播改名/换封面时让统计里的展示信息跟上，历史数据不回溯。
  if (room.user_name) entry.user_name = room.user_name;
  const cover = canonicalImage(room.cover || room.avatar || '');
  if (cover) entry.cover = cover;
  return entry;
}

/// 进房一次：点进次数 +1（按天也记一份）。
export function bumpStatsVisit(room) {
  if (!room?.platform || !room?.room_id) return;
  const stats = loadStats();
  const entry = ensureStatsRoom(stats, room);
  const now = Date.now();
  entry.visits = (Number(entry.visits) || 0) + 1;
  entry.last_at = now;
  const day = dayKey(now);
  if (!entry.daily[day]) entry.daily[day] = { ms: 0, visits: 0 };
  entry.daily[day].visits += 1;
  saveStats(stats);
}

/// 累加一次观看时长（毫秒）。不足 1 秒的碎片不计，避免心跳把噪声写进统计。
export function addWatchTime(platform, roomId, ms) {
  const value = Math.round(Number(ms) || 0);
  if (!platform || !roomId || value < 1000) return;
  const stats = loadStats();
  const entry = stats.rooms[statsKey(platform, roomId)];
  // 没有进房记录说明 history 被清过，这里不新建条目——统计只跟随真实访问。
  if (!entry) return;
  const now = Date.now();
  entry.total_ms = (Number(entry.total_ms) || 0) + value;
  entry.last_at = now;
  const day = dayKey(now);
  if (!entry.daily[day]) entry.daily[day] = { ms: 0, visits: 0 };
  entry.daily[day].ms = (Number(entry.daily[day].ms) || 0) + value;
  saveStats(stats);
}

export function clearStats() {
  localStorage.removeItem(STATS_KEY);
}

export const STATS_RANGES = [
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '今年' },
  { value: 'all', label: '全部' },
];

/// 时间范围的起点（本地零点）。week 按周一起算，和国内习惯一致。
export function statsRangeStart(range, now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (range === 'week') {
    const offset = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - offset);
    return date.getTime();
  }
  if (range === 'month') return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  if (range === 'year') return new Date(date.getFullYear(), 0, 1).getTime();
  return 0;
}

/**
 * 聚合出某个时间范围下的统计。
 * @returns {{range:string,start:number,totalMs:number,totalVisits:number,activeDays:number,rooms:Array}}
 */
export function aggregateStats(range = 'all', now = Date.now()) {
  const stats = loadStats();
  const start = statsRangeStart(range, now);
  const activeDays = new Set();
  const rooms = [];
  let totalMs = 0;
  let totalVisits = 0;
  for (const entry of Object.values(stats.rooms)) {
    let ms = 0;
    let visits = 0;
    for (const [day, bucket] of Object.entries(entry.daily || {})) {
      const timestamp = Date.parse(`${day}T00:00:00`);
      if (Number.isNaN(timestamp) || timestamp < start) continue;
      const dayMs = Number(bucket?.ms) || 0;
      const dayVisits = Number(bucket?.visits) || 0;
      if (!dayMs && !dayVisits) continue;
      ms += dayMs;
      visits += dayVisits;
      activeDays.add(day);
    }
    if (!ms && !visits) continue;
    totalMs += ms;
    totalVisits += visits;
    rooms.push({
      platform: entry.platform,
      room_id: entry.room_id,
      user_name: entry.user_name || '',
      cover: entry.cover || '',
      ms,
      visits,
      // 有范围内观看记录才算「最近」，否则按进房时间兜底。
      last_at: Number(entry.last_at) || 0,
    });
  }
  rooms.sort((a, b) => b.ms - a.ms || b.visits - a.visits);
  return { range, start, totalMs, totalVisits, activeDays: activeDays.size, rooms };
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

/// 导出/同步要用到的完整搜索历史（`state.search.recent` 与落盘同源，这里只是给调用方一份拷贝）。
export function loadSearchHistory() {
  return loadSearch();
}

/// 导入时整段替换搜索历史。仍然按 12 条上限截断，避免外部包把列表撑爆。
export function replaceSearchHistory(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 12);
  state.search.recent = cleaned;
  if (cleaned.length) localStorage.setItem(SEARCH_KEY, JSON.stringify(cleaned));
  else localStorage.removeItem(SEARCH_KEY);
  return cleaned.length;
}

/// 导入时整段替换观看统计。只认结构对的包：`{v:1, rooms:{...}}`，
/// 其它一律当空，避免一个坏包把统计写成一堆读不出来的东西。
/// 写之前仍走 `saveStats` 的裁剪与体积保护——统计本来就是最容易顶到 5MB 上限的一项。
export function replaceStats(stats) {
  if (!stats || typeof stats !== 'object' || !stats.rooms || typeof stats.rooms !== 'object') {
    return 0;
  }
  const rooms = {};
  for (const [key, entry] of Object.entries(stats.rooms)) {
    if (!entry || typeof entry !== 'object') continue;
    const platform = String(entry.platform || '').trim();
    const roomId = String(entry.room_id ?? '').trim();
    if (!platform || !roomId) continue;
    const daily = {};
    for (const [day, value] of Object.entries(entry.daily || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object') continue;
      daily[day] = { ms: Math.max(0, Number(value.ms) || 0), visits: Math.max(0, Number(value.visits) || 0) };
    }
    rooms[`${platform}:${roomId}`] = {
      platform,
      room_id: roomId,
      user_name: String(entry.user_name || ''),
      cover: String(entry.cover || ''),
      total_ms: Math.max(0, Number(entry.total_ms) || 0),
      visits: Math.max(0, Number(entry.visits) || 0),
      last_at: Math.max(0, Number(entry.last_at) || 0),
      daily,
    };
  }
  const next = { v: 1, rooms };
  saveStats(next);
  return Object.keys(rooms).length;
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
