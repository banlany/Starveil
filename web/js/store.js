// 本地状态与持久化：设置、关注、观看记录、搜索历史。
import { api, canonicalImage, roomUrl } from './api.js';
import { setIconOverrides } from './icons.js';
import { IS_MOBILE } from './platform.js';
import { DEFAULT_SKIN_ID, SKINS, accentForMode, getSkin, skinAccent, skinAccents, skinHref, skinModes } from '../skins/registry.js';

const SETTINGS_KEY = 'simple-live.settings.v2';
const FOLLOW_KEY = 'simple-live.follow.v2';
const HISTORY_KEY = 'simple-live.history.v2';
const SEARCH_KEY = 'simple-live.search.v2';
const STATS_KEY = 'simple-live.stats.v2';
const LOGIN_PREFIX = 'simple-live.login.v1.';

/// 观看记录上限；导入 dart profile 时历史可能超过一千条。
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

/// 参与备份/同步的登录平台，须与设置页 canLogin 的平台一致。
export const ACCOUNT_PLATFORMS = ['bilibili', 'douyu', 'douyin', 'kuaishou'];

/// 收集本机已登录的平台，供“导出备份”使用。
export function collectAccounts() {
  const accounts = {};
  for (const platform of ACCOUNT_PLATFORMS) {
    const login = loadLogin(platform);
    if (login?.cookie) accounts[platform] = login;
  }
  return accounts;
}

export function clearLogin(platform) {
  localStorage.removeItem(LOGIN_PREFIX + platform);
}

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  // 顶层只是镜像，saveSettings 每次从 appearance 回填。
  accent: skinAccent(DEFAULT_SKIN_ID),
  disclaimerAccepted: false,
  firstRun: true,
  home: {
    platform: 'bilibili',
    cardSize: 'medium',
    autoRefresh: true,
    showMore: true,
  },
  appearance: {
    // 皮肤：配色风格，独立于明暗。清单见 web/skins/registry.js。
    skin: DEFAULT_SKIN_ID,
    theme: 'dark',
    // 主题色：默认取皮肤 accents 的第一个（皮肤不绑死某个品牌色）。
    accent: skinAccent(DEFAULT_SKIN_ID),
    // 主题色是否跟随皮肤；用户自选后不再被皮肤覆盖。
    accentSource: 'skin',
    density: 'comfortable',
    // 仅移动端生效：auto / portrait / landscape（桌面端命令是空实现）。
    orientation: 'auto',
  },
  player: {
    autoFullscreen: false,
    rememberQuality: true,
    // 默认清晰度：auto / highest / 1080 / 720 / 480 / smooth；开启「记住清晰度」时以记住的为准。
    defaultQuality: 'auto',
    hardwareDecode: true,
    // 多显卡设备上强制使用独立显卡渲染；重启后生效，真实状态以标记文件为准。
    highPerformanceGpu: false,
    muteOnStart: false,
    autoSwitchLine: true,
    autoRefresh: true,
    showStats: false,
    // 缓冲档位：low 低延迟 / normal 标准 / smooth 流畅优先（见 player-buffer.js）。
    buffer: 'normal',
    scaleMode: 'contain',
    forceHttps: true,
    superChatOverlay: false,
    superChatAutoRemove: true,
    // 悬浮层新卡的初始折叠状态。
    superChatFold: true,
    // 浮动卡停留时长是否按金额均衡化到 [5s, superChatMax]。
    superChatBalance: true,
    // 均衡化时的上限（秒）。只有 15 / 20 两档。
    superChatMax: 20,
  },
  live: {
    // 进入直播间自动全屏。
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
    // 弹幕帧率上限，0 表示跟随屏幕。
    fps: 0,
    emoji: true,
    // 大表情占几行（1~5），同时决定绘制高度与占用的轨道数。
    bigEmojiLines: 2,
    // 按内容去重，默认关闭。
    dedupe: false,
    dedupeMode: 'content',
    dedupeWindow: 10,
    dedupeStep: 2,
    block: false,
    blockKeywords: '',
    safeTop: 8,
    safeBottom: 8,
    perf: 'balanced',
    // 发送弹幕默认关闭：写操作会用账号 Cookie，让用户主动开启。
    sendEnabled: false,
    // 发送弹幕的解锁结果；设置项在解锁前不显示。
    sendUnlocked: false,
  },
  follow: {
    // 进入关注页时是否自动刷新直播状态，默认关闭。
    autoRefresh: false,
    threads: 0,
    pageSize: 200,
    // 关注页排序窗口（天）。7 = 近 7 天进房次数，0 = 用累计次数。
    sortWindow: 7,
  },
  timer: {
    enabled: false,
    minutes: 60,
    // 定时关闭到点后是否自动关闭该功能。
    once: false,
  },
  sync: {
    // 同步包是否包含观看记录与登录信息（Cookie）。
    includeHistory: true,
    includeAccounts: false,
    // WebDAV 配置；密码明文存于本机 localStorage。
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
  // 关注页筛选条件：标签 + 状态/平台 + 关键词。
  followFilter: { mode: 'status', status: 'all', platform: 'all', tag: 'all', keyword: '' },
  followView: 'grid',
  history: loadHistory(),
  settings: loadSettings(),
  unlistenDanmaku: null,
  unlistenDanmakuStatus: null,
};

/// 深合并：对象逐层递归，其它类型（含数组、null）直接覆盖。
export function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // null 不覆盖已有的对象段，避免读字段时抛 TypeError。
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

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    stored = {};
  }
  const settings = merge(clone(DEFAULT_SETTINGS), stored);
  // 兼容顶层的 theme/accent，仅在 appearance 缺该项时回退。
  if (stored.theme && !stored.appearance?.theme) {
    settings.appearance.theme = stored.theme;
  }
  if (stored.accent && !stored.appearance?.accent) {
    settings.appearance.accent = stored.accent;
  }
  // 旧数据落到默认皮肤；非默认强调色标记为用户自选。
  if (!stored.appearance?.skin) {
    settings.appearance.skin = DEFAULT_SKIN_ID;
  }
  settings.appearance.skin = getSkin(settings.appearance.skin).id;
  const bakedAccent = skinAccent(settings.appearance.skin);
  if (!settings.appearance.accentSource) {
    settings.appearance.accentSource = settings.appearance.accent === bakedAccent ? 'skin' : 'user';
  }
  // 清掉已删除的设置项，避免随备份导出。
  delete settings.dynamicColor;
  delete settings.appearance?.dynamicColor;
  // 兼容 live.autoFullscreen，迁移到 player 段。
  if (stored.live?.autoFullscreen === true && stored.player?.autoFullscreen === undefined) {
    settings.player.autoFullscreen = true;
  }
  delete settings.live?.autoFullscreen;
  // 清理已移除的 danmaku.blockUsers。
  delete settings.danmaku?.blockUsers;
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
  // 用户亲手挑了强调色：从此切皮肤不再覆盖它。
  if (path === 'appearance.accent') {
    if (!state.settings.appearance) state.settings.appearance = {};
    state.settings.appearance.accentSource = 'user';
  }
  saveSettings();
  // 只有外观类设置触发 applyTheme 重算样式。
  if (path.startsWith('appearance.')) applyTheme();
  return value;
}

export function resetSettings() {
  state.settings = clone(DEFAULT_SETTINGS);
  saveSettings();
  applyTheme();
}

/// 皮肤清单：设置页只读，不要在别处再维护一份。
export { SKINS };

/// 写入主题色；`followSkin` 为真表示跟随皮肤默认色。
export function setAccent(color, followSkin = false) {
  const appearance = state.settings.appearance;
  appearance.accent = color;
  appearance.accentSource = followSkin ? 'skin' : 'user';
  saveSettings();
  applyTheme();
}

/// 当前生效的皮肤定义。
export function currentSkin() {
  return getSkin(state.settings.appearance?.skin);
}

/// 皮肤实际使用的主题色原值：只有该皮肤提供多个可选色时才认用户自选。
function resolveAccentValue(skin, appearance) {
  return appearance.accentSource === 'user' && appearance.accent && skinAccents(skin.id).length > 1
    ? appearance.accent
    : skinAccent(skin.id);
}

/// 当前皮肤正在用的主题色原值（不换算明暗档）。
export function currentAccentValue() {
  const appearance = state.settings.appearance || {};
  return resolveAccentValue(getSkin(appearance.skin), appearance);
}

/// 当前皮肤正在用的主题色（按 <html data-theme> 换算过）。
export function currentAccent() {
  const mode = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return accentForMode(currentAccentValue(), mode);
}

/// 皮肤是否锁死了明暗（只提供一套配色）。
export function skinLockedMode() {
  const modes = skinModes(currentSkin().id);
  return modes.length === 1 ? modes[0] : '';
}

/// 切皮肤：换样式表与图标表，最后交给 applyTheme 重算。
export async function applySkin(id) {
  const skin = getSkin(id);
  const appearance = state.settings.appearance;
  appearance.skin = skin.id;
  ensureSkinStyle(skin.id);
  // 图标先换好再重画：反过来的话调用方拿到的还是上一套皮肤的图形。
  await loadSkinIcons(skin.id);
  saveSettings();
  applyTheme();
  return skin;
}

/// 加载皮肤图标覆盖表；失败时退回基础表。
export async function loadSkinIcons(id = currentSkin().id) {
  const skin = getSkin(id);
  if (!skin.icons) {
    setIconOverrides(null);
    return;
  }
  try {
    const mod = await import(`../skins/${skin.id}/icons.js`);
    setIconOverrides(mod.ICON_PATHS || mod.default || null);
  } catch (error) {
    console.warn('皮肤图标表加载失败，沿用默认图标：', skin.id, error);
    setIconOverrides(null);
  }
}

/// 换皮肤样式表 href。
function ensureSkinStyle(id) {
  const href = skinHref(id);
  let link = document.getElementById('skin-css');
  if (!link) {
    link = document.createElement('link');
    link.id = 'skin-css';
    link.rel = 'stylesheet';
    const first = document.querySelector('link[rel="stylesheet"]');
    document.head.insertBefore(link, first || null);
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/// 把皮肤的变量真正落到 `<html>` 上：皮肤 → 明暗 → 强调色。
export function applyTheme() {
  const appearance = state.settings.appearance || {};
  const skin = getSkin(appearance.skin);
  const modes = skinModes(skin.id);
  const mode = appearance.theme || 'dark';
  const systemLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  let effective = mode === 'system' ? (systemLight ? 'light' : 'dark') : mode;
  // 皮肤只提供一套配色时以皮肤为准：设置里存着浅色也不能把皮肤渲染成深色。
  if (!modes.includes(effective)) effective = modes[0];

  const root = document.documentElement;
  if (root.dataset.skin !== skin.id) root.dataset.skin = skin.id;
  root.dataset.theme = effective;
  root.dataset.themeMode = mode;

  // 存原值，落到 DOM 时按当前明暗档换算。
  const accent = accentForMode(resolveAccentValue(skin, appearance), effective);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-soft', hexToAlpha(accent, effective === 'light' ? 0.18 : 0.16));
  // 压在强调色上的文字颜色，每次 applyTheme 重算。
  root.style.setProperty('--accent-on', isLightColor(accent) ? '#15151b' : '#ffffff');

  // 标题栏底色与安卓系统栏跟随 --bg；取不到值时不设置。
  const bg = readVar('--bg');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (bg && meta) meta.setAttribute('content', bg);
  if (bg) syncSystemBar(effective, bg);
  rememberBootPaint(effective, skin.id);
  window.dispatchEvent(new CustomEvent('simple-live:theme'));
}

/// 读一个 CSS 变量的当前计算值（皮肤文件是唯一来源）。
function readVar(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || '';
}

/// 安卓系统栏跟随 --bg；仅移动端调用。
let lastSystemBar = '';

function syncSystemBar(effective, color) {
  if (!IS_MOBILE) return;
  const key = `${effective}:${color}`;
  if (key === lastSystemBar) return;
  lastSystemBar = key;
  api.setSystemBar(color, effective === 'light').catch(() => {});
}

/// 首帧预涂缓存（theme / skin），供 index.html 内联脚本读取，不参与备份与同步。
const BOOT_KEY = 'starveil.boot.v1';

function rememberBootPaint(theme, skin) {
  try {
    const prev = localStorage.getItem(BOOT_KEY);
    const next = JSON.stringify({ theme, skin });
    if (prev !== next) localStorage.setItem(BOOT_KEY, next);
  } catch {
    /* 隐私模式/配额满：只是丢一次预涂，不影响功能 */
  }
}

export function toggleTheme() {
  const modes = skinModes(currentSkin().id);
  const order = modes.length > 1 ? ['dark', 'light', 'system'] : modes;
  const current = state.settings.appearance?.theme || 'dark';
  const next = order[(order.indexOf(current) + 1) % order.length] || order[0];
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

/// 是否需要用深色文字：按 WCAG 相对亮度判断，阈值 0.40。
function isLightColor(hex) {
  const normalized = String(hex).replace('#', '');
  const full =
    normalized.length === 3
      ? normalized.split('').map((char) => char + char).join('')
      : normalized;
  if (full.length !== 6) return false;
  const channel = (value) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(full.slice(0, 2), 16));
  const g = channel(parseInt(full.slice(2, 4), 16));
  const b = channel(parseInt(full.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
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
// 与 history 分开存；底层只记按天的累加值，周/月/年由展示层聚合。

const STATS_DAY_LIMIT = 400; // 每个主播保留最近 400 天
const STATS_ROOM_LIMIT = 300; // 最多统计 300 个主播
const STATS_BYTE_BUDGET = 2.4 * 1024 * 1024; // localStorage 单域约 5MB，留出余量

function statsKey(platform, roomId) {
  return `${platform}:${roomId}`;
}

/// 本地时区的「日」键，不能用 toISOString（那是 UTC，跨时区会把凌晨的观看算到前一天）。
function dayKey(timestamp = Date.now()) {
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
function bumpStatsVisit(room) {
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
function statsRangeStart(range, now = Date.now()) {
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

/// 最近 `days` 天每个房间的进房次数，返回 `Map<platform:roomId, 次数>`。
export function recentVisitCounts(days = 7, now = Date.now()) {
  const windowDays = Math.max(1, Math.floor(Number(days) || 7));
  const cutoff = now - windowDays * 86400000;
  const counts = new Map();
  const stats = loadStats();
  for (const [key, entry] of Object.entries(stats.rooms)) {
    let visits = 0;
    for (const [day, bucket] of Object.entries(entry.daily || {})) {
      const timestamp = Date.parse(`${day}T00:00:00`);
      // 按「日」存的数据：cutoff 当天整天计入，否则近 7 天会少一天。
      if (Number.isNaN(timestamp) || timestamp + 86400000 <= cutoff) continue;
      visits += Number(bucket?.visits) || 0;
    }
    if (visits > 0) counts.set(key, visits);
  }
  return counts;
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

/// 导入/同步观看统计：按房间、按天合并，冲突字段取较大值。
/// 只接受 `{v:1, rooms:{...}}` 结构，写入前走 saveStats 的裁剪与体积保护。
export function mergeStats(stats) {
  if (!stats || typeof stats !== 'object' || !stats.rooms || typeof stats.rooms !== 'object') {
    return 0;
  }
  const merged = loadStats();
  let touched = 0;
  for (const [rawKey, entry] of Object.entries(stats.rooms)) {
    if (!entry || typeof entry !== 'object') continue;
    const platform = String(entry.platform || '').trim();
    const roomId = String(entry.room_id ?? '').trim();
    if (!platform || !roomId) continue;
    const key = statsKey(platform, roomId);
    const target = merged.rooms[key] || {
      platform,
      room_id: roomId,
      user_name: '',
      cover: '',
      total_ms: 0,
      visits: 0,
      last_at: 0,
      daily: {},
    };
    target.user_name = String(entry.user_name || '') || target.user_name;
    target.cover = String(entry.cover || '') || target.cover;
    target.total_ms = Math.max(Number(target.total_ms) || 0, Number(entry.total_ms) || 0);
    target.visits = Math.max(Number(target.visits) || 0, Number(entry.visits) || 0);
    target.last_at = Math.max(Number(target.last_at) || 0, Number(entry.last_at) || 0);
    for (const [day, value] of Object.entries(entry.daily || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== 'object') continue;
      const current = target.daily[day] || { ms: 0, visits: 0 };
      target.daily[day] = {
        ms: Math.max(Number(current.ms) || 0, Math.max(0, Number(value.ms) || 0)),
        visits: Math.max(Number(current.visits) || 0, Math.max(0, Number(value.visits) || 0)),
      };
    }
    merged.rooms[key] = target;
    touched += 1;
  }
  saveStats(merged);
  return touched;
}
