// 横向滑动手势（移动端）。两种用法：
//   bindHorizontalSwipe(el, (direction) => {})  抬手指后才判一次，用于切页签；
//   bindHorizontalSwipe(el, handlers)           跟手拖动，用于整页横滑（需要中间态）。
// 起点在横向滚动容器或输入控件上时不接管。

// 判定横向意图的最小位移。
const START_SLOP = 6;
// |dy| 超过 |dx| 的这个比例就判成纵向滚动。
const MAX_TILT = 0.62;
// 提交阈值：拖过容器宽度的这个比例，或甩得够快。
const COMMIT_RATIO = 0.28;
const COMMIT_MIN = 96;
const FLICK_VELOCITY = 0.35;
// 拖动中多久没有任何触摸事件，就认为这段手势被系统截断了。
const STALL_MS = 1200;

// 旧接口：抬手指后再判，位移过阈值且明显偏横才翻页。
const MIN_DISTANCE = 52;
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

function canTrack(event, target) {
  if (event.touches.length !== 1) return false;
  if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return false;
  return !startsInScrollableX(event.target, target);
}

/// 抬手指后才判一次，`handler('left' | 'right')`：left = 手指左划（下一页）。
export function bindHorizontalSwipe(target, handler) {
  if (typeof handler !== 'function') return bindDragSwipe(target, handler || {});
  let tracking = false;
  let startX = 0;
  let startY = 0;
  let startAt = 0;

  const onStart = (event) => {
    tracking = false;
    if (!canTrack(event, target)) return;
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

/// 跟手拖动：确认横向意图后立刻回调，抬起时按位移与速度给出提交与否。
/// handlers: { canStart(), onStart(direction) -> boolean, onMove(dx), onEnd(dx, commit), onCancel() }
function bindDragSwipe(target, hooks) {
  let tracking = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastAt = 0;
  let velocity = 0;
  let direction = 'left';
  // 发起这次拖动的手指，别的触摸点一律不算。
  let touchId = null;
  let stallTimer = 0;

  const findTouch = (list) => {
    if (!list) return null;
    if (touchId === null) return list[0] || null;
    for (const item of list) if (item.identifier === touchId) return item;
    return null;
  };

  /// 拖动中途 touchmove/touchend 全断（系统手势、切后台）时把位移收回去。
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (!dragging) return;
      tracking = false;
      dragging = false;
      hooks.onCancel?.();
    }, STALL_MS);
  };

  const onStart = (event) => {
    // 拖动进行中又落下一根手指：不接管，也不清状态——
    // 清掉的话这段拖动永远等不到收尾，位移会留在页面上。
    if (dragging) return;
    tracking = false;
    if (!canTrack(event, target)) return;
    if (hooks.canStart && !hooks.canStart()) return;
    const touch = event.touches[0];
    touchId = touch.identifier ?? null;
    startX = touch.clientX;
    startY = touch.clientY;
    lastX = startX;
    lastAt = event.timeStamp;
    velocity = 0;
    tracking = true;
  };

  const onMove = (event) => {
    if (!tracking) return;
    const touch = findTouch(event.touches);
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!dragging) {
      // 先让纵向滚动成立，再谈横向。
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        tracking = false;
        return;
      }
      if (Math.abs(dx) < START_SLOP) return;
      if (Math.abs(dy) > Math.abs(dx) * MAX_TILT) {
        tracking = false;
        return;
      }
      direction = dx < 0 ? 'left' : 'right';
      if (hooks.onStart && hooks.onStart(direction) === false) {
        tracking = false;
        return;
      }
      dragging = true;
    }
    const now = event.timeStamp;
    const dt = now - lastAt;
    if (dt > 0) velocity = (touch.clientX - lastX) / dt;
    lastX = touch.clientX;
    lastAt = now;
    armStall();
    hooks.onMove?.(dx);
  };

  const onEnd = (event) => {
    if (!dragging) {
      tracking = false;
      return;
    }
    const touch = findTouch(event.changedTouches);
    if (!touch) {
      // 抬起的是另一根手指，这根还按着，拖动继续。
      if (findTouch(event.touches)) return;
      // 发起拖动的手指不知何时没了，直接弹回，别停在半路。
      tracking = false;
      dragging = false;
      clearTimeout(stallTimer);
      hooks.onCancel?.();
      return;
    }
    tracking = false;
    dragging = false;
    clearTimeout(stallTimer);
    const dx = touch.clientX - startX;
    const width = target.clientWidth || window.innerWidth;
    // 甩得够快也算提交，但方向要和位移一致（先往回甩再放开不算）。
    const flick = Math.abs(velocity) > FLICK_VELOCITY && Math.sign(velocity) === Math.sign(dx);
    const commit = flick || Math.abs(dx) > Math.min(COMMIT_MIN, width * COMMIT_RATIO);
    hooks.onEnd?.(dx, commit);
  };

  const onCancel = () => {
    clearTimeout(stallTimer);
    if (!dragging) {
      tracking = false;
      return;
    }
    tracking = false;
    dragging = false;
    hooks.onCancel?.();
  };

  target.addEventListener('touchstart', onStart, { passive: true });
  target.addEventListener('touchmove', onMove, { passive: true });
  target.addEventListener('touchend', onEnd, { passive: true });
  target.addEventListener('touchcancel', onCancel, { passive: true });
}
