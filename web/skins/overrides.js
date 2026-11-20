// 用户变量覆盖层：只有列在这里的变量允许写入 <html> 的 inline style。
// 成对变量（--media-* 的底色/字色、--on-sc*）不开放。
// 纯数据模块，tools/check-skin.mjs 直接 import。

export const OVERRIDE_GROUPS = [
  {
    label: '形状',
    items: [
      { key: '--radius-sm', label: '小圆角', min: 0, max: 20, step: 1, unit: 'px' },
      { key: '--radius', label: '中圆角', min: 0, max: 28, step: 1, unit: 'px' },
      { key: '--radius-lg', label: '大圆角', min: 0, max: 36, step: 1, unit: 'px' },
      { key: '--card-radius', label: '卡片圆角', min: 0, max: 36, step: 1, unit: 'px' },
    ],
  },
  {
    label: '间距',
    items: [
      { key: '--group-gap', label: '分组间距', min: 8, max: 40, step: 1, unit: 'px' },
      { key: '--row-pad-y', label: '列表行内距', min: 4, max: 24, step: 1, unit: 'px' },
      { key: '--row-min-h', label: '列表行高', min: 40, max: 88, step: 1, unit: 'px' },
    ],
  },
  {
    label: '动效',
    items: [
      { key: '--dur-base', label: '过渡时长', min: 0, max: 0.8, step: 0.02, unit: 's', digits: 2 },
      { key: '--icon-stroke', label: '图标线宽', min: 1, max: 2.6, step: 0.05, unit: '', digits: 2 },
    ],
  },
];

const ITEMS = new Map(OVERRIDE_GROUPS.flatMap((group) => group.items).map((item) => [item.key, item]));

export const OVERRIDE_KEYS = new Set(ITEMS.keys());

/// 界面密度三档写入的预设值；未列出的档位用皮肤自带值。
export const DENSITY_PRESETS = {
  compact: { '--row-min-h': '52px', '--row-pad-y': '8px', '--item-min-h': '49px' },
  comfortable: {},
  relaxed: { '--row-min-h': '68px', '--item-min-h': '64px' },
};

/// 数值 + 单位。
export function formatOverride(item, value) {
  return `${Number(value).toFixed(item.digits ?? 0)}${item.unit || ''}`;
}

function clamp(item, value) {
  return Math.min(item.max, Math.max(item.min, value));
}

/// 只接受表内变量与「数值 + 本项单位」，其余整条丢弃。
export function sanitizeOverrides(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(input)) {
    const item = ITEMS.get(key);
    if (!item) continue;
    const unit = item.unit || '';
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key] = formatOverride(item, clamp(item, raw));
      continue;
    }
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text.endsWith(unit)) continue;
    const number = Number(text.slice(0, text.length - unit.length));
    if (!Number.isFinite(number)) continue;
    output[key] = formatOverride(item, clamp(item, number));
  }
  return output;
}

/// 密度预设打底，用户覆盖值优先。
export function resolvedOverrides(appearance) {
  const density = appearance?.density || 'comfortable';
  return { ...(DENSITY_PRESETS[density] || {}), ...sanitizeOverrides(appearance?.overrides) };
}
