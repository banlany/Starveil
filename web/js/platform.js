// 平台识别：桌面（自绘标题栏）与移动端（系统状态栏）。
// index.html 的 <head> 里有一段等价的内联脚本，用于首帧前打标。

const ua = navigator.userAgent || '';

const IS_ANDROID = /Android/i.test(ua);
const IS_IOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

/// 移动端（触屏 + 系统状态栏）——决定是否隐藏自绘标题栏、把侧栏挪到底部。
export const IS_MOBILE = IS_ANDROID || IS_IOS;

/// 当前宿主平台：`android` / `ios` / `desktop`。
const PLATFORM = IS_ANDROID ? 'android' : IS_IOS ? 'ios' : 'desktop';

/// 把平台写到 `<html>` 与 `<body>` 上，供 CSS 选择器使用。
/// 重复调用无害（head 内联脚本可能已经打过标）。
export function applyPlatformFlags() {
  const root = document.documentElement;
  root.dataset.platform = PLATFORM;
  root.classList.toggle('is-mobile', IS_MOBILE);
  document.body.classList.toggle('is-mobile', IS_MOBILE);
  document.body.classList.toggle('is-touch', IS_MOBILE || navigator.maxTouchPoints > 0);
}
