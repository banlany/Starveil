// 自绘悬停提示。
//
// WebView 的原生 `title` 是系统画的白框，字色、圆角、阴影都不归皮肤管，
// 在浅色皮肤上尤其突兀。这里把 `title` 接管过来：第一次见到就搬进 `data-tip`，
// 之后悬停 420ms 由我们自己画一个小气泡（`.app-tip`，配色全在皮肤变量里）。
//
// 三个约定：
//   1. 元素仍然可以用 `title` 写字，也仍然可以随时改 `title` —— MutationObserver
//      会把新值搬进 `data-tip`。搬走时顺手补一个 `aria-label`（如果它没有），
//      免得纯图标按钮失去可读名字。
//   2. 只认指针悬停，触屏不弹（移动端压根没有 hover）。
//   3. 气泡是 `position: fixed` 的独立层，不参与布局，也不会被父元素的
//      `overflow: hidden` 裁掉 —— 抽屉、卡片、控制条里的按钮都能用。

const SHOW_DELAY = 420;
const HIDE_DELAY = 40;
const GAP = 8;
const EDGE = 8;

let tip = null;
let showTimer = 0;
let hideTimer = 0;
let current = null;
let observer = null;

/// 把一棵子树里的 `title` 搬进 `data-tip`。
function adopt(root) {
  if (!root?.querySelectorAll) return;
  const list = root.querySelectorAll('[title]');
  for (const el of list) adoptOne(el);
}

function adoptOne(el) {
  const text = el.getAttribute('title');
  if (!text) return;
  el.setAttribute('data-tip', text);
  el.removeAttribute('title');
  // 纯图标按钮原本靠 title 提供可读名字，搬走之后补一个 aria-label。
  if (!el.hasAttribute('aria-label') && !el.textContent.trim()) {
    el.setAttribute('aria-label', text);
  }
}

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'app-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

function place(el) {
  const text = el.dataset.tip || '';
  if (!text) return;
  const box = ensureTip();
  box.textContent = text;
  box.classList.remove('is-above');
  box.hidden = false;
  // 先按「下方」摆一次量尺寸，再决定要不要翻到上方。
  const anchor = el.getBoundingClientRect();
  const size = box.getBoundingClientRect();
  let left = anchor.left + anchor.width / 2 - size.width / 2;
  left = Math.min(Math.max(EDGE, left), window.innerWidth - size.width - EDGE);
  let top = anchor.bottom + GAP;
  if (top + size.height > window.innerHeight - EDGE) {
    top = Math.max(EDGE, anchor.top - size.height - GAP);
    box.classList.add('is-above');
  }
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.classList.add('is-shown');
}

function hide() {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  current = null;
  if (!tip) return;
  tip.classList.remove('is-shown');
  tip.hidden = true;
}

function onEnter(event) {
  if (event.pointerType === 'touch') return;
  const el = event.target.closest?.('[data-tip]');
  if (!el || el === current) return;
  current = el;
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    if (current === el && el.isConnected) place(el);
  }, SHOW_DELAY);
}

function onLeave(event) {
  const el = event.target.closest?.('[data-tip]');
  if (!el || el !== current) return;
  // 在元素内部从一个子节点移到另一个子节点不算离开。
  if (event.relatedTarget && el.contains(event.relatedTarget)) return;
  window.clearTimeout(showTimer);
  hideTimer = window.setTimeout(hide, HIDE_DELAY);
}

/// 页面里大多数按钮是渲染出来的，`title` 也是运行时写的，所以监听整棵 DOM。
/// 只观察 `title` 一个属性，回调里再把它搬走，第二次（移除）不会触发新的搬运。
function watch() {
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        adoptOne(record.target);
        continue;
      }
      // 悬停中的元素被换页/重渲染摘掉了，气泡不能留在原地。
      if (current) {
        for (const node of record.removedNodes) {
          if (node === current || (node.contains && node.contains(current))) {
            hide();
            break;
          }
        }
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.hasAttribute?.('title')) adoptOne(node);
        adopt(node);
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title'],
  });
}

export function initTooltips() {
  if (tip) return;
  ensureTip();
  adopt(document.body);
  watch();

  document.addEventListener('pointerover', onEnter, { passive: true });
  document.addEventListener('pointerout', onLeave, { passive: true });
  // 点下去、滚一下、按 Esc、窗口失焦，气泡都该立刻收掉。
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  // 路由切换/重新渲染时元素会被换掉，气泡跟着消失。
  window.addEventListener('simple-live:theme', hide);
}

/// 给需要临时压住提示的地方用（比如长按拖拽）。
export function hideTooltips() {
  hide();
}
