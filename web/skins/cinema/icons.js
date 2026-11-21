// OLED 影院图标表：只覆盖观看相关的图形，其余沿用 js/icons.js。
// 图形走直角硬边，线宽、端点、拐角仍由 skin.css 的 --icon-* 控制。

export const ICON_PATHS = {
  play: '<path fill="currentColor" stroke="none" d="M7.4 4.4 19.4 12 7.4 19.6Z"/>',
  pause: '<path fill="currentColor" stroke="none" d="M7.2 4.6h3.4v14.8H7.2ZM13.4 4.6h3.4v14.8h-3.4Z"/>',
  fullscreen: '<path d="M3.6 9V3.6H9M21 9V3.6h-5.4M3.6 15v5.4H9M21 15v5.4h-5.4"/>',
  fullscreenExit: '<path d="M9 3.6v5.4H3.6M15 3.6V9h5.4M9 20.4V15H3.6M15 20.4V15h5.4"/>',
  screen: '<rect x="2.4" y="4" width="19.2" height="13.6"/><path d="M8 20.8h8M12 17.6v3.2"/>',
  dual: '<rect x="2.4" y="5.6" width="8.6" height="12.8"/><rect x="13" y="5.6" width="8.6" height="12.8"/>',
  live: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2"/>',
  volume: '<path d="M3.6 9.2h3.4L11.8 5v14L7 14.8H3.6Z"/><path d="M15 9.4h2.2M15 12h4M15 14.6h2.2"/>',
  mute: '<path d="M3.6 9.2h3.4L11.8 5v14L7 14.8H3.6Z"/><path d="m15 9.6 5 4.8M20 9.6l-5 4.8"/>',
};
