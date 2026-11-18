// 横向滑动手势（移动端）：位移过阈值且明显偏横才翻页，
// 起点在横向滚动容器或输入控件上时不接管。
const MIN_DISTANCE = 52;
// |dy| 超过 |dx| 的这个比例就判成纵向滚动。
const MAX_TILT = 0.62;
// 按下到抬起超过这个时长不算翻页。
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

/// 绑定横向滑动，`handler('left' | 'right')`：left = 手指左划（下一页），right = 右划（上一页）。
/// 仅在移动端生效。
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
