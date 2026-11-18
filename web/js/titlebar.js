// 自绘标题栏：拖拽、最小化/最大化/关闭、无边框窗口的边缘缩放热区。

import { macIcon, winIcon } from './icons.js';
import { IS_MOBILE } from './platform.js';
import { currentSkin } from './store.js';

const windowApi = () => window.__TAURI__?.window;

let appWindow = null;
let maximized = false;
let wired = false;

/// 这套皮肤的窗口按钮形态：`traffic` 为左侧红绿灯，缺省为 Windows 右侧三键。
function titlebarMode() {
  return currentSkin()?.titlebar === 'traffic' ? 'traffic' : 'windows';
}

/// 把窗口按钮图形画进按钮；线宽由 `.titlebar-btn .ico` 读 --icon-stroke-thin。
function paintControls(mode) {
  const paint = (id, parts) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.innerHTML = parts.map(([name, className]) => macIcon(name, className)).join('');
  };
  if (mode === 'traffic') {
    // 红绿灯里的符号比 Windows 的更小更细：-、+、×，且不随最大化换形。
    paint('tb-min', [['min']]);
    paint('tb-max', [['zoom']]);
    paint('tb-close', [['close']]);
    return;
  }
  const paintWin = (id, parts) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.innerHTML = parts.map(([name, className]) => winIcon(name, className)).join('');
  };
  paintWin('tb-min', [['min']]);
  // 最大化按钮里同时放「最大化」和「还原」两个图形，靠 body.is-maximized 切换显隐。
  paintWin('tb-max', [['max', 'ico-max'], ['restore', 'ico-restore']]);
  paintWin('tb-close', [['close']]);
}

/// 切皮肤时重画窗口按钮并换形态（标题栏属于外壳，不会跟着页面重渲染）。
function applyTitlebarSkin() {
  const mode = titlebarMode();
  document.documentElement.dataset.titlebar = mode;
  paintControls(mode);
}

/// 浏览器演示模式与移动端不注册自绘标题栏。
export function initTitlebar() {
  if (IS_MOBILE) {
    document.body.classList.add('no-titlebar');
    return;
  }
  applyTitlebarSkin();
  // 切皮肤会改变按钮形态，需跟随主题事件重画。
  window.addEventListener('simple-live:theme', applyTitlebarSkin);
  const api = windowApi();
  if (!api?.getCurrentWindow) {
    // 浏览器里没有窗口 API，默认隐藏标题栏；加 ?titlebar=1 可以只做视觉预览。
    if (!new URLSearchParams(location.search).has('titlebar')) {
      document.body.classList.add('no-titlebar');
    }
    return;
  }
  if (wired) return;
  wired = true;

  appWindow = api.getCurrentWindow();
  const bar = document.getElementById('titlebar');
  if (!bar) return;

  document.getElementById('tb-min')?.addEventListener('click', () => {
    appWindow.minimize().catch((error) => console.warn('最小化失败', error));
  });
  document.getElementById('tb-max')?.addEventListener('click', () => toggleMaximize());
  document.getElementById('tb-close')?.addEventListener('click', () => {
    // 关掉最后一个窗口就是退出进程（0.4.3 起不再有托盘常驻）。
    appWindow.close().catch((error) => console.warn('关闭失败', error));
  });

  // 拖动交给 data-tauri-drag-region，这里只补双击最大化。
  bar.addEventListener('dblclick', (event) => {
    if (event.target.closest('.titlebar-controls')) return;
    toggleMaximize();
  });

  bindResizeHandles();
  void syncMaximized();
  appWindow.onResized(() => void syncMaximized()).catch(() => {});
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fullscreen', Boolean(document.fullscreenElement));
  });
}

async function toggleMaximize() {
  try {
    await appWindow.toggleMaximize();
  } catch (error) {
    console.warn('最大化切换失败', error);
  }
  // 状态回调有延迟，先乐观同步一次，避免按钮图标闪。
  window.setTimeout(() => void syncMaximized(), 60);
}

async function syncMaximized() {
  try {
    const value = await appWindow.isMaximized();
    if (value === maximized) return;
    maximized = value;
    document.body.classList.toggle('is-maximized', value);
    const button = document.getElementById('tb-max');
    if (button) {
      button.title = value ? '还原' : '最大化';
      button.setAttribute('aria-label', value ? '还原' : '最大化');
    }
  } catch {
    /* 窗口还没就绪时忽略 */
  }
}

function bindResizeHandles() {
  for (const handle of document.querySelectorAll('.resize-handle')) {
    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || maximized) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = handle.dataset.direction;
      if (!direction || typeof appWindow.startResizeDragging !== 'function') return;
      appWindow.startResizeDragging(direction).catch(() => {});
    });
  }
}
