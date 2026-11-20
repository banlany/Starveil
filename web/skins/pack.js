// 皮肤包：基于一套内置皮肤，只写差异变量。存本机 localStorage，不进同步包。
// 纯数据模块，tools/check-skin.mjs 直接 import；顶层不访问 DOM 与 localStorage。
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  registerSkin,
  skinAccents,
  TITLEBAR_MODES,
  unregisterSkin,
} from './registry.js';

export const PACK_FORMAT = 'starveil-skin';
export const PACK_VERSION = 1;
export const PACK_KEY = 'starveil.skin-packs.v1';
export const MAX_PACKS = 16;
export const MAX_PACK_BYTES = 65536;

const BUILTIN_IDS = new Set(BUILTIN_SKINS.map((skin) => skin.id));
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const VAR_RE = /^--[a-z0-9-]{1,48}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CSS_UNSAFE = /[{}<>;@\\]|url\s*\(|expression\s*\(|javascript:/i;
const ICON_UNSAFE = /on[a-z]+\s*=|javascript:|url\s*\(|style\s*=|href\s*=|<!|<(?:script|image|foreignObject)/i;
const SVG_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'g']);

function fail(error) {
  return { ok: false, error };
}

/// 变量值只收单行片段；拒绝能闭合规则、外链或转义的字符。
function cleanVarValue(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 256 || CSS_UNSAFE.test(text)) return null;
  return text;
}

function cleanVars(input) {
  const output = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
  for (const [key, value] of Object.entries(input).slice(0, 300)) {
    if (!VAR_RE.test(key)) continue;
    const text = cleanVarValue(value);
    if (text) output[key] = text;
  }
  return output;
}

function cleanAccents(input) {
  const list = Array.isArray(input) ? input.slice(0, 8) : [];
  const output = [];
  for (const item of list) {
    if (!item || !HEX_RE.test(String(item.color || ''))) continue;
    const accent = {
      id: /^[a-z0-9-]{1,24}$/.test(String(item.id || '')) ? String(item.id) : `c${output.length + 1}`,
      name: String(item.name || '主题色').slice(0, 16),
      color: String(item.color),
    };
    if (HEX_RE.test(String(item.light || ''))) accent.light = String(item.light);
    output.push(accent);
  }
  return output.length ? output : [{ id: 'accent', name: '主题色', color: '#5b8def' }];
}

function cleanModes(input) {
  const list = Array.isArray(input) ? input : [];
  const modes = [...new Set(list.filter((mode) => mode === 'dark' || mode === 'light'))];
  return modes.length ? modes : ['dark'];
}

/// 图标片段只保留白名单标签，属性里不许出现事件、外链与样式。
function cleanIconPath(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const tags = [...value.matchAll(/<[^>]*>/g)].map((match) => match[0]);
  if (!tags.length || tags.length > 24 || value.replace(/<[^>]*>/g, '').trim()) return null;
  for (const tag of tags) {
    const name = /^<\/?([a-zA-Z][\w-]*)/.exec(tag)?.[1];
    if (!SVG_TAGS.has(name) || ICON_UNSAFE.test(tag)) return null;
  }
  return tags.join('');
}

function cleanIcons(input) {
  const output = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
  for (const [key, value] of Object.entries(input).slice(0, 64)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(key)) continue;
    const path = cleanIconPath(value);
    if (path) output[key] = path;
  }
  return output;
}

/// 包只保留契约内字段，杂字段与非法值整条丢弃。
export function sanitizeSkinPack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('不是皮肤包');
  if (raw.format !== PACK_FORMAT) return fail('format 不是 starveil-skin');
  if (Number(raw.version) > PACK_VERSION) return fail('皮肤包版本过高');
  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id) || BUILTIN_IDS.has(id)) return fail('id 不合法或与内置皮肤冲突');
  const base = String(raw.base || DEFAULT_SKIN_ID).trim();
  if (!BUILTIN_IDS.has(base)) return fail('base 必须是内置皮肤 id');
  const pack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id,
    name: String(raw.name || id).trim().slice(0, 24),
    desc: String(raw.desc || '').trim().slice(0, 100),
    base,
    accents: cleanAccents(raw.accents),
    modes: cleanModes(raw.modes),
    titlebar: TITLEBAR_MODES.includes(raw.titlebar) ? raw.titlebar : 'windows',
    allowUserFont: raw.allowUserFont === true,
    vars: { dark: cleanVars(raw.vars?.dark), light: cleanVars(raw.vars?.light) },
    icons: cleanIcons(raw.icons),
  };
  if (JSON.stringify(pack).length > MAX_PACK_BYTES) return fail('皮肤包超过 64 KB');
  return { ok: true, pack };
}

/// 差异变量生成两块作用域；首帧与运行时共用同一份文本。
export function packCss(pack) {
  const scope = `html[data-skin-pack="${pack.id}"]`;
  const blocks = [];
  for (const [mode, suffix] of [['dark', ''], ['light', '[data-theme="light"]']]) {
    const entries = Object.entries(pack.vars[mode] || {});
    if (!entries.some(([key]) => key === '--accent')) {
      const accent = pack.accents[0];
      entries.unshift(['--accent', mode === 'light' ? (accent.light || accent.color) : accent.color]);
    }
    if (!entries.length) continue;
    blocks.push(`${scope}${suffix} {\n${entries.map(([key, value]) => `  ${key}: ${value};`).join('\n')}\n}`);
  }
  return blocks.join('\n');
}

/// 读本机包并注册；坏数据整条跳过。
export function loadSkinPacks() {
  let stored = [];
  try {
    stored = JSON.parse(localStorage.getItem(PACK_KEY) || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  const packs = [];
  for (const raw of stored.slice(0, MAX_PACKS)) {
    const result = sanitizeSkinPack(raw);
    if (!result.ok) continue;
    registerSkin(result.pack);
    packs.push(result.pack);
  }
  return packs;
}

function saveSkinPacks(packs) {
  localStorage.setItem(PACK_KEY, JSON.stringify(packs.slice(0, MAX_PACKS)));
}

/// 同 id 视为更新；调用方负责切到新皮肤。
export function installSkinPack(raw) {
  const result = sanitizeSkinPack(raw);
  if (!result.ok) return result;
  const packs = loadSkinPacks().filter((pack) => pack.id !== result.pack.id);
  if (packs.length >= MAX_PACKS) return fail(`最多安装 ${MAX_PACKS} 套皮肤包`);
  packs.push(result.pack);
  saveSkinPacks(packs);
  registerSkin(result.pack);
  return result;
}

export function removeSkinPack(id) {
  saveSkinPacks(loadSkinPacks().filter((pack) => pack.id !== id));
  return unregisterSkin(id);
}

/// 从当前皮肤导出可编辑的空白包。
export function templatePack(skin) {
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: `${skin.base || skin.id}-copy`,
    name: `${skin.name} 副本`,
    desc: skin.desc || '',
    base: skin.base || skin.id,
    accents: skinAccents(skin.id).map((accent) => ({ ...accent })),
    modes: [...(skin.modes || ['dark'])],
    titlebar: TITLEBAR_MODES.includes(skin.titlebar) ? skin.titlebar : 'windows',
    allowUserFont: skin.allowUserFont === true,
    vars: { dark: {}, light: {} },
    icons: {},
  };
}
