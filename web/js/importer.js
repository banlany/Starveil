// 外部数据导入与「中立同步包」构建。
//
// 目前认三种输入：
// 1. `simple_live_profile`（dart_simple_live 的导出文件，schemaVersion 3）——
//    字段是驼峰，时间形如 "2026-10-27 09:53:10.163"（空格分隔的本地时间）；
// 2. starveil 自己的备份（`settings` / `follows` / `history` / `accounts`）；
// 3. 中立同步包（`follow` / `history` / `settings`），WebDAV 上传下载用的就是它。
//
// 只做「导入到 starveil」这一个方向，不需要反向生成 dart 认得的格式。
// 字段映射与取舍见 ToDo 第 5 项与 CHANGELOG 的 0.4.4 段。

import { canonicalImage, ENABLED_PLATFORMS, normalizePlatform, roomUrl } from './api.js';
import {
  ACCOUNT_PLATFORMS,
  followKey,
  HISTORY_LIMIT,
  loadFollow,
  loadHistory,
  loadLogin,
  saveFollow,
  saveHistory,
  saveLogin,
  saveSettings,
  setSetting,
  state,
} from './store.js';

const DART_SCHEMA = 'simple_live_profile';
/// 中立包/备份的版本号，改结构时递增，导入侧按版本做兼容。
export const BUNDLE_VERSION = 1;

/// 参与同步与导出的本机数据。**不含登录 Cookie**——同步包要传到 WebDAV，
/// 凭据不应该跟着一起漂。
///
/// 输出的是「中立格式」（驼峰字段），和 dart 的 toJson 命名对齐，
/// 这样同一个文件既能喂给自己的导入逻辑，也方便别的工具处理。
export function buildBundle() {
  return {
    version: BUNDLE_VERSION,
    app: '星幕直播 Starveil',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    follow: loadFollow().map((item) => ({
      platform: item.platform,
      roomId: String(item.room_id ?? ''),
      userName: item.user_name || '',
      title: item.title || '',
      face: item.avatar || '',
      cover: item.cover || '',
      tag: item.tag || '默认',
      addedAt: Number(item.added_at) || 0,
      clicks: Number(item.clicks) || 0,
      lastVisit: Number(item.lastVisit) || 0,
    })),
    history: loadHistory().map((item) => ({
      platform: item.platform,
      roomId: String(item.room_id ?? ''),
      userName: item.user_name || '',
      title: item.title || '',
      face: item.cover || '',
      updatedAt: Number(item.watched_at) || 0,
    })),
  };
}

/// 判断一份 JSON 属于哪种格式，认不出来返回 null。
export function detectFormat(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.schema === DART_SCHEMA) return 'dart-profile';
  if (Array.isArray(data.follows) || Array.isArray(data.accounts)) return 'starveil-backup';
  if (Array.isArray(data.follow) || Array.isArray(data.history)) return 'bundle';
  return null;
}

/**
 * 导入任意支持格式，返回给 UI 展示的摘要。
 * @returns {{format:string, follows:number, history:number, settings:number,
 *            accounts:string[], skipped:Object<string,number>, truncated:number}}
 */
export function importData(data) {
  const format = detectFormat(data);
  if (!format) throw new Error('无法识别的文件格式');
  if (format === 'dart-profile') return importDartProfile(data);
  if (format === 'starveil-backup') {
    return importBundle(
      { settings: data.settings, follow: data.follows, history: data.history },
      { accounts: data.accounts, format }
    );
  }
  return importBundle(data, { format });
}

// ------------------------------------------------------------ dart profile

/// 时间串统一转成本地时间戳。dart 写的是 `"2024-09-05 19:18:31.557"`，
/// 空格分隔只有换成 T 才能被 Date.parse 按本地时区解析（直接 parse 会得到 Invalid）。
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

  // 平台不在启用列表里就跳过：starveil 还不认识抖音/快手，
  // 存进去只会在列表里露出来、点开必然报错。
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
  // 关键词/用户屏蔽在 dart 的导出里是顶层 danmuShield，不是嵌在 settings 里。
  const shield = data.danmuShield || {};
  if (Array.isArray(shield.keywords) || Array.isArray(shield.users)) {
    apply('danmaku.blockKeywords', (shield.keywords || []).join('\n'));
    apply('danmaku.blockUsers', (shield.users || []).join('\n'));
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
  if (data.settings && typeof data.settings === 'object') {
    state.settings = { ...state.settings, ...data.settings };
    saveSettings();
    settingsCount = Object.keys(data.settings).length;
  }

  const accounts = [];
  for (const platform of ['bilibili', 'douyu']) {
    const cookie = options.accounts?.[platform]?.cookie;
    if (!cookie) continue;
    saveLogin(platform, options.accounts[platform]);
    accounts.push(platform);
  }

  return {
    format: options.format || 'bundle',
    follows: followCount,
    history: historyCount,
    settings: settingsCount,
    accounts,
    skipped,
    truncated,
  };
}

/// 供设置页判断「这个平台能不能导入」用（同步/导入的提示文案里会用到）。
export function isPlatformImportable(platform) {
  return ENABLED_PLATFORMS.includes(normalizePlatform(platform));
}

/// 已登录平台列表，导入结果里用来提示需要重新注入后端的平台。
export function importedLoginPlatforms() {
  return ['bilibili', 'douyu'].filter((platform) => loadLogin(platform)?.cookie);
}
