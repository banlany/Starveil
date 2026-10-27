// 自绘标题栏：拖拽、最小化 / 最大化 / 关闭、无边框窗口的边缘缩放。
//
// 系统原生标题栏在 tauri.conf.json / main.rs 里关掉了（decorations: false），
// 代价是 Windows 不再给 WS_THICKFRAME，所以四边和四角要自己放缩放热区。
// 另外无边框窗口拿不到系统的贴边吸附（Aero Snap），需要吸附得自己实现。

const windowApi = () => window.__TAURI__?.window;

let appWindow = null;
let maximized = false;
let wired = false;

/// 浏览器演示模式（没有 Tauri）时，保留浏览器自己的窗口，不显示自绘标题栏。
export function initTitlebar() {
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

  // 拖动区交给 data-tauri-drag-region（由系统接管窗口移动），
  // 这里只补双击最大化——无边框窗口下系统不一定会替我们处理。
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
