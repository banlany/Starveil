// 首页：平台热门推荐，分页加载；追加时只插入新卡片，不重建网格。
import { api } from '../api.js';
import { icon, PLATFORM_META } from '../icons.js';
import { homeSlot, state } from '../store.js';
import { loadMore, roomCard, skeletonGrid, spinner } from '../ui.js';

// 后端错误常带完整 URL 与多层前缀，状态行只留前两段，够定位又不撑破版面；
// 完整原文留给 title 与日志。
function shortError(text) {
  const head = String(text)
    .split('：')
    .slice(0, 2)
    .join('：')
    .replace(/\s+/g, ' ')
    .trim();
  return head.length > 48 ? `${head.slice(0, 48)}…` : head;
}

export function renderHome(ctx) {
  // 页面绑定自己的数据槽：在后台时也能继续收数据，切回来直接是这一份。
  const slot = homeSlot();
  let disposed = false;
  const page = document.createElement('section');
  page.className = 'home-page';
  page.innerHTML = `
    <div class="home-status">
      <span class="dot-live"><span class="status-label">${PLATFORM_META[slot.platform]?.name || ''} 热门直播</span></span>
      <span class="home-status-actions">
        <button class="status-retry" hidden>重试</button>
        <span class="sort">${icon('flame', 13)}<span>按人气排序</span></span>
      </span>
    </div>
    <div class="page-pad" id="home-body"></div>`;
  const body = page.querySelector('#home-body');
  const status = page.querySelector('.home-status');
  const statusLabel = page.querySelector('.status-label');
  const retry = page.querySelector('.status-retry');
  const view = document.getElementById('view');

  // 请求失败时灯变红、把错误写在灯后面，占位卡片留着；不整页替换成错误条。
  const paintStatus = () => {
    const failed = Boolean(slot.error);
    status.classList.toggle('is-error', failed);
    status.title = failed ? slot.error : '';
    statusLabel.textContent = failed
      ? shortError(slot.error)
      : `${PLATFORM_META[slot.platform]?.name || ''} 热门直播`;
    retry.hidden = !failed;
  };
  retry.addEventListener('click', () => load(slot.items.length === 0));
  paintStatus();

  let grid = null;
  let skeleton = null;

  const openRoom = (room) => ctx.openRoom(room.platform || slot.platform, room.room_id);

  function makeGrid() {
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'room-grid';
      body.insertBefore(grid, tail);
    }
    return grid;
  }

  function appendRooms(rooms) {
    if (!rooms.length) return;
    const target = makeGrid();
    const fragment = document.createDocumentFragment();
    for (const room of rooms) {
      fragment.appendChild(roomCard(room, { onOpen: openRoom }));
    }
    target.appendChild(fragment);
  }

  if (!slot.items.length && !slot.loading) {
    slot.page = 0;
    slot.done = false;
  }

  const tail = document.createElement('div');
  tail.className = 'home-tail';
  body.appendChild(tail);

  if (slot.items.length) {
    appendRooms(slot.items);
  } else {
    skeleton = skeletonGrid(14);
    body.insertBefore(skeleton, tail);
  }

  function renderTail() {
    tail.innerHTML = '';
    paintStatus();
    if (slot.loading) {
      tail.appendChild(spinner(slot.page > 0 ? '正在加载更多…' : '正在加载热门直播…'));
    } else if (slot.error) {
      // 失败信息在顶部状态行，这里不再重复；占位卡片保留，版面不塌。
    } else if (slot.done || state.settings.home.showMore === false) {
      const end = document.createElement('div');
      end.className = 'list-end';
      end.textContent = slot.items.length
        ? state.settings.home.showMore === false
          ? '已关闭自动加载更多 · 点上方刷新重新拉取'
          : '已经到底了 · 下拉刷新看看新的直播'
        : '';
      tail.appendChild(end);
    } else if (slot.items.length) {
      const more = loadMore('加载更多');
      more.addEventListener('click', () => load(false));
      tail.appendChild(more);
    }
  }

  async function load(reset) {
    if (slot.loading) return;
    // 每次请求都先清掉上一次的失败状态，成功后才不会留着红灯。
    slot.error = '';
    if (reset) {
      slot.page = 0;
      slot.done = false;
      slot.items = [];
      slot.loadedAt = 0;
      grid = null;
      skeleton = skeletonGrid(14);
      body.replaceChildren(skeleton, tail);
    }
    slot.loading = true;
    renderTail();
    const platform = slot.platform;
    const nextPage = slot.page + 1;
    try {
      const items = await api.recommend(platform, nextPage);
      if (disposed) return;
      const seen = new Set(slot.items.map((room) => room.room_id));
      const fresh = items
        .filter((room) => !seen.has(room.room_id))
        .map((room) => ({ ...room, platform }));
      if (skeleton) {
        skeleton.remove();
        skeleton = null;
      }
      appendRooms(fresh);
      slot.items.push(...fresh);
      slot.page = nextPage;
      slot.loadedAt = Date.now();
      // 本页没有新条目才算到底（抖音每页只有十几条）。
      slot.done =
        state.settings.home.showMore === false || fresh.length === 0 || nextPage >= 12;
    } catch (error) {
      slot.error = `加载失败：${String(error)}`;
    } finally {
      slot.loading = false;
      renderTail();
    }
  }

  /// 数据放久了换一批：首次渲染与切回这个页面时都检查一次。
  const refreshIfStale = () => {
    if (!state.settings.home.autoRefresh) return;
    if (Date.now() - (slot.loadedAt || 0) <= 120_000) return;
    load(true);
  };

  if (!slot.items.length) {
    load(false);
  } else {
    renderTail();
    refreshIfStale();
  }

  // 刷新动作由页面提供，按钮由 app.js 管理。
  const refreshHome = () => {
    if (slot.loading) return;
    ctx.setHomeRefreshing(true);
    if (page.isConnected) view.scrollTop = 0;
    return load(true).finally(() => ctx.setHomeRefreshing(false));
  };
  ctx.setHomeRefresh(refreshHome);
  // 下拉刷新走同一个动作：两个入口刷的是同一份数据，不会互相打架。
  ctx.setPullRefresh(refreshHome);
  // 缓存页回到前台时只补数据，不重画。
  ctx.setPageActivate(refreshIfStale);

  view.appendChild(page);

  // 不自动追加下一页，由用户点击「加载更多」触发。
  return () => {
    disposed = true;
    ctx.setHomeRefresh(null);
    ctx.setPullRefresh(null);
    ctx.setPageActivate(null);
  };
}
