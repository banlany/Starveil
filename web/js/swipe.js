// 横向滑动手势（移动端）。
//
// 只认「明确横向」的拖动：水平位移过阈值、且明显大于垂直位移，其它一律交给
// 浏览器当纵向滚动。所以列表上下滑、点击、长按都不受影响。
//
// 两个额外让路：
// 1. 起点落在可以横向滚动的容器里（平台标签条之类）——那里用户想滚动的是它本身；
// 2. 起点在输入框/下拉框上——那是选词、拖动光标的手势。

// 触发需要的水平位移。比系统手势的阈值小一点，屏幕窄、手指短也好触发。
const MIN_DISTANCE = 52;
// |dy| 超过 |dx| 的这个比例就判成「斜着滚列表」，放弃这次手势。
const MAX_TILT = 0.62;
// 按下到抬起超过这个时间算慢速拖动，不当作翻页。
const MAX_MS = 800;

function startsInScrollableX(node, boundary) {
  for (let el = node; el && el instanceof Element; el = el.parentElement) {
    if (el.scrollWidth - el.clientWidth < 4) continue;
    const overflowX = getComputedStyle(el).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') return true;
    if (el === boundary) break;
  }
  return false;
}

/// 绑定横向滑动，`handler('left' | 'right')`。
/// left = 手指往左划（看下一页），right = 往右划（看上一页）。
/// 移动端之外调用无效——桌面上鼠标拖拽会误触。
export function bindHorizontalSwipe(target, handler) {
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let startAt = 0;

  const onStart = (event) => {
    tracking = false;
    if (event.touches.length !== 1) return;
    if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (startsInScrollableX(event.target, target)) return;
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startAt = event.timeStamp;
    tracking = true;
  };

  const onMove = (event) => {
    if (!tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - startX);
    const dy = Math.abs(touch.clientY - startY);
    // 已经能看出是在上下滚列表了，这一下就别再抢。
    if (dy > 12 && dy > dx) tracking = false;
  };

  const onEnd = (event) => {
    if (!tracking) return;
    tracking = false;
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (event.timeStamp - startAt > MAX_MS) return;
    if (Math.abs(dx) < MIN_DISTANCE) return;
    if (Math.abs(dy) > Math.abs(dx) * MAX_TILT) return;
    handler(dx < 0 ? 'left' : 'right');
  };

  target.addEventListener('touchstart', onStart, { passive: true });
  target.addEventListener('touchmove', onMove, { passive: true });
  target.addEventListener('touchend', onEnd, { passive: true });
  target.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
}
