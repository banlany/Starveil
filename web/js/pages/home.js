// 首页：平台热门推荐，分页加载。
//
// 性能注意：追加下一页时只 append 新卡片，不重建整个网格；
// 卡片本身用 content-visibility 跳过屏外渲染，避免滚动几十张卡片时卡顿。
import { api } from '../api.js';
import { icon, PLATFORM_META } from '../icons.js';
import { state } from '../store.js';
import { loadMore, roomCard, skeletonGrid, spinner } from '../ui.js';

export function renderHome(ctx) {
  const page = document.createElement('section');
  page.className = 'home-page';
  page.innerHTML = `
    <div class="home-status">
      <span class="dot-live">${PLATFORM_META[state.platform]?.name || ''} 热门直播</span>
      <span class="home-status-actions">
        <span class="sort">${icon('flame', 13)}<span>按人气排序</span></span>
      </span>
    </div>
    <div class="page-pad" id="home-body"></div>`;
  const body = page.querySelector('#home-body');
  const view = document.getElementById('view');

  let grid = null;
  let skeleton = null;

  const openRoom = (room) => ctx.openRoom(room.platform || state.platform, room.room_id);

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

  if (!state.home.items.length && !state.home.loading) {
    state.home.page = 0;
    state.home.done = false;
  }

  const tail = document.createElement('div');
  tail.className = 'home-tail';
  body.appendChild(tail);

  if (state.home.items.length) {
    appendRooms(state.home.items);
  } else {
    skeleton = skeletonGrid(14);
    body.insertBefore(skeleton, tail);
  }

  function renderTail() {
    tail.innerHTML = '';
    if (state.home.loading) {
      tail.appendChild(spinner(state.home.page > 0 ? '正在加载更多…' : '正在加载热门直播…'));
    } else if (state.home.error) {
      const error = document.createElement('div');
      error.className = 'page-error';
      error.innerHTML = `<span>${state.home.error}</span><button class="btn small">重试</button>`;
      error.querySelector('button').addEventListener('click', () => load(true));
      tail.appendChild(error);
    } else if (state.home.done || state.settings.home.showMore === false) {
      const end = document.createElement('div');
      end.className = 'list-end';
      end.textContent = state.home.items.length
        ? state.settings.home.showMore === false
          ? '已关闭自动加载更多 · 点上方刷新重新拉取'
          : '已经到底了 · 下拉刷新看看新的直播'
        : '';
      tail.appendChild(end);
    } else if (state.home.items.length) {
      const more = loadMore('加载更多');
      more.addEventListener('click', () => load(false));
      tail.appendChild(more);
    }
  }

  async function load(reset) {
    if (state.home.loading) return;
    if (reset) {
      state.home.page = 0;
      state.home.done = false;
      state.home.items = [];
      state.home.error = '';
      state.home.loadedAt = 0;
      grid = null;
      skeleton = skeletonGrid(14);
      body.replaceChildren(skeleton, tail);
    }
    state.home.loading = true;
    renderTail();
    const platform = state.platform;
    const nextPage = state.home.page + 1;
    try {
      const items = await api.recommend(platform, nextPage);
      if (platform !== state.platform || ctx.route() !== 'home') return;
      const seen = new Set(state.home.items.map((room) => room.room_id));
      const fresh = items
        .filter((room) => !seen.has(room.room_id))
        .map((room) => ({ ...room, platform }));
      if (skeleton) {
        skeleton.remove();
        skeleton = null;
      }
      appendRooms(fresh);
      state.home.items.push(...fresh);
      state.home.page = nextPage;
      state.home.loadedAt = Date.now();
      state.home.done =
        state.settings.home.showMore === false || fresh.length < 10 || nextPage >= 12;
    } catch (error) {
      state.home.error = `加载失败：${String(error)}`;
    } finally {
      state.home.loading = false;
      if (ctx.route() === 'home') renderTail();
    }
  }

  if (!state.home.items.length) {
    load(false);
  } else {
    renderTail();
    if (state.settings.home.autoRefresh && Date.now() - (state.home.loadedAt || 0) > 120_000) {
      load(true);
    }
  }

  // 「刷新推荐」按钮放在顶栏，和搜索按钮同一排。
  // 页面本身只提供动作，按钮本身由 app.js 统一管理。
  ctx.setHomeRefresh(() => {
    if (state.home.loading) return;
    ctx.setHomeRefreshing(true);
    view.scrollTop = 0;
    load(true).finally(() => ctx.setHomeRefreshing(false));
  });

  view.appendChild(page);

  // 不在滚动过程中自动追加：B 站封面解码 + DOM 插入会让滚动明显掉帧。
  // 需要更多内容时点底部的「加载更多」，把网络和渲染放到用户主动操作之后。
  return () => {
    ctx.setHomeRefresh(null);
  };
}
