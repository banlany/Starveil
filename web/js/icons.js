// 统一的线性图标。路径尽量贴近原版 Flutter 图标（Material Symbols）。
const PATHS = {
  home: '<path d="M3 10.7 12 3l9 7.7"/><path d="M5.2 9.6V21h13.6V9.6"/><path d="M9.6 21v-6.4h4.8V21"/>',
  // 选中态实心版。门直接画进外轮廓（用 evenodd 挖洞会被反填成横杠）。
  homeFilled:
    '<path fill="currentColor" stroke="none" d="M11.05 2.86q.95-.76 1.9 0l7.75 6.26c.26.21.4.53.4.85v9.53a2.2 2.2 0 0 1-2.2 2.2H14.1v-2.7a2.1 2.1 0 0 0-4.2 0v2.7H5.1a2.2 2.2 0 0 1-2.2-2.2V9.97c0-.32.14-.64.4-.85Z"/>',
  // 关注：四角星（等凹边的星芒，凹边朝星心，四角而不是常见的五角）。
  follow:
    '<path d="M12 2.4c.9 4.9 4.7 8.7 9.6 9.6-4.9.9-8.7 4.7-9.6 9.6-.9-4.9-4.7-8.7-9.6-9.6 4.9-.9 8.7-4.7 9.6-9.6Z"/>',
  // 四角星：四角为半径 0.85 的圆头，凹边与线框版同深。
  followFilled:
    '<path fill="currentColor" stroke="none" d="M11.15 3.45a.85.85 0 0 1 1.7 0Q15 9 20.55 11.15a.85.85 0 0 1 0 1.7Q15 15 12.85 20.55a.85.85 0 0 1-1.7 0Q9 15 3.45 12.85a.85.85 0 0 1 0-1.7Q9 9 11.15 3.45Z"/>',
  // 分类：三层堆叠（顶面菱形 + 两道斜边），与关注页的网格视图区分。
  category:
    '<path d="M12 3 20.4 8.3 12 13.6 3.6 8.3 12 3Z"/><path d="M3.6 13.4 12 18l8.4-4.6"/><path d="M3.6 16.9 12 21.5l8.4-4.6"/>',
  // 选中态：顶面填实，两层斜边加粗。
  categoryFilled:
    '<path fill="currentColor" stroke="none" d="M11.35 2.72a1.25 1.25 0 0 1 1.3 0l7.86 4.72a1.2 1.2 0 0 1 0 2.04l-7.86 4.72a1.25 1.25 0 0 1-1.3 0L3.49 9.48a1.2 1.2 0 0 1 0-2.04Z"/><path d="M3.6 13.6 12 18.2l8.4-4.6" stroke-width="2.3"/><path d="M3.6 17.1 12 21.7l8.4-4.6" stroke-width="2.3"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  accountFilled:
    '<path fill="currentColor" stroke="none" d="M12 3.2a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Z"/><path fill="currentColor" stroke="none" d="M12 13.4c4.3 0 7.8 2.9 7.8 5.9 0 1.33-1.07 2.4-2.4 2.4H6.6c-1.33 0-2.4-1.07-2.4-2.4 0-3 3.5-5.9 7.8-5.9Z"/>',
  settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.08A1.7 1.7 0 0 0 10 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.08A1.7 1.7 0 0 0 20.96 10H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  back: '<path d="m14.5 5-7 7 7 7"/><path d="M20 12H7.5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m5 9 7 7 7-7"/>',
  chevronUp: '<path d="m5 15 7-7 7 7"/>',
  refresh: '<path d="M20 11a8 8 0 1 0 .6 4"/><path d="M20 4v7h-7"/>',
  play: '<path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  volume: '<path d="M4 9.5v5h3.4L12 19V5L7.4 9.5H4Z"/><path d="M15.6 8.4a5 5 0 0 1 0 7.2"/><path d="M18.2 5.8a8.6 8.6 0 0 1 0 12.4"/>',
  mute: '<path d="M4 9.5v5h3.4L12 19V5L7.4 9.5H4Z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  fullscreenExit: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  // 小窗（画中画）：大框内嵌实心小框。
  screen:
    '<rect x="2.6" y="4.4" width="18.8" height="15.2" rx="2.6"/><rect x="10.4" y="9.4" width="7.8" height="6.4" rx="1.3" fill="currentColor" stroke="none"/>',
  // 同屏播放：两块并排的画面。
  dual:
    '<rect x="2.6" y="5.6" width="8.4" height="12.8" rx="2"/><rect x="13" y="5.6" width="8.4" height="12.8" rx="2"/>',
  // 延迟播放：沙漏
  delay:
    '<path d="M7 3.4h10M7 20.6h10"/><path d="M8.2 3.4v3.1c0 2.3 3.8 2.9 3.8 5.5s-3.8 3.2-3.8 5.5v3.1"/><path d="M15.8 3.4v3.1c0 2.3-3.8 2.9-3.8 5.5s3.8 3.2 3.8 5.5v3.1"/>',
  // 大航海：船锚
  anchor:
    '<circle cx="12" cy="5.2" r="2.2"/><path d="M12 7.4V21"/><path d="M8.4 10.6h7.2"/><path d="M4 14.4a8 8 0 0 0 16 0"/><path d="M4 14.4h2.2M20 14.4h-2.2"/>',
  signal: '<path d="M4 20v-4M9.3 20v-8M14.6 20V7.5M20 20V4"/>',
  danmaku: '<path d="M4 5.5h16v11H9l-4 3.2V5.5Z"/><path d="M8 9.5h8M8 12.5h5"/>',
  // 弹幕关闭：同一枚气泡划一道斜线。
  danmakuOff: '<path d="M4 5.5h16v11H9l-4 3.2V5.5Z"/><path d="m3.4 3.4 17.2 17.2"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.7 7.6-3.9M8.2 13.3l7.6 3.9"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4 0l2.5-2.5a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4 0L5.1 13a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  send: '<path d="M4 12 20 4l-7 16-2.2-6.2L4 12Z"/>',
  star: '<path d="m12 3.5 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9L12 3.5Z"/>',
  tag: '<path d="M20.5 13.2 12.8 21 3 11.2V3h8.2l9.3 9.3a.7.7 0 0 1 0 .9Z"/><circle cx="7" cy="7" r="1.4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v5h5"/><path d="M12 8v4.4l3.2 1.9"/>',
  // 数据同步：两个方向相反的半环箭头
  sync: '<path d="M4.8 9.9a7.6 7.6 0 0 1 12.6-2.3"/><path d="M18 3.4v4.4h-4.4"/><path d="M19.2 14.1a7.6 7.6 0 0 1-12.6 2.3"/><path d="M6 20.6v-4.4h4.4"/>',
  // 线路：一个源点分叉到两个终点
  route:
    '<circle cx="4.6" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19.4" cy="6.4" r="1.7" fill="currentColor" stroke="none"/><circle cx="19.4" cy="17.6" r="1.7" fill="currentColor" stroke="none"/><path d="M6.3 12h2.1c3.2 0 3.4-5.6 9.3-5.6"/><path d="M6.3 12h2.1c3.2 0 3.4 5.6 9.3 5.6"/>',
  // 播放统计：柱状图 + 基线
  stats:
    '<path d="M3.6 20.4h16.8"/><path d="M7.4 20.4v-6.6"/><path d="M12 20.4V9"/><path d="M16.6 20.4v-3.8"/>',
  // 清晰度：屏幕里一颗四角星
  quality:
    '<rect x="2.8" y="4.6" width="18.4" height="13" rx="2.4"/><path fill="currentColor" stroke="none" d="M12 7.6c.4 2.15 1.95 3.7 4.1 4.1-2.15.4-3.7 1.95-4.1 4.1-.4-2.15-1.95-3.7-4.1-4.1 2.15-.4 3.7-1.95 4.1-4.1Z"/>',
  // 链接解析：链环 + 放大镜
  parse:
    '<path d="M9.5 8.2a3.7 3.7 0 0 1 5.2 5.2l-1.7 1.7"/><path d="M12.6 14.8a3.7 3.7 0 0 1-5.2-5.2l1.7-1.7"/><circle cx="16.5" cy="16.5" r="3.3"/><path d="m18.9 18.9 2 2"/>',
  // 网络：wifi 三弧 + 点，给「本机地址」这类网络状态用。
  wifi:
    '<path d="M2.8 8.8a13.6 13.6 0 0 1 18.4 0"/><path d="M6.2 12.5a8.4 8.4 0 0 1 11.6 0"/><path d="M9.5 16.1a4.2 4.2 0 0 1 5 0"/><circle cx="12" cy="19.3" r="1.1" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z"/>',
  // 跟随系统：右半实心，一半亮一半暗
  contrast:
    '<circle cx="12" cy="12" r="7.6"/><path fill="currentColor" stroke="none" d="M12 4.4a7.6 7.6 0 0 1 0 15.2Z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.3M12 19.7V22M2 12h2.3M19.7 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"/>',
  player: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.2v5.6l4.8-2.8-4.8-2.8Z" fill="currentColor" stroke="none"/>',
  live: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6"/><path d="M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4.4l3 1.8M9 2h6"/>',
  // 其他设置：两条滑杆 + 两个旋钮
  other:
    '<path d="M3.4 7.8h4.8M12.8 7.8h7.8M3.4 16.2h8.4M16.8 16.2h3.8"/><circle cx="10.4" cy="7.8" r="2.4"/><circle cx="14.4" cy="16.2" r="2.4"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.4 3.2 7.5 7.5 9 4.3-1.5 7.5-4.6 7.5-9V6L12 3Z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.2"/>',
  github: '<path d="M9 19.5c-4.3 1.3-4.3-2.2-6-2.6M15 21v-3.4a2.9 2.9 0 0 0-.8-2.2c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.5 2.6 5.5 2.9 5.5 2.9a4.4 4.4 0 0 0-.1 3.3A4.7 4.7 0 0 0 4 9.4c0 4.7 2.8 5.7 5.5 6a2.9 2.9 0 0 0-.8 2.2V21"/>',
  download: '<path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 17v3h16v-3"/>',
  upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 17v3h16v-3"/>',
  flame: '<path d="M12 21c4 0 6.5-2.6 6.5-6.2 0-4.6-4.5-6.1-4.1-11.8-2.4 1-4.1 3.2-4.1 5.8 0 1.5.5 2.2-.6 2.2-1.2 0-1.7-1.6-1.7-2.9C6.3 9.7 5.5 11.7 5.5 14c0 3.9 2.5 7 6.5 7Z"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16 4.8a3.4 3.4 0 0 1 0 6.4M17.5 14.2A6.2 6.2 0 0 1 21.2 20"/>',
  userMinus: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16 11h6"/>',
  filter: '<path d="M3.5 5.5h17l-6.6 7.7V20l-3.8-2v-4.8L3.5 5.5Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>',
  gridView: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/>',
  spark: '<path d="M12 2.5 14.2 9l6.5 2.2-6.5 2.2L12 20l-2.2-6.6L3.3 11.2 9.8 9 12 2.5Z"/>',
};

/// 图标覆盖分层：基础表 → 皮肤包 → 用户，后者优先。
const OVERRIDES = { skin: {}, pack: {}, user: {} };
let MERGED = {};

/// 换一层图标表，并就地重画页面上已有的 svg（外壳元素不会随页面重渲染）。
export function setIconOverrides(map, layer = 'skin') {
  const target = Object.hasOwn(OVERRIDES, layer) ? layer : 'skin';
  OVERRIDES[target] = map && typeof map === 'object' ? map : {};
  MERGED = { ...OVERRIDES.skin, ...OVERRIDES.pack, ...OVERRIDES.user };
  for (const svg of document.querySelectorAll('svg.ico[data-icon]')) {
    const path = MERGED[svg.dataset.icon] || PATHS[svg.dataset.icon];
    if (path) svg.innerHTML = path;
  }
}

export function icon(name, size = 20, className = '') {
  const path = MERGED[name] || PATHS[name] || PATHS.info;
  // 线宽、端点、拐角由 CSS 的 --icon-* 控制；data-icon 供切皮肤时替换图形。
  return `<svg class="ico ${className}" data-icon="${name}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" aria-hidden="true">${path}</svg>`;
}

/// 窗口按钮图形：10 单位网格，线宽由 --icon-stroke-thin 控制，不参与皮肤覆盖。
const WIN_PATHS = {
  min: '<path d="M1 5h8"/>',
  max: '<rect x="1" y="1" width="8" height="8"/>',
  restore:
    '<rect x="1" y="3" width="6.4" height="6.4"/><path d="M3 3V1h6.4v5.4H7"/>',
  close: '<path d="m1.4 1.4 7.2 7.2M8.6 1.4 1.4 8.6"/>',
};

export function winIcon(name, className = '') {
  const path = WIN_PATHS[name] || '';
  return `<svg class="ico ${className}" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" aria-hidden="true">${path}</svg>`;
}

/// macOS 红绿灯符号：与 winIcon 同一网格，仅供 `titlebar: 'traffic'` 的皮肤使用。
const MAC_PATHS = {
  close: '<path d="m2.2 2.2 5.6 5.6M7.8 2.2 2.2 7.8"/>',
  min: '<path d="M2 5h6"/>',
  zoom: '<path d="M5 2v6M2 5h6"/>',
};

export function macIcon(name, className = '') {
  const path = MAC_PATHS[name] || '';
  return `<svg class="ico ${className}" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" aria-hidden="true">${path}</svg>`;
}

export function platformAsset(platform) {
  return platform === 'bilibili' ? 'bilibili_2' : platform;
}

export function platformIcon(platform, size = 22) {
  return `<img class="platform-img" src="assets/${platformAsset(platform)}.png" width="${size}" height="${size}" alt="" draggable="false" />`;
}

// 平台元信息：name 正式名、short 极短名（关注页筛选 chip）、tab 顶栏标签文案。
export const PLATFORM_META = {
  bilibili: { id: 'bilibili', name: '哔哩哔哩', short: 'B站', tab: '哔哩哔哩', color: '#fb7299' },
  douyu: { id: 'douyu', name: '斗鱼直播', short: '斗鱼', tab: '斗鱼', color: '#ff7a1a' },
  huya: { id: 'huya', name: '虎牙直播', short: '虎牙', tab: '虎牙', color: '#ffb020' },
  douyin: { id: 'douyin', name: '抖音直播', short: '抖音', tab: '抖音', color: '#25f4ee' },
  kuaishou: { id: 'kuaishou', name: '快手直播', short: '快手', tab: '快手', color: '#ff4d2d' },
};
