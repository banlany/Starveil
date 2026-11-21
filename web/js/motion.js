// 界面动效档位：CSS 与 JS 共用的取值来源。
// 纯数据模块，tools/check-skin.mjs 直接 import。

export const MOTION_MODES = ['full', 'reduced', 'off'];

const SCALE = { full: 1, reduced: 0.5, off: 0 };

/// 首次启动且没有预涂缓存时跟随系统偏好。
export function defaultMotion() {
  const reduced = typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  return reduced ? 'reduced' : 'full';
}

export function sanitizeMotion(value, fallback = 'full') {
  return MOTION_MODES.includes(value) ? value : fallback;
}

/// 运行时读首帧已写好的 <html data-motion>，切档后立即生效。
export function currentMotion() {
  if (typeof document === 'undefined') return defaultMotion();
  return sanitizeMotion(document.documentElement.dataset.motion, defaultMotion());
}

/// 退场等待时长，与 CSS 的 --motion-scale 同一组乘数。
export function motionDelay(base) {
  return Math.round(base * SCALE[currentMotion()]);
}

/// off 档同步加 show，其余等一帧让过渡起效。
export function showOnNextFrame(node, className = 'show') {
  if (currentMotion() === 'off') node.classList.add(className);
  else requestAnimationFrame(() => node.classList.add(className));
}

/// off 档不加入场 class。
export function addEnterClass(node, className) {
  if (currentMotion() !== 'off') node.classList.add(className);
}

/// CSS 的 scroll-behavior 压不住 JS 传入的 behavior 参数。
export function scrollBehavior() {
  return currentMotion() === 'full' ? 'smooth' : 'auto';
}
