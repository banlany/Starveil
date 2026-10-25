// 关注页：本地关注列表、标签与平台筛选。
import { formatOnline, formatCount } from '../api.js';
import { icon, PLATFORM_META, platformIcon } from '../icons.js';
import { loadFollow, removeFollow, state, updateFollow } from '../store.js';
import { avatarHtml, bindImageFallback, confirmDialog, emptyState, escapeHtml, openMenu, promptDialog, toast } from '../ui.js';

export function renderFollow(ctx) {
  const page = document.createElement('section');
  page.className = 'follow-page';
  const follows = loadFollow();
  const tags = [...new Set(follows.map((item) => item.tag || '默认'))];
  const platforms = [...new Set(follows.map((item) => item.platform))];

  page.innerHTML = `
    <header class="follow-header">
      <div class="header-left">
        <button class="icon-btn" id="follow-refresh" title="刷新直播状态">${icon('refresh', 19)}</button>
      </div>
      <h1>关注用户</h1>
      <div class="header-right">
        <button class="icon-btn" id="follow-search" title="搜索关注">${icon('search', 19)}</button>
        <button class="icon-btn" id="follow-filter" title="筛选">${icon('filter', 18)}</button>
        <button class="icon-btn" id="follow-view" title="切换布局">${icon('gridView', 18)}</button>
        <button class="icon-btn" id="follow-multi" title="多开同屏">${icon('screen', 18)}</button>
        <button class="icon-btn" id="follow-more" title="更多">${icon('more', 19)}</button>
      </div>
    </header>
    <div class="follow-toolbar">
      <div class="follow-row">
        <span class="follow-label">标签</span>
        <div class="follow-row" id="follow-tags" style="gap:8px"></div>
        <span class="follow-count">${follows.length} 位主播</span>
      </div>
      <div class="follow-row">
        <div class="follow-mode" id="follow-mode">
          <button data-mode="status" class="${state.followFilter.mode === 'status' ? 'active' : ''}">${icon('check', 13)}按状态</button>
          <button data-mode="platform" class="${state.followFilter.mode === 'platform' ? 'active' : ''}">按平台</button>
        </div>
        <div class="follow-row" id="follow-filters" style="gap:8px"></div>
      </div>
    </div>
    <div id="follow-body"></div>`;

  const tagsBox = page.querySelector('#follow-tags');
  const filtersBox = page.querySelector('#follow-filters');
  const body = page.querySelector('#follow-body');

  function chip(label, active, onClick, count) {
    const button = document.createElement('button');
    button.className = `chip${active ? ' active' : ''}`;
    button.innerHTML = `${escapeHtml(label)}${count !== undefined ? ` <span class="muted">${count}</span>` : ''}`;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderTags() {
    tagsBox.replaceChildren(
      chip('全部', state.followFilter.tag === 'all', () => {
        state.followFilter.tag = 'all';
        renderAll();
      }),
      ...tags.map((tag) =>
        chip(tag, state.followFilter.tag === tag, () => {
          state.followFilter.tag = tag;
          renderAll();
        })
      )
    );
  }

  function renderFilters() {
    filtersBox.replaceChildren();
    if (state.followFilter.mode === 'status') {
      for (const [key, label] of [['all', '全部'], ['live', '直播中'], ['offline', '未开播']]) {
        filtersBox.appendChild(
          chip(label, state.followFilter.status === key, () => {
            state.followFilter.status = key;
            renderAll();
          })
        );
      }
    } else {
      filtersBox.appendChild(
        chip('全部', state.followFilter.platform === 'all', () => {
          state.followFilter.platform = 'all';
          renderAll();
        })
      );
      for (const platform of platforms) {
        filtersBox.appendChild(
          chip(PLATFORM_META[platform]?.short || platform, state.followFilter.platform === platform, () => {
            state.followFilter.platform = platform;
            renderAll();
          })
        );
      }
    }
  }

  function filtered() {
    return follows.filter((item) => {
      if (state.followFilter.tag !== 'all' && (item.tag || '默认') !== state.followFilter.tag) return false;
      if (state.followFilter.mode === 'status') {
        if (state.followFilter.status === 'live' && !item.live) return false;
        if (state.followFilter.status === 'offline' && item.live) return false;
      } else if (state.followFilter.platform !== 'all' && item.platform !== state.followFilter.platform) {
        return false;
      }
      return true;
    });
  }

  function renderCards() {
    const list = filtered();
    if (!follows.length) {
      body.replaceChildren(
        emptyState({
          iconName: 'heart',
          title: '还没有关注的主播',
          text: '进入任意直播间，点一下关注；关注的主播会出现在这里，支持按平台和标签整理。',
          actionLabel: '去首页发现主播',
          onAction: () => ctx.go('home'),
        })
      );
      return;
    }
    if (!list.length) {
      body.replaceChildren(
        emptyState({ iconName: 'filter', title: '没有符合条件的主播', text: '换一个标签或筛选条件试试。', compact: true })
      );
      return;
    }
    const grid = document.createElement('div');
    grid.className = state.followView === 'grid' ? 'follow-grid' : 'follow-list-view';
    for (const item of list) {
      const card = document.createElement('article');
      card.className = 'follow-card';
      card.tabIndex = 0;
      card.innerHTML = `
        <span class="card-platform">${platformIcon(item.platform, 17)}</span>
        ${avatarHtml(item.user_name, item.cover, state.followView === 'grid' ? 62 : 44)}
        <div class="follow-name">${escapeHtml(item.user_name || '未知主播')}</div>
        <div class="follow-meta">
          <span class="follow-status${item.live ? ' live' : ''}">${item.live ? '直播中' : '未开播'}</span>
          <span>·</span>
          <span>${escapeHtml(PLATFORM_META[item.platform]?.short || item.platform)}</span>
          ${item.tag ? `<span>·</span><span>${escapeHtml(item.tag)}</span>` : ''}
        </div>
        <div class="follow-actions">
          <button class="tag-btn${item.tag ? ' active' : ''}" title="设置标签">${icon('star', 16)}</button>
          <button class="remove-btn" title="取消关注">${icon('userMinus', 16)}</button>
        </div>`;
      card.addEventListener('click', () => ctx.openRoom(item.platform, item.room_id));
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') ctx.openRoom(item.platform, item.room_id);
      });
      card.querySelector('.tag-btn').addEventListener('click', async (event) => {
        event.stopPropagation();
        const tag = await promptDialog({
          title: '设置标签',
          text: `给「${item.user_name}」一个分组标签，方便在关注页筛选。`,
          placeholder: '例如：游戏、歌势、朋友',
          value: item.tag || '',
        });
        if (tag === null) return;
        updateFollow(item.platform, item.room_id, { tag: tag || '默认' });
        refresh();
        toast(tag ? `已归到「${tag}」` : '已清除标签', 'success');
      });
      card.querySelector('.remove-btn').addEventListener('click', async (event) => {
        event.stopPropagation();
        const ok = await confirmDialog({
          title: '取消关注',
          text: `确定不再关注「${item.user_name}」吗？`,
          okLabel: '取消关注',
          danger: true,
        });
        if (!ok) return;
        const list = removeFollow(item.platform, item.room_id);
        if (!list.length) {
          // 空列表时重建整页，让标签栏同步清空
          ctx.go('follow');
        } else {
          refresh();
        }
        toast('已取消关注');
      });
      grid.appendChild(card);
    }
    body.replaceChildren(grid);
    bindImageFallback(grid);
  }

  function refresh() {
    ctx.go('follow');
  }

  function renderAll() {
    renderTags();
    renderFilters();
    renderCards();
  }

  page.querySelectorAll('#follow-mode button').forEach((button) => {
    button.addEventListener('click', () => {
      state.followFilter.mode = button.dataset.mode;
      renderAll();
    });
  });

  page.querySelector('#follow-view').addEventListener('click', () => {
    state.followView = state.followView === 'grid' ? 'list' : 'grid';
    const button = page.querySelector('#follow-view');
    button.innerHTML = icon(state.followView === 'grid' ? 'gridView' : 'list', 18);
    renderCards();
  });
  page.querySelector('#follow-view').innerHTML = icon(state.followView === 'grid' ? 'gridView' : 'list', 18);

  page.querySelector('#follow-search').addEventListener('click', async () => {
    const keyword = await promptDialog({ title: '搜索关注', text: '按主播昵称筛选当前关注列表。', placeholder: '输入昵称' });
    if (!keyword) return;
    const list = follows.filter((item) => (item.user_name || '').toLowerCase().includes(keyword.toLowerCase()));
    body.replaceChildren(
      list.length
        ? (() => {
            const grid = document.createElement('div');
            grid.className = 'follow-grid';
            for (const item of list) {
              const card = document.createElement('article');
              card.className = 'follow-card';
              card.innerHTML = `${avatarHtml(item.user_name, item.cover, 62)}<div class="follow-name">${escapeHtml(item.user_name)}</div><div class="follow-meta">${escapeHtml(item.tag || '默认')}</div>`;
              card.addEventListener('click', () => ctx.openRoom(item.platform, item.room_id));
              grid.appendChild(card);
            }
            return grid;
          })()
        : emptyState({ iconName: 'search', title: '没有找到', text: `关注列表里没有包含「${keyword}」的主播。`, compact: true })
    );
  });

  page.querySelector('#follow-filter').addEventListener('click', (event) => {
    openMenu(event.currentTarget, [
      { label: '全部', active: state.followFilter.status === 'all', onClick: () => { state.followFilter.status = 'all'; renderAll(); } },
      { label: '只看直播中', active: state.followFilter.status === 'live', onClick: () => { state.followFilter.status = 'live'; renderAll(); } },
      { label: '只看未开播', active: state.followFilter.status === 'offline', onClick: () => { state.followFilter.status = 'offline'; renderAll(); } },
    ]);
  });

  page.querySelector('#follow-multi').addEventListener('click', () => {
    toast('多开同屏：当前版本先提供单个直播间，多窗口排布在后续版本接入。');
  });

  page.querySelector('#follow-more').addEventListener('click', (event) => {
    openMenu(event.currentTarget, [
      { label: '导出关注列表', icon: 'download', onClick: () => exportFollow() },
      { label: '导入关注列表', icon: 'upload', onClick: () => importFollow(refresh) },
      { separator: true },
      {
        label: '清空关注列表',
        icon: 'close',
        onClick: async () => {
          if (!follows.length) return;
          const ok = await confirmDialog({ title: '清空关注', text: '会删除本机保存的全部关注记录，确定吗？', okLabel: '清空', danger: true });
          if (!ok) return;
          localStorage.removeItem('simple-live.follow.v2');
          ctx.go('follow');
          toast('已清空关注列表');
        },
      },
    ]);
  });

  page.querySelector('#follow-refresh').addEventListener('click', () => {
    toast('关注状态会在进入直播间时更新；当前版本不做后台轮询。');
  });

  document.getElementById('view').appendChild(page);
  renderAll();
  return () => {};
}

function exportFollow() {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    follows: loadFollow(),
    settings: state.settings,
    history: state.history,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `simple-live-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出关注与设置', 'success');
}

function importFollow(after) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (Array.isArray(data.follows)) {
        localStorage.setItem('simple-live.follow.v2', JSON.stringify(data.follows));
      }
      if (data.settings) {
        localStorage.setItem('simple-live.settings.v2', JSON.stringify(data.settings));
      }
      if (Array.isArray(data.history)) {
        localStorage.setItem('simple-live.history.v2', JSON.stringify(data.history));
      }
      toast('导入成功，正在刷新…', 'success');
      after?.();
    } catch (error) {
      toast(`导入失败：${error}`, 'error');
    }
  });
  input.click();
}
