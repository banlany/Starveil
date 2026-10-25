// 搜索：房间链接解析 / 纯房间号直达 / 关键词搜索。
import { api, ALL_PLATFORMS, formatOnline } from '../api.js';
import { icon, PLATFORM_META, platformIcon } from '../icons.js';
import { addSearchHistory, clearSearchHistory, state } from '../store.js';
import {
  avatarHtml,
  bindImageFallback,
  emptyState,
  escapeHtml,
  openMenu,
  roomCard,
  skeletonGrid,
  spinner,
  toast,
} from '../ui.js';

function isUrlLike(text) {
  return /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/|$)/i.test(text.trim());
}

function isRoomId(text) {
  return /^[A-Za-z0-9_-]{3,32}$/.test(text.trim()) && !/^\d{1,2}$/.test(text.trim());
}

export function renderSearch(ctx, params = {}) {
  let searchType = state.search.mode || 'room';
  const page = document.createElement('section');
  page.className = 'search-page';
  page.innerHTML = `
    <div class="search-top">
      <div class="search-bar">
        <button class="search-back" title="返回">${icon('back', 19)}</button>
        <button class="search-type" id="search-type"></button>
        <input id="search-input" type="text" autocomplete="off" spellcheck="false" placeholder="搜索直播间，或粘贴直播链接" />
        <button class="search-submit" title="搜索">${icon('search', 19)}</button>
      </div>
      <div class="search-tabs">${ALL_PLATFORMS.map((platform) => tabHtml(platform)).join('')}</div>
    </div>
    <div class="search-body" id="search-body"></div>`;
  const input = page.querySelector('#search-input');
  const body = page.querySelector('#search-body');
  const typeButton = page.querySelector('#search-type');

  function updateTypeUi() {
    typeButton.innerHTML = `${searchType === 'anchor' ? '主播' : '房间'} ${icon('chevronDown', 14)}`;
    input.placeholder = searchType === 'anchor' ? '输入主播昵称或主播 ID' : '搜索直播间，或粘贴直播链接';
    state.search.mode = searchType;
  }
  updateTypeUi();

  page.querySelector('.search-back').addEventListener('click', () => ctx.back());
  page.querySelector('.search-submit').addEventListener('click', () => submit());
  typeButton.addEventListener('click', (event) => {
    openMenu(event.currentTarget, [
      {
        label: '房间',
        active: searchType === 'room',
        onClick: () => {
          searchType = 'room';
          updateTypeUi();
          if (input.value.trim()) runSearch(input.value.trim());
          else renderIdle();
        },
      },
      {
        label: '主播',
        active: searchType === 'anchor',
        onClick: () => {
          searchType = 'anchor';
          updateTypeUi();
          if (input.value.trim()) runSearch(input.value.trim());
          else renderIdle();
        },
      },
    ], { align: 'start', gap: 12 });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });

  page.querySelectorAll('.search-tabs .platform-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const platform = tab.dataset.platform;
      if (!ctx.selectPlatform(platform, { silent: true })) return;
      page.querySelectorAll('.search-tabs .platform-tab').forEach((item) => {
        item.classList.toggle('active', item.dataset.platform === platform);
      });
      if (state.search.keyword) runSearch(state.search.keyword);
      else renderIdle();
    });
  });

  function renderIdle() {
    body.innerHTML = '';
    if (state.search.recent.length) {
      const head = document.createElement('div');
      head.className = 'recent-head';
      head.innerHTML = `<h3>最近搜索</h3><button>清空</button>`;
      head.querySelector('button').addEventListener('click', () => {
        clearSearchHistory();
        renderIdle();
      });
      body.appendChild(head);
      const list = document.createElement('div');
      list.className = 'recent-list';
      for (const keyword of state.search.recent) {
        const chip = document.createElement('button');
        chip.className = 'recent-chip';
        chip.innerHTML = `${icon('history', 14)}${escapeHtml(keyword)}`;
        chip.addEventListener('click', () => {
          input.value = keyword;
          runSearch(keyword);
        });
        list.appendChild(chip);
      }
      body.appendChild(list);
    }
    const tips = document.createElement('div');
    tips.className = 'pill-note';
    tips.innerHTML =
      searchType === 'anchor'
        ? `${icon('info', 16)}<div>按 <b>主播昵称</b> 或 <b>主播 ID / UID</b> 搜索；结果会显示主播头像、直播间号和开播状态，点击即可进入直播间。</div>`
        : `${icon('info', 16)}<div>支持粘贴 <b>live.bilibili.com/房间号</b>、<b>douyu.com/房间号</b>、<b>huya.com/房间号</b> 直达直播间；也可以直接输入房间标题搜索。</div>`;
    body.appendChild(tips);
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.appendChild(
      emptyState({
        iconName: 'search',
        title: searchType === 'anchor' ? '搜索主播吧' : '搜点什么吧',
        text: searchType === 'anchor' ? '输入主播昵称或主播 ID，找到正在直播的主播。' : '搜索房间，或从剪贴板粘贴一条直播链接。',
        compact: true,
      })
    );
    body.appendChild(empty);
  }

  async function submit() {
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    if (searchType === 'anchor') {
      runSearch(value);
      return;
    }
    if (isUrlLike(value)) {
      try {
        const result = await api.resolveInput(state.platform, value);
        if (result?.is_short_link) {
          toast('短链接需要先展开，请粘贴完整直播间地址。', 'error');
          return;
        }
        if (result?.platform && result?.room_id) {
          ctx.openRoom(result.platform, result.room_id);
          return;
        }
      } catch (error) {
        toast(`链接解析失败：${error}`, 'error');
        return;
      }
    }
    if (/^\d{3,}$/.test(value)) {
      ctx.openRoom(state.platform, value);
      return;
    }
    if (isRoomId(value) && value.length < 10 && !/[\u4e00-\u9fa5]/.test(value) && /^[A-Za-z]+\d+$|^\d+[A-Za-z]+$/.test(value)) {
      // 形如 abc123 / 123abc 的更可能是房间号
      ctx.openRoom(state.platform, value);
      return;
    }
    runSearch(value);
  }

  async function runSearch(keyword) {
    state.search.keyword = keyword;
    addSearchHistory(keyword);
    input.value = keyword;
    if (searchType === 'anchor') {
      await runAnchorSearch(keyword);
      return;
    }
    body.replaceChildren(skeletonGrid(10));
    const platform = state.platform;
    try {
      const results = await api.search(platform, keyword);
      if (ctx.route() !== 'search') return;
      state.search.results = results;
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'search-hint';
      hint.innerHTML = `在 <strong>${escapeHtml(PLATFORM_META[platform]?.name || platform)}</strong> 搜索 <strong>${escapeHtml(keyword)}</strong> · 共 ${results.length} 个结果`;
      body.appendChild(hint);
      if (!results.length) {
        body.appendChild(
          emptyState({
            iconName: 'search',
            title: '没有找到相关直播',
            text: '试试更短的关键词，或者切换平台搜索。',
            compact: true,
          })
        );
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'room-grid';
      for (const room of results) {
        grid.appendChild(
          roomCard({ ...room, platform }, { onOpen: (item) => ctx.openRoom(item.platform || platform, item.room_id) })
        );
      }
      body.appendChild(grid);
    } catch (error) {
      if (ctx.route() !== 'search') return;
      body.innerHTML = '';
      body.appendChild(
        emptyState({
          iconName: 'info',
          title: '搜索失败',
          text: String(error),
          actionLabel: '重试',
          onAction: () => runSearch(keyword),
          compact: true,
        })
      );
    }
  }

  async function runAnchorSearch(keyword) {
    state.search.keyword = keyword;
    addSearchHistory(keyword);
    input.value = keyword;
    body.replaceChildren(spinner('正在搜索主播…'));
    const platform = state.platform;
    try {
      const anchors = await api.searchAnchors(platform, keyword);
      if (ctx.route() !== 'search') return;
      state.search.anchors = anchors;
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'search-hint';
      hint.innerHTML = `在 <strong>${escapeHtml(PLATFORM_META[platform]?.name || platform)}</strong> 搜索主播 <strong>${escapeHtml(keyword)}</strong> · 共 ${anchors.length} 位`;
      body.appendChild(hint);
      if (!anchors.length) {
        body.appendChild(
          emptyState({
            iconName: 'users',
            title: '没有找到相关主播',
            text: '可以输入更完整的主播昵称，或直接输入主播 ID / 直播间号。',
            compact: true,
          })
        );
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'anchor-grid';
      for (const anchor of anchors) {
        const card = document.createElement('article');
        card.className = 'anchor-card';
        card.tabIndex = 0;
        card.innerHTML = `
          ${avatarHtml(anchor.user_name, anchor.avatar, 54)}
          <div class="anchor-body">
            <div class="anchor-name" title="${escapeHtml(anchor.user_name)}">${escapeHtml(anchor.user_name || '未知主播')}</div>
            <div class="anchor-meta">
              <span class="follow-status${anchor.live ? ' live' : ''}">${anchor.live ? '直播中' : '未开播'}</span>
              <span>UID ${escapeHtml(anchor.uid || '-')}</span>
              <span>房间 ${escapeHtml(anchor.room_id)}</span>
            </div>
          </div>
          <span class="anchor-enter">进入 ${icon('chevron', 15)}</span>`;
        const enter = () => ctx.openRoom(anchor.platform || platform, anchor.room_id);
        card.addEventListener('click', enter);
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') enter();
        });
        grid.appendChild(card);
      }
      bindImageFallback(grid);
      body.appendChild(grid);
    } catch (error) {
      if (ctx.route() !== 'search') return;
      body.innerHTML = '';
      body.appendChild(
        emptyState({
          iconName: 'info',
          title: '主播搜索失败',
          text: String(error),
          actionLabel: '重试',
          onAction: () => runAnchorSearch(keyword),
          compact: true,
        })
      );
    }
  }

  if (params.keyword) {
    input.value = params.keyword;
    runSearch(params.keyword);
  } else if (
    state.search.keyword &&
    (searchType === 'anchor' ? state.search.anchors.length : state.search.results.length)
  ) {
    input.value = state.search.keyword;
    runSearch(state.search.keyword);
  } else {
    renderIdle();
  }

  document.getElementById('view').appendChild(page);
  setTimeout(() => input.focus(), 60);
  return () => {};
}

function tabHtml(platform) {
  const active = state.platform === platform;
  return `<button class="platform-tab${active ? ' active' : ''}" data-platform="${platform}">${platformIcon(platform, 22)}<span>${escapeHtml(PLATFORM_META[platform].name)}</span></button>`;
}
