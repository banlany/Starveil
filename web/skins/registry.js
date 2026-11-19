// 皮肤注册表。一套皮肤 = `web/skins/<id>/skin.css` + 这里的一条记录。
// skin.css 只声明 CSS 变量（见 docs/skins.md）。
//
// 字段：
//   id       目录名，写入 `<html data-skin>`，仅小写字母/数字/短横线
//   name     设置页显示名
//   desc     设置页说明
//   accents  主题色清单，第一项为默认色；可选 `light` 指定浅色档下的替代色值
//   modes    支持的明暗档位，只有一项时表示锁定该档
//   icons    为 true 时加载 `skins/<id>/icons.js` 的 ICON_PATHS
//   titlebar 'traffic' 表示 macOS 红绿灯，缺省为 Windows 右侧三键

export const SKINS = [
  {
    id: 'default',
    name: '星幕',
    // skin.css 的 --accent 是首帧兜底，须与第一项一致（check-skin 校验）。
    accents: [
      { id: 'mist', name: '雾蓝', color: '#5b8def' },
      { id: 'sakura', name: '樱粉', color: '#fb7299' },
      { id: 'violet', name: '藤紫', color: '#9575cd' },
      { id: 'teal', name: '青碧', color: '#26c6da' },
      { id: 'jade', name: '森绿', color: '#26a69a' },
      { id: 'amber', name: '琥珀', color: '#ffb020' },
      // 浅色档改用中深灰，避免白底上看不见。
      { id: 'snow', name: '雪白', color: '#e9eaee', light: '#3a3d45' },
    ],
    desc: '中性深灰打底，七种主题色可选。深色/浅色都支持，适合长时间挂着看。',
    modes: ['dark', 'light'],
  },
  {
    id: 'apple',
    name: '苹果',
    // 这套皮肤只提供系统蓝，不提供主题色选择。
    accents: [{ id: 'blue', name: '系统蓝', color: '#0071e3' }],
    desc: '浅灰画布、白卡片、一支系统蓝。全圆角按钮与慢一档的动效，只提供浅色。',
    // 只有一套配色，明暗档锁定浅色。
    modes: ['light'],
    // 左侧 macOS 红绿灯，颜色由 skin.css 的 --traffic-* 决定。
    titlebar: 'traffic',
    // 自带 `skins/apple/icons.js` 图标表。
    icons: true,
  },
];

export const DEFAULT_SKIN_ID = 'default';

const BY_ID = new Map(SKINS.map((skin) => [skin.id, skin]));

/// 取皮肤定义，未知 id 退回默认皮肤。
export function getSkin(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_SKIN_ID);
}

/// 皮肤样式表路径：`skins/<id>/skin.css`（index.html 的内联脚本按同一约定拼地址）。
export function skinHref(id) {
  return `skins/${id}/skin.css`;
}

/// 这套皮肤实际可用的明暗档位。
export function skinModes(id) {
  const modes = getSkin(id).modes || ['dark'];
  return modes.length ? modes : ['dark'];
}

/// 主题色清单，至少一项；兼容旧的 `accent` 单值写法。
export function skinAccents(id) {
  const skin = getSkin(id);
  if (Array.isArray(skin.accents) && skin.accents.length) return skin.accents;
  return [{ id: 'default', name: '默认', color: skin.accent || '#5b8def' }];
}

/// 皮肤的默认主题色 = accents 的第一项。
export function skinAccent(id) {
  return skinAccents(id)[0].color;
}

/// 主题色在指定明暗档下实际使用的色值。
/// 只影响渲染：设置里存的一直是 `color` 原值。
export function accentForMode(color, mode) {
  if (mode !== 'light' || !color) return color;
  const target = String(color).toLowerCase();
  for (const skin of SKINS) {
    for (const accent of skinAccents(skin.id)) {
      if (accent.color.toLowerCase() === target && accent.light) return accent.light;
    }
  }
  return color;
}
