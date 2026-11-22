// 整页横滑的动画层：当前页跟手拖动，目标平台的骨架页从外侧跟进。
// 手势拖动与点击平台标签共用这一层，点击时不开拖动、一次滑到位。
import { motionDelay } from './motion.js';
import { buildSwipePeek } from './swipe-peek.js';

// 抬手指后的收尾时长；点击滑动的时长随位移加长，宽屏不会一闪而过。
const SETTLE_MS = 220;
const GLIDE_MIN_MS = 180;
const GLIDE_MAX_MS = 360;

function glideMs(distance) {
  return Math.round(Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + distance * 0.15));
}

/// 摘掉整页横滑留下的内联样式与类名：位移、层级、预览层专用的过渡。
export function clearSwipeState(node) {
  if (!node) return;
  node.classList.remove('is-swiping');
  node.style.transition = '';
  node.style.transform = '';
  node.style.willChange = '';
  node.style.position = '';
  node.style.zIndex = '';
}

/// view：被滑动的滚动容器；返回的 begin/move/settle 由手势驱动，glide 由点击驱动。
/// hooks.onProgress(progress, ms, platform)：位移进度 0→1，ms 为 0 表示跟手不补过渡；
/// hooks.onFinish()：滑动层收起，供调用方清掉跟随进度的样式。
export function createPageSlider(view, hooks = {}) {
  let session = null;

  const apply = (dx, ms) => {
    const { page, peek, width, sign, platform } = session;
    page.style.transition = ms ? `transform ${ms}ms var(--ease)` : 'none';
    peek.style.transition = ms ? `transform ${ms}ms var(--ease)` : 'none';
    page.style.transform = `translateX(${dx}px)`;
    // 预览层始终贴在当前页的外侧：左划时从右边进来，右划时从左边。
    peek.style.transform = `translateX(${sign * width + dx}px)`;
    const progress = width ? Math.min(1, Math.abs(dx) / width) : 0;
    hooks.onProgress?.(progress, ms, platform);
  };

  const release = () => {
    if (!session) return;
    const { page, peek } = session;
    clearSwipeState(page);
    peek.remove();
    session = null;
    hooks.onFinish?.();
  };

  /// 开一层滑动：route 是当前页类型，platform 是目标平台，direction 是手指方向。
  /// cached 是该平台留在缓存里的页面（{ node, scroll }），没有就画骨架。
  const begin = (route, platform, direction, cached) => {
    if (session) return false;
    const page = view.firstElementChild;
    if (!page) return false;
    // 入场动画的 transform 会盖住拖动位移，先摘掉。
    page.classList.remove('page-enter', 'back');
    page.classList.add('is-swiping');
    const peek = document.createElement('div');
    peek.className = 'swipe-peek';
    peek.style.height = `${view.clientHeight}px`;
    peek.style.top = `${view.scrollTop}px`;
    const content = cached?.node || buildSwipePeek(route, platform);
    // 缓存节点可能带着上一次被打断的位移，先还原成静止的样子。
    clearSwipeState(content);
    content.classList.remove('page-enter', 'back');
    for (const card of content.querySelectorAll('.card-enter')) card.classList.remove('card-enter');
    peek.appendChild(content);
    view.insertBefore(peek, page);
    // 复用缓存页时把它原来的滚动位置对回来，滑动中看到的就是切过去的样子。
    if (cached?.scroll) peek.scrollTop = cached.scroll;
    session = {
      page,
      peek,
      platform,
      width: view.clientWidth,
      sign: direction === 'left' ? 1 : -1,
    };
    page.style.willChange = 'transform';
    // 绝对定位的预览层会盖在普通流之上，拖动期间把当前页提到它上面。
    page.style.position = 'relative';
    page.style.zIndex = '1';
    apply(0, 0);
    return true;
  };

  const move = (dx) => {
    if (!session) return;
    // 拖过整屏后加阻尼，手指继续走、画面走得慢。
    const { width } = session;
    const clamped = Math.abs(dx) <= width ? dx : Math.sign(dx) * (width + (Math.abs(dx) - width) * 0.35);
    // 预览层跟着滚动位置走，拖动中列表还能上下滚。
    session.peek.style.top = `${view.scrollTop}px`;
    apply(clamped, 0);
  };

  /// 收尾：commit 时滑到整屏并交出目标平台，否则弹回原位。
  const settle = (commit, onCommit, ms) => {
    if (!session) return;
    const { width, sign, platform } = session;
    const duration = motionDelay(ms ?? SETTLE_MS);
    apply(commit ? -sign * width : 0, duration);
    const done = () => {
      if (!session) return;
      release();
      if (commit) onCommit?.(platform);
    };
    if (duration) setTimeout(done, duration);
    else done();
  };

  /// 点击平台标签：不开拖动，直接滑到目标页。
  const glide = (route, platform, direction, onCommit, cached) => {
    if (!begin(route, platform, direction, cached)) return false;
    // 先让起始位移落一帧，过渡才有起点。
    requestAnimationFrame(() => settle(true, onCommit, glideMs(view.clientWidth)));
    return true;
  };

  return { begin, move, settle, glide, reset: release, isBusy: () => Boolean(session) };
}
