// 关注页：本地关注列表、标签与平台筛选。
import { api, formatOnline, formatCount } from '../api.js';
import { icon, PLATFORM_META, platformIcon } from '../icons.js';
import { collectAccounts, followKey, loadFollow, removeFollow, restoreAccounts, saveFollow, state, updateFollow } from '../store.js';
import { avatarHtml, bindImageFallback, confirmDialog, emptyState, escapeHtml, openMenu, promptDialog, saveJsonFile, toast } from '../ui.js';

/// 上次刷新完成的时间。
///
/// 刷新结束会 `ctx.go('follow')` 重进本页，「进入页面自动刷新」如果只看开关，
/// 就会变成刷新→重进→再刷新 的死循环。所以 5 分钟内只自动刷一次。
const AUTO_REFRESH_COOLDOWN = 5 * 60 * 1000;
let lastRefreshFinishedAt = 0;

export function renderFollow(ctx) {
  const page = document.createElement('section');
  page.className = 'follow-page';
  const follows = loadFollow();
  const tags = [...new Set(follows.map((item) => item.tag || '默认'))];
  const platforms = [...new Set(follows.map((item) => item.platform))];

  page.innerHTML = `
    <div class="follow-sticky-sentinel" id="follow-sentinel" aria-hidden="true"></div>
    <div class="follow-sticky" id="follow-sticky">
    <header class="follow-header">
      <div class="header-left">
        <button class="icon-btn" id="follow-refresh" title="刷新直播状态">${icon('refresh', 19)}</button>
      </div>
      <h1>关注用户</h1>
      <div class="header-right">
        <button class="icon-btn" id="follow-search" title="搜索关注">${icon('search', 19)}</button>
        <button class="icon-btn" id="follow-view" title="切换布局">${icon('gridView', 18)}</button>
        <button class="icon-btn" id="follow-more" title="更多">${icon('more', 19)}</button>
      </div>
    </header>
    <div class="follow-toolbar">
      <div class="follow-row follow-search-row">
        <div class="follow-search">
          <input id="follow-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="按主播昵称搜索关注" />
          <button class="follow-search-go" id="follow-search-go" title="搜索">${icon('search', 17)}</button>
        </div>
        <span class="follow-count" id="follow-count">${follows.length} 位主播</span>
      </div>
      <div class="follow-row">
        <span class="follow-label">标签</span>
        <div class="follow-row" id="follow-tags" style="gap:8px"></div>
      </div>
      <div class="follow-row">
        <div class="follow-mode" id="follow-mode">
          <button data-mode="status" class="${state.followFilter.mode === 'status' ? 'active' : ''}">${icon('check', 13)}按状态</button>
          <button data-mode="platform" class="${state.followFilter.mode === 'platform' ? 'active' : ''}">按平台</button>
        </div>
        <div class="follow-row" id="follow-filters" style="gap:8px"></div>
      </div>
    </div>
    </div>
    <div id="follow-body"></div>`;

  const tagsBox = page.querySelector('#follow-tags');
  const filtersBox = page.querySelector('#follow-filters');
  const body = page.querySelector('#follow-body');
  const searchInput = page.querySelector('#follow-search-input');

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
    // 「按状态 / 按平台」两个按钮要跟着 mode 变，否则点了看不出区别。
    for (const button of page.querySelectorAll('#follow-mode button')) {
      const active = button.dataset.mode === state.followFilter.mode;
      const label = button.dataset.mode === 'status' ? '按状态' : '按平台';
      button.classList.toggle('active', active);
      button.innerHTML = `${active ? icon('check', 13) : ''}${label}`;
    }
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
    // 搜索条件也显示在这一行，并带一个清除入口。
    const keyword = String(state.followFilter.keyword || '').trim();
    if (keyword) {
      const clear = chip(`搜索：${keyword}`, true, () => {
        state.followFilter.keyword = '';
        renderAll();
      });
      clear.classList.add('follow-search-chip');
      // icon() 返回的是 HTML 字符串，不是 DOM 节点，
      // 直接 appendChild 会抛 TypeError，进而让整页渲染失败。
      clear.insertAdjacentHTML('beforeend', icon('close', 12));
      filtersBox.appendChild(clear);
    }
  }

  /// 直播中的排前面，其次按“进房次数”排，最后用最近访问时间和昵称兜底。
  function sortFollows(list) {
    return list.slice().sort((a, b) => {
      if (Boolean(a.live) !== Boolean(b.live)) return a.live ? -1 : 1;
      const clicks = (Number(b.clicks) || 0) - (Number(a.clicks) || 0);
      if (clicks) return clicks;
      const visit = (Number(b.lastVisit) || 0) - (Number(a.lastVisit) || 0);
      if (visit) return visit;
      return String(a.user_name || '').localeCompare(String(b.user_name || ''), 'zh-CN');
    });
  }

  function filtered() {
    const keyword = String(state.followFilter.keyword || '').trim().toLowerCase();
    return sortFollows(follows.filter((item) => {
      if (state.followFilter.tag !== 'all' && (item.tag || '默认') !== state.followFilter.tag) return false;
      if (state.followFilter.mode === 'status') {
        if (state.followFilter.status === 'live' && !item.live) return false;
        if (state.followFilter.status === 'offline' && item.live) return false;
      } else if (state.followFilter.platform !== 'all' && item.platform !== state.followFilter.platform) {
        return false;
      }
      // 搜索也走同一条筛选链，这样右上角计数永远等于最终结果数。
      // 主播名、房间标题、房间号都能搜到。
      if (keyword) {
        const haystack = `${item.user_name || ''} ${item.title || ''} ${item.room_id || ''}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    }));
  }

  /// 右上角计数跟随当前筛选：全部 / 直播中 / 未开播 / 某平台 各自显示自己的数量。
  function updateCount(list) {
    const box = page.querySelector('#follow-count');
    if (!box) return;
    const filter = state.followFilter;
    let label = '位主播';
    if (filter.mode === 'status') {
      if (filter.status === 'live') label = '位直播中';
      else if (filter.status === 'offline') label = '位未开播';
    } else if (filter.platform !== 'all') {
      label = `位 · ${PLATFORM_META[filter.platform]?.short || filter.platform}`;
    }
    // 有搜索条件时额外说明这是搜出来的数量。
    const keyword = String(filter.keyword || '').trim();
    box.textContent = keyword ? `${list.length} 位 · 搜索「${keyword}」` : `${list.length} ${label}`;
  }

  function renderCards() {
    const list = filtered();
    updateCount(list);
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
      // 搜索没命中要说清楚是「没搜到」，而不是笼统的「没符合条件」。
      const keyword = String(state.followFilter.keyword || '').trim();
      body.replaceChildren(
        keyword
          ? emptyState({
              iconName: 'search',
              title: '没有找到匹配的主播',
              text: `关注列表里没有包含「${keyword}」的主播，换个关键词试试，或清除搜索条件查看全部。`,
              actionLabel: '清除搜索条件',
              onAction: () => {
                state.followFilter.keyword = '';
                renderAll();
              },
              compact: true,
            })
          : emptyState({
              iconName: 'filter',
              title: '没有符合条件的主播',
              text: '换一个标签或筛选条件试试。',
              compact: true,
            })
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
        ${avatarHtml(item.user_name, item.avatar || item.cover, state.followView === 'grid' ? 62 : 44)}
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

  /// 执行一次搜索：把输入框内容写进筛选条件，重新渲染列表，然后清空输入框。
  /// 输入框是一次性入口，所以搜完就清空——下次直接输新词，不用先把上一次的删掉。
  function submitSearch() {
    const keyword = String(searchInput.value || '').trim();
    state.followFilter.keyword = keyword;
    searchInput.value = '';
    renderAll();
  }

  page.querySelector('#follow-search-go').addEventListener('click', submitSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSearch();
    }
  });
  // 右上角的搜索图标只是把焦点送到输入框，避免再弹一层对话框。
  page.querySelector('#follow-search').addEventListener('click', () => {
    searchInput.focus();
    searchInput.select();
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

  let alive = true;
  let refreshing = false;
  async function refreshFollowStatus() {
    if (refreshing) return;
    const list = loadFollow();
    if (!list.length) {
      toast('还没有关注的主播');
      return;
    }
    refreshing = true;
    const button = page.querySelector('#follow-refresh');
    button?.classList.add('is-loading');
    let cursor = 0;
    // 结果先攒在内存里，全部拉完再落一次盘：原先每个主播都走一次
    // updateFollow（load + 解析 + 序列化 + 写盘），200 个关注就是几百次同步 IO，
    // 刷新期间界面会明显发顿。
    const patches = new Map();
    const worker = async () => {
      while (cursor < list.length) {
        const item = list[cursor++];
        try {
          const payload = await api.openRoom(item.platform, item.room_id);
          patches.set(followKey(item.platform, item.room_id), {
            live: Boolean(payload.detail.live),
            title: payload.detail.title || item.title,
            user_name: payload.detail.user_name || item.user_name,
            avatar: payload.detail.avatar || item.avatar || '',
            cover: payload.detail.cover || item.cover || '',
            online: Number(payload.detail.online) || 0,
          });
        } catch {
          /* 单个房间失败不影响其他主播 */
        }
      }
    };
    // 并发数取设置里的「更新线程数」，0/未设置时按 4 跑。
    const threads = Math.max(1, Math.min(8, Number(state.settings.follow?.threads) || 4));
    await Promise.all(Array.from({ length: Math.min(threads, list.length) }, worker));
    if (patches.size) {
      saveFollow(
        list.map((item) => {
          const patch = patches.get(followKey(item.platform, item.room_id));
          return patch ? { ...item, ...patch } : item;
        })
      );
    }
    refreshing = false;
    lastRefreshFinishedAt = Date.now();
    if (!alive) return;
    button?.classList.remove('is-loading');
    toast('关注直播状态已刷新', 'success');
    ctx.go('follow');
  }

  page.querySelector('#follow-refresh').addEventListener('click', refreshFollowStatus);

  // 顶栏吸顶：哨兵滚出可视区域就说明顶栏已经贴在顶部，这时才补分隔阴影，
  // 否则没滚动时也会有一条多余的横线。
  const sticky = page.querySelector('#follow-sticky');
  const sentinel = page.querySelector('#follow-sentinel');
  let stickyObserver = null;
  if (sticky && sentinel && typeof IntersectionObserver === 'function') {
    stickyObserver = new IntersectionObserver(
      (entries) => {
        sticky.classList.toggle('is-stuck', !entries[0].isIntersecting);
      },
      { threshold: 0 }
    );
    stickyObserver.observe(sentinel);
  }

  document.getElementById('view').appendChild(page);
  renderAll();
  // 设置里打开「进入页面自动刷新」才自动拉一次；默认关闭，手动刷是主路径。
  if (
    state.settings.follow?.autoRefresh &&
    follows.length &&
    Date.now() - lastRefreshFinishedAt > AUTO_REFRESH_COOLDOWN
  ) {
    // 放到下一帧再发请求：页面已经挂上，用户能先看到列表和刷新图标转起来。
    requestAnimationFrame(() => {
      if (alive) refreshFollowStatus();
    });
  }
  return () => {
    alive = false;
    stickyObserver?.disconnect();
  };
}

async function exportFollow() {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    follows: loadFollow(),
    settings: state.settings,
    shield: {
      keywords: state.settings.danmaku?.blockKeywords || '',
      users: state.settings.danmaku?.blockUsers || '',
    },
    history: state.history,
    accounts: collectAccounts(),
  };
  const filename = `starveil-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const saved = await saveJsonFile(filename, data);
  if (saved) toast('已导出关注与设置', 'success');
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
      if (data.shield) {
        data.settings = data.settings || {};
        data.settings.danmaku = data.settings.danmaku || {};
        if (!data.settings.danmaku.blockKeywords) data.settings.danmaku.blockKeywords = data.shield.keywords || '';
        if (!data.settings.danmaku.blockUsers) data.settings.danmaku.blockUsers = data.shield.users || '';
      }
      if (data.settings) {
        localStorage.setItem('simple-live.settings.v2', JSON.stringify(data.settings));
      }
      if (Array.isArray(data.history)) {
        localStorage.setItem('simple-live.history.v2', JSON.stringify(data.history));
      }
      const restored = restoreAccounts(data.accounts);
      toast(restored.length ? `导入成功（含 ${restored.length} 个平台登录信息）` : '导入成功，正在刷新…', 'success');
      after?.();
    } catch (error) {
      toast(`导入失败：${error}`, 'error');
    }
  });
  input.click();
}
