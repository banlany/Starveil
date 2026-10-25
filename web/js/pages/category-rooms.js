// 二级分类下的直播间列表。
import { api } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { emptyState, loadMore, roomGrid, skeletonGrid, spinner, toast } from '../ui.js';

export function renderCategoryRooms(ctx, params) {
  const context = {
    platform: params.platform || state.platform,
    parentId: params.parentId || '',
    subId: params.subId || '',
    name: params.name || '全部直播',
  };
  state.categoryRooms = {
    ...state.categoryRooms,
    items: [],
    page: 0,
    loading: false,
    done: false,
    title: context.name,
    parentId: context.parentId,
    subId: context.subId,
    error: '',
  };

  const page = document.createElement('section');
  page.className = 'subpage category-rooms-page';
  page.innerHTML = `
    <header class="subpage-header">
      <button class="icon-btn back-btn" title="返回">${icon('back', 20)}</button>
      <h1>${escape(context.name)}</h1>
      <div class="header-extra">
        <button class="icon-btn" id="cat-refresh" title="刷新">${icon('refresh', 18)}</button>
      </div>
    </header>
    <div class="subpage-body" id="cat-body"></div>
    <button class="floating-refresh" id="cat-fab" title="刷新">${icon('refresh', 20)}</button>`;
  page.querySelector('.back-btn').addEventListener('click', () => ctx.back());
  const body = page.querySelector('#cat-body');
  const fab = page.querySelector('#cat-fab');
  const refreshButton = page.querySelector('#cat-refresh');

  body.appendChild(skeletonGrid(16));
  const tail = document.createElement('div');
  body.appendChild(tail);

  function renderTail() {
    tail.innerHTML = '';
    if (state.categoryRooms.loading) {
      tail.appendChild(spinner(state.categoryRooms.page ? '正在加载更多…' : '正在加载直播间…'));
    } else if (state.categoryRooms.error) {
      const error = document.createElement('div');
      error.className = 'page-error';
      error.innerHTML = `<span>${escape(state.categoryRooms.error)}</span><button class="btn small">重试</button>`;
      error.querySelector('button').addEventListener('click', () => load(true));
      tail.appendChild(error);
    } else if (!state.categoryRooms.items.length) {
      tail.replaceChildren(
        emptyState({ iconName: 'live', title: '这个分类下还没有直播', text: '换一个分类，或者稍后再来看看。' })
      );
    } else if (state.categoryRooms.done) {
      const end = document.createElement('div');
      end.className = 'list-end';
      end.textContent = '没有更多直播了';
      tail.appendChild(end);
    } else {
      const more = loadMore('加载更多');
      more.addEventListener('click', () => load(false));
      tail.appendChild(more);
    }
  }

  async function load(reset) {
    if (state.categoryRooms.loading) return;
    if (reset) {
      state.categoryRooms.items = [];
      state.categoryRooms.page = 0;
      state.categoryRooms.done = false;
      state.categoryRooms.error = '';
      body.replaceChildren(skeletonGrid(16), tail);
    }
    state.categoryRooms.loading = true;
    renderTail();
    const nextPage = state.categoryRooms.page + 1;
    try {
      const items = await api.categoryRooms(
        context.platform,
        context.parentId,
        context.subId,
        context.name,
        nextPage
      );
      if (ctx.route() !== 'categoryRooms') return;
      const seen = new Set(state.categoryRooms.items.map((room) => room.room_id));
      const fresh = items.filter((room) => !seen.has(room.room_id)).map((room) => ({ ...room, platform: context.platform }));
      state.categoryRooms.items.push(...fresh);
      state.categoryRooms.page = nextPage;
      state.categoryRooms.done = fresh.length < 12;
      body.replaceChildren(
        roomGrid(state.categoryRooms.items, {
          onOpen: (room) => ctx.openRoom(room.platform || context.platform, room.room_id),
          favorite: (room) => ctx.isFollowing(room.platform || context.platform, room.room_id),
          favoriteToggle: (room) => ctx.followFromCard(room),
        }),
        tail
      );
      renderTail();
    } catch (error) {
      state.categoryRooms.error = String(error);
      renderTail();
    } finally {
      state.categoryRooms.loading = false;
    }
  }

  function refresh() {
    toast('正在刷新分类直播…');
    load(true);
  }
  fab.addEventListener('click', refresh);
  refreshButton.addEventListener('click', refresh);

  document.getElementById('view').appendChild(page);
  load(false);

  const view = document.getElementById('view');
  const onScroll = () => {
    if (state.categoryRooms.loading || state.categoryRooms.done) return;
    if (view.scrollTop < 140) return;
    if (view.scrollTop + view.clientHeight > view.scrollHeight - 420) load(false);
  };
  view.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    view.removeEventListener('scroll', onScroll);
  };
}

function escape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
