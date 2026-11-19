// 外部数据导入与同步包构建。
// 支持的输入：dart_simple_live profile、starveil 备份、中立同步包。

import { canonicalImage, ENABLED_PLATFORMS, normalizePlatform, roomUrl } from './api.js';
import {
  ACCOUNT_PLATFORMS,
  clone,
  collectAccounts,
  followKey,
  HISTORY_LIMIT,
  loadFollow,
  loadHistory,
  loadSearchHistory,
  loadStats,
  merge,
  replaceSearchHistory,
  mergeStats,
  saveFollow,
  saveHistory,
  saveLogin,
  saveSettings,
  setSetting,
  state,
} from './store.js';

const DART_SCHEMA = 'simple_live_profile';
/// 同步包版本号；v2 起含搜索历史与观看统计。
const BUNDLE_VERSION = 2;
/// 清单里显示的平台名，只用于文案。真正决定带谁的是 store 的 ACCOUNT_PLATFORMS。
const PLATFORM_LABELS = {
  bilibili: '哔哩哔哩',
  douyu: '斗鱼',
  douyin: '抖音',
  kuaishou: '快手',
  huya: '虎牙',
};

/// 同步包内容清单，设置页据此渲染说明；增删字段时同步修改。
export function bundleScope() {
  const { includeHistory, includeAccounts } = bundleOptions();
  const included = ['设置（不含 WebDAV 口令）', '关注列表'];
  if (includeHistory) included.push('观看记录');
  included.push('搜索历史', '观看统计');
  // 平台名从 ACCOUNT_PLATFORMS 派生。
  const accountNames = ACCOUNT_PLATFORMS.map((platform) => PLATFORM_LABELS[platform] || platform).join(' / ');
  if (includeAccounts) included.push(`登录 Cookie（${accountNames}）`);

  const excluded = [
    // 凭据：WebDAV 口令永远不进包，它本身是上传通道的钥匙。
    'WebDAV 口令',
    // 首次运行状态：换个设备就该各自确认一次免责声明，包不替对方做决定。
    '首次运行状态（免责声明确认）',
    // 跟物理设备绑定：窗口位置搬到手机上没有意义，聊天栏宽度换屏就错位。
    '窗口位置与大小、聊天栏宽度',
    // 按平台记的「第几档清晰度」：桌面存 1080 搬到手机上会直接卡死。
    '各平台记住的清晰度',
  ];
  // 自己关掉的两项排在前面，免得用户以为漏了。
  if (!includeAccounts) excluded.unshift('登录 Cookie（已关闭）');
  if (!includeHistory) excluded.unshift('观看记录（已关闭）');
  return { included, excluded };
}

/// 读当前设置里的同步取舍。默认值写在这里，设置页只负责翻开关。
function bundleOptions() {
  const sync = state.settings?.sync ?? {};
  return {
    // 观看记录默认跟着走，只有显式关掉才不带。
    includeHistory: sync.includeHistory !== false,
    // Cookie 默认不带，需用户显式开启。
    includeAccounts: sync.includeAccounts === true,
  };
}

/// 参与同步与导出的本机数据（中立格式，驼峰字段）。
/// `history` / `accounts` 由同步内容开关决定，关闭时整段不写。
export function buildBundle() {
  // 摘掉 WebDAV 密码，避免随包上传。
  const settings = clone(state.settings ?? {});
  if (settings.sync?.webdav) {
    delete settings.sync.webdav.password;
  }
  // 首次运行状态不跨设备传递。
  delete settings.disclaimerAccepted;
  delete settings.firstRun;

  const { includeHistory, includeAccounts } = bundleOptions();
  const bundle = {
    version: BUNDLE_VERSION,
    app: 'Starveil',
    exportedAt: new Date().toISOString(),
    settings,
    follow: loadFollow().map((item) => ({
      platform: item.platform,
      roomId: String(item.room_id ?? ''),
      userName: item.user_name || '',
      title: item.title || '',
      face: item.avatar || '',
      cover: item.cover || '',
      area: item.area || '',
      tag: item.tag || '默认',
      addedAt: Number(item.added_at) || 0,
      clicks: Number(item.clicks) || 0,
      lastVisit: Number(item.lastVisit) || 0,
    })),
    // 搜索历史与观看统计从 0.6.2 起进入同步包。
    search: loadSearchHistory(),
    stats: loadStats(),
  };

  // 关闭时整段不写，导入侧据此保持本机原样。
  if (includeHistory) {
    bundle.history = loadHistory().map((item) => ({
      platform: item.platform,
      roomId: String(item.room_id ?? ''),
      userName: item.user_name || '',
      title: item.title || '',
      face: item.cover || '',
      area: item.area || '',
      updatedAt: Number(item.watched_at) || 0,
    }));
  }
  if (includeAccounts) {
    const accounts = collectAccounts();
    if (Object.keys(accounts).length) bundle.accounts = accounts;
  }
  return bundle;
}

/// 判断一份 JSON 属于哪种格式，认不出来返回 null。
function detectFormat(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.schema === DART_SCHEMA) return 'dart-profile';
  if (Array.isArray(data.follows) || Array.isArray(data.accounts)) return 'starveil-backup';
  if (Array.isArray(data.follow) || Array.isArray(data.history)) return 'bundle';
  return null;
}

/**
 * 导入任意支持格式，返回给 UI 展示的摘要。
 * @returns {{format:string, follows:number, history:number, settings:number,
 *            search:number, stats:number,
 *            accounts:string[], skipped:Object<string,number>, truncated:number}}
 */
export function importData(data) {
  const format = detectFormat(data);
  if (!format) throw new Error('无法识别的文件格式');
  if (format === 'dart-profile') return importDartProfile(data);
  if (format === 'starveil-backup') {
    return importBundle(
      {
        settings: data.settings,
        follow: data.follows,
        history: data.history,
        // 旧备份包没有这两段：取不到就跳过，不覆盖本机。
        search: data.search,
        stats: data.stats,
      },
      { accounts: data.accounts, format }
    );
  }
  return importBundle(data, { format });
}

// ------------------------------------------------------------ dart profile

/// 时间串转本地时间戳；dart 的格式以空格分隔，需换成 T 才能解析。
function parseDartTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/// dart 的分组名默认是「全部」，直接搬过来会多一个没意义的筛选标签。
function normalizeTag(tag) {
  const text = String(tag ?? '').trim();
  if (!text || text === '全部' || text === '默认') return '默认';
  return text;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/// dart 的 kStyleColor 是 32 位 ARGB，取低 24 位转成 #rrggbb。
function argbToHex(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '';
  return `#${(number & 0xffffff).toString(16).padStart(6, '0')}`;
}

const THEME_MODES = ['system', 'light', 'dark']; // Flutter ThemeMode 的枚举序
const SCALE_MODES = ['contain', 'fill', 'cover']; // dart 的 0/1/2，3/4 是锁定宽高比，本地没有对应项

function importDartProfile(data) {
  const skipped = {};
  const skippedCount = (platform) => {
    skipped[platform] = (skipped[platform] || 0) + 1;
  };

  // 平台不在启用列表时跳过。
  const takePlatform = (siteId) => {
    const platform = normalizePlatform(siteId);
    if (!platform) return '';
    if (!ENABLED_PLATFORMS.includes(platform)) {
      skippedCount(platform);
      return '';
    }
    return platform;
  };

  // ---- 关注
  const followMap = new Map(loadFollow().map((item) => [followKey(item.platform, item.room_id), item]));
  let followCount = 0;
  const importedFollows = [];
  for (const item of data.followUsers || []) {
    const platform = takePlatform(item?.siteId);
    if (!platform || !item?.roomId) continue;
    const roomId = String(item.roomId);
    const key = followKey(platform, roomId);
    const base = followMap.get(key) || {};
    importedFollows.push({
      ...base,
      platform,
      room_id: roomId,
      user_name: item.userName || base.user_name || '',
      title: item.roomTitle || base.title || '',
      avatar: canonicalImage(item.face || base.avatar || ''),
      cover: canonicalImage(item.roomCover || base.cover || ''),
      online: Number(base.online) || 0,
      live: Boolean(base.live),
      area: base.area || '',
      url: base.url || roomUrl(platform, roomId),
      tag: normalizeTag(item.tag || base.tag),
      added_at: parseDartTime(item.addTime) || Number(base.added_at) || Date.now(),
    });
    followMap.delete(key);
    followCount += 1;
  }
  // 导入的按加入时间倒序排在最前，本地原有但没冲突的保持原顺序跟在后面。
  importedFollows.sort((a, b) => (Number(b.added_at) || 0) - (Number(a.added_at) || 0));
  saveFollow([...importedFollows, ...followMap.values()]);

  // ---- 历史
  const historyMap = new Map(loadHistory().map((item) => [followKey(item.platform, item.room_id), item]));
  let historyCount = 0;
  for (const item of data.histories || []) {
    const platform = takePlatform(item?.siteId);
    if (!platform || !item?.roomId) continue;
    const roomId = String(item.roomId);
    const key = followKey(platform, roomId);
    const base = historyMap.get(key) || {};
    const watchedAt = parseDartTime(item.updateTime) || Number(base.watched_at) || 0;
    historyMap.set(key, {
      ...base,
      platform,
      room_id: roomId,
      title: base.title || item.userName || '',
      user_name: item.userName || base.user_name || '',
      cover: canonicalImage(item.face || base.cover || ''),
      online: Number(base.online) || 0,
      area: base.area || '',
      watched_at: watchedAt,
    });
    historyCount += 1;
  }
  const merged = [...historyMap.values()]
    .filter((item) => (Number(item.watched_at) || 0) > 0)
    .sort((a, b) => (Number(b.watched_at) || 0) - (Number(a.watched_at) || 0));
  saveHistory(merged);
  const truncated = Math.max(0, merged.length - HISTORY_LIMIT);

  // ---- 设置
  const settings = data.settings || {};
  let settingsCount = 0;
  const apply = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    setSetting(key, value);
    settingsCount += 1;
  };
  const danmaku = (key) => settings[`Danmu${key}`];
  apply('danmaku.font', danmaku('Size') !== undefined ? Math.round(clamp(danmaku('Size'), 12, 40, 20)) : undefined);
  // dart 的 DanmuSpeed 就是「持续秒数」，和本地 speed 语义一致。
  apply('danmaku.speed', danmaku('Speed') !== undefined ? Math.round(clamp(danmaku('Speed'), 3, 20, 8)) : undefined);
  apply('danmaku.lines', danmaku('LineCount') !== undefined ? Math.round(clamp(danmaku('LineCount'), 1, 30, 10)) : undefined);
  apply('danmaku.area', danmaku('Area') !== undefined ? Math.round(clamp(danmaku('Area') * 100, 15, 100, 40)) : undefined);
  apply('danmaku.opacity', danmaku('Opacity') !== undefined ? Math.round(clamp(danmaku('Opacity') * 100, 20, 100, 95)) : undefined);
  // dart 的字重是 1~9 档，本地直接是 CSS 字重值，×100 后钳进 300~900（本地只提供这几档）。
  apply(
    'danmaku.weight',
    danmaku('FontWeight') !== undefined
      ? clamp(Math.round(Number(danmaku('FontWeight'))) * 100, 300, 900, 700)
      : undefined
  );
  const strokeWidth = Number(danmaku('StrokeWidth'));
  if (Number.isFinite(strokeWidth)) {
    apply('danmaku.strokeWidth', Math.round(clamp(strokeWidth, 0, 5, 0) * 2) / 2);
    apply('danmaku.stroke', strokeWidth > 0);
  }
  if (danmaku('RenderEmoji') !== undefined) apply('danmaku.emoji', Boolean(danmaku('RenderEmoji')));
  if (danmaku('Enable') !== undefined) apply('danmaku.enabled', Boolean(danmaku('Enable')));
  // dart 导出里关键词屏蔽是顶层 danmuShield；`users` 已废弃。
  const shield = data.danmuShield || {};
  if (Array.isArray(shield.keywords)) {
    apply('danmaku.blockKeywords', (shield.keywords || []).join('\n'));
  }
  if (Number.isFinite(Number(settings.ScaleMode))) {
    apply('player.scaleMode', SCALE_MODES[Number(settings.ScaleMode)] || 'contain');
  }
  if (Number.isFinite(Number(settings.ThemeMode))) {
    apply('appearance.theme', THEME_MODES[Number(settings.ThemeMode)] || 'dark');
  }
  const accent = argbToHex(settings.kStyleColor);
  if (accent) {
    apply('appearance.accent', accent);
    apply('accent', accent);
  }
  if (settings.AllowBackgroundPlayback !== undefined) apply('live.allowBackground', Boolean(settings.AllowBackgroundPlayback));
  if (settings.PlayerShowSuperChat !== undefined) apply('player.superChatOverlay', Boolean(settings.PlayerShowSuperChat));

  // ---- 登录态：只取本地支持的平台，Cookie 由调用方注入后端。
  const accounts = [];
  for (const item of data.accounts?.items || []) {
    const platform = normalizePlatform(item?.siteId);
    if (!platform || !ACCOUNT_PLATFORMS.includes(platform) || !item.cookie) continue;
    saveLogin(platform, { cookie: item.cookie, name: `${platform} 账号（导入）` });
    accounts.push(platform);
  }

  return { format: 'dart-profile', follows: followCount, history: historyCount, settings: settingsCount, accounts, skipped, truncated };
}

// ------------------------------------------------------------ 中立包 / 本机备份

function importBundle(data, options = {}) {
  const skipped = {};
  let truncated = 0;
  let followCount = 0;
  let historyCount = 0;

  if (Array.isArray(data.follow)) {
    const followMap = new Map(loadFollow().map((item) => [followKey(item.platform, item.room_id), item]));
    for (const item of data.follow) {
      const platform = normalizePlatform(item?.platform);
      // 中立包用驼峰，starveil 自己的结构是蛇形，两种都认。
      const roomId = String(item?.roomId ?? item?.room_id ?? '');
      if (!platform || !roomId) continue;
      if (!ENABLED_PLATFORMS.includes(platform)) {
        skipped[platform] = (skipped[platform] || 0) + 1;
        continue;
      }
      const key = followKey(platform, roomId);
      const base = followMap.get(key) || {};
      followMap.set(key, {
        ...base,
        platform,
        room_id: roomId,
        user_name: item.userName || item.user_name || base.user_name || '',
        title: item.title || base.title || '',
        avatar: canonicalImage(item.face || item.avatar || base.avatar || ''),
        cover: canonicalImage(item.cover || base.cover || ''),
        online: Number(item.online) || Number(base.online) || 0,
        live: Boolean(base.live),
        area: item.area || base.area || '',
        tag: normalizeTag(item.tag || base.tag),
        added_at: Number(item.addedAt) || Number(item.added_at) || Number(base.added_at) || Date.now(),
        clicks: Number(item.clicks) || Number(base.clicks) || 0,
        lastVisit: Number(item.lastVisit) || Number(base.lastVisit) || 0,
        url: base.url || roomUrl(platform, roomId),
      });
      followCount += 1;
    }
    saveFollow([...followMap.values()]);
  }

  if (Array.isArray(data.history)) {
    const historyMap = new Map(loadHistory().map((item) => [followKey(item.platform, item.room_id), item]));
    for (const item of data.history) {
      const platform = normalizePlatform(item?.platform);
      const roomId = String(item?.roomId ?? item?.room_id ?? '');
      if (!platform || !roomId) continue;
      if (!ENABLED_PLATFORMS.includes(platform)) {
        skipped[platform] = (skipped[platform] || 0) + 1;
        continue;
      }
      const key = followKey(platform, roomId);
      const base = historyMap.get(key) || {};
      historyMap.set(key, {
        ...base,
        platform,
        room_id: roomId,
        title: item.title || item.userName || item.user_name || base.title || '',
        user_name: item.userName || item.user_name || base.user_name || '',
        cover: canonicalImage(item.face || item.cover || base.cover || ''),
        online: Number(item.online) || Number(base.online) || 0,
        area: item.area || base.area || '',
        watched_at: Number(item.updatedAt) || Number(item.watched_at) || Number(base.watched_at) || 0,
      });
      historyCount += 1;
    }
    const merged = [...historyMap.values()].sort(
      (a, b) => (Number(b.watched_at) || 0) - (Number(a.watched_at) || 0)
    );
    truncated = Math.max(0, merged.length - HISTORY_LIMIT);
    saveHistory(merged);
  }

  let settingsCount = 0;
  if (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings)) {
    // 合并前剔除类型不对的整段，避免后续读字段抛错。
    const patch = clone(data.settings);
    for (const key of ['home', 'appearance', 'player', 'live', 'danmaku', 'follow', 'timer', 'sync', 'other']) {
      const value = patch[key];
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        delete patch[key];
      }
    }
    // 剔除已废弃的 danmaku.blockUsers。
    if (patch.danmaku && typeof patch.danmaku === 'object') delete patch.danmaku.blockUsers;
    // 剔除已由 player.gpu 取代的两项。
    if (patch.player && typeof patch.player === 'object') {
      delete patch.player.hardwareDecode;
      delete patch.player.highPerformanceGpu;
    }
    state.settings = merge(clone(state.settings), patch);
    saveSettings();
    settingsCount = Object.keys(patch).length;
  }

  // 搜索历史与统计仅当包内带这两段时才合并；统计按房间按天取大值。
  let searchCount = 0;
  if (Array.isArray(data.search)) {
    searchCount = replaceSearchHistory(data.search);
  }
  let statsCount = 0;
  if (data.stats && typeof data.stats === 'object') {
    statsCount = mergeStats(data.stats);
  }

  // 登录信息：备份走 options.accounts，同步包走 accounts 字段，前者优先。
  const incomingAccounts = options.accounts || data.accounts || {};
  const accounts = [];
  for (const platform of ACCOUNT_PLATFORMS) {
    const login = incomingAccounts?.[platform];
    if (!login?.cookie) continue;
    saveLogin(platform, login);
    accounts.push(platform);
  }

  return {
    format: options.format || 'bundle',
    follows: followCount,
    history: historyCount,
    settings: settingsCount,
    search: searchCount,
    stats: statsCount,
    accounts,
    skipped,
    truncated,
  };
}
