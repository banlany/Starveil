// 统一的线性图标。路径尽量贴近原版 Flutter 图标（Material Symbols）。
const PATHS = {
  home: '<path d="M3 10.7 12 3l9 7.7"/><path d="M5.2 9.6V21h13.6V9.6"/><path d="M9.6 21v-6.4h4.8V21"/>',
  heart: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z"/>',
  heartFilled:
    '<path fill="currentColor" stroke="none" d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z"/>',
  grid: '<rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.6"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.6"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.6"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.6"/>',
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
  screen: '<rect x="3" y="4.5" width="18" height="12.5" rx="1.6"/><path d="M8.5 20.5h7M12 17v3.5"/>',
  hd: '<rect x="2.8" y="5.5" width="18.4" height="13" rx="2.2"/><path d="M7.2 9v6M11.8 9v6M7.2 12h4.6M14.2 9v6h2.1a3 3 0 0 0 0-6h-2.1Z"/>',
  signal: '<path d="M4 20v-4M9.3 20v-8M14.6 20V7.5M20 20V4"/>',
  danmaku: '<path d="M4 5.5h16v11H9l-4 3.2V5.5Z"/><path d="M8 9.5h8M8 12.5h5"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.7 7.6-3.9M8.2 13.3l7.6 3.9"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4 0l2.5-2.5a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4 0L5.1 13a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  star: '<path d="m12 3.5 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9L12 3.5Z"/>',
  tag: '<path d="M20.5 13.2 12.8 21 3 11.2V3h8.2l9.3 9.3a.7.7 0 0 1 0 .9Z"/><circle cx="7" cy="7" r="1.4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v5h5"/><path d="M12 8v4.4l3.2 1.9"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  sync: '<rect x="3" y="5" width="13" height="10" rx="1.5"/><path d="M8 20h8M12 15v5"/><path d="M19 8.5a3 3 0 0 1 0 6"/>',
  parse: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4 0l2.5-2.5a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4 0L5.1 13a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>',
  moon: '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z"/>',
  // 跟随系统：左半是太阳（带三道光线），右半实心是月亮的暗面
  // 跟随系统：右半实心的圆，一半亮一半暗（不是齿轮，避免和「设置」混淆）
  contrast:
    '<circle cx="12" cy="12" r="7.6"/><path fill="currentColor" stroke="none" d="M12 4.4a7.6 7.6 0 0 1 0 15.2Z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.3M12 19.7V22M2 12h2.3M19.7 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"/>',
  player: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.2v5.6l4.8-2.8-4.8-2.8Z" fill="currentColor" stroke="none"/>',
  live: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6"/><path d="M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4.4l3 1.8M9 2h6"/>',
  other: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.4 3.2 7.5 7.5 9 4.3-1.5 7.5-4.6 7.5-9V6L12 3Z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.2"/>',
  github: '<path d="M9 19.5c-4.3 1.3-4.3-2.2-6-2.6M15 21v-3.4a2.9 2.9 0 0 0-.8-2.2c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.5 2.6 5.5 2.9 5.5 2.9a4.4 4.4 0 0 0-.1 3.3A4.7 4.7 0 0 0 4 9.4c0 4.7 2.8 5.7 5.5 6a2.9 2.9 0 0 0-.8 2.2V21"/>',
  download: '<path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 17v3h16v-3"/>',
  upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 17v3h16v-3"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6M6.3 7.4A16 16 0 0 0 2.5 12S6 18 12 18a9 9 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  flame: '<path d="M12 21c4 0 6.5-2.6 6.5-6.2 0-4.6-4.5-6.1-4.1-11.8-2.4 1-4.1 3.2-4.1 5.8 0 1.5.5 2.2-.6 2.2-1.2 0-1.7-1.6-1.7-2.9C6.3 9.7 5.5 11.7 5.5 14c0 3.9 2.5 7 6.5 7Z"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16 4.8a3.4 3.4 0 0 1 0 6.4M17.5 14.2A6.2 6.2 0 0 1 21.2 20"/>',
  userMinus: '<circle cx="9" cy="8" r="3.4"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16 11h6"/>',
  filter: '<path d="M3.5 5.5h17l-6.6 7.7V20l-3.8-2v-4.8L3.5 5.5Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>',
  gridView: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 16 5-4-5-4M21 12H9"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  spark: '<path d="M12 2.5 14.2 9l6.5 2.2-6.5 2.2L12 20l-2.2-6.6L3.3 11.2 9.8 9 12 2.5Z"/>',
};

export function icon(name, size = 20, className = '') {
  const path = PATHS[name] || PATHS.info;
  return `<svg class="ico ${className}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export function platformAsset(platform) {
  return platform === 'bilibili' ? 'bilibili_2' : platform;
}

export function platformIcon(platform, size = 22) {
  return `<img class="platform-img" src="assets/${platformAsset(platform)}.png" width="${size}" height="${size}" alt="" draggable="false" />`;
}

export const PLATFORM_META = {
  bilibili: { id: 'bilibili', name: '哔哩哔哩', short: 'B站', color: '#fb7299' },
  douyu: { id: 'douyu', name: '斗鱼直播', short: '斗鱼', color: '#ff7a1a' },
  huya: { id: 'huya', name: '虎牙直播', short: '虎牙', color: '#ffb020' },
  douyin: { id: 'douyin', name: '抖音直播', short: '抖音', color: '#25f4ee' },
  kuaishou: { id: 'kuaishou', name: '快手直播', short: '快手', color: '#ff4d2d' },
};
