// Simple Live · Tauri 前端
// 一级：首页 / 关注 / 分类 / 设置（列表 → 二级详情）；二级：直播间。

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const PLATFORM_NAMES = { bilibili: '哔哩哔哩', douyu: '斗鱼', huya: '虎牙' };
const AREA_NAMES = { top: '上半屏', bottom: '下半屏', full: '全屏' };

const DEFAULTS = {
  enabled: true,
  font: 16,
  weight: 600,
  speed: 110,
  lanes: 8,
  area: 'top',
  opacity: 1,
  stroke: 2,
  dedupe: true,
};

const state = {
  platform: 'bilibili',
  page: 'home',
  home: [],
  searchResults: [],
  searching: false,
  categories: [],
  parentIndex: 0,
  subIndex: 0,
  categoryRooms: [],
  room: null,
  player: null,
  lane: 0,
  recent: new Map(),
  settings: loadSettings(),
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('danmaku-settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  localStorage.setItem('danmaku-settings', JSON.stringify(state.settings));
}

const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

const PAGES = ['home', 'category', 'follow', 'settings', 'detail', 'room'];

function showPage(page) {
  state.page = page;
  for (const name of PAGES) {
    $(`page-${name}`).classList.toggle('hidden', name !== page);
  }
  for (const button of document.querySelectorAll('.rail-btn')) {
    const target = button.dataset.page;
    button.classList.toggle('active', target === page || (page === 'detail' && target === 'settings'));
  }
  if (page !== 'room') stopPlayback();
}

// ---------------------------------------------------------------- 列表

function renderCards(container, rooms) {
  container.innerHTML = '';
  if (!rooms.length) {
    container.innerHTML = '<div class="muted">这里还没有内容</div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const room of rooms) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="cover"><img loading="lazy" alt="" /></div>
      <div class="card-title"></div>
      <div class="card-foot"><span></span><span></span></div>`;
    const cover = card.querySelector('img');
    if (room.cover) {
      cover.src = room.cover;
      cover.addEventListener('error', () => cover.remove());
    } else {
      cover.remove();
    }
    card.querySelector('.card-title').textContent = room.title || '(无标题)';
    card.querySelectorAll('.card-foot span')[0].textContent = room.user_name || '';
    card.querySelectorAll('.card-foot span')[1].textContent = formatOnline(room.online);
    card.addEventListener('click', () => openRoom(state.platform, room.room_id));
    fragment.appendChild(card);
  }
  container.appendChild(fragment);
}

function formatOnline(online) {
  const value = Number(online) || 0;
  return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : `${value}`;
}

async function loadHome() {
  state.searching = false;
  state.searchResults = [];
  $('home-title').textContent = `${PLATFORM_NAMES[state.platform]} · 热门排行`;
  $('grid').innerHTML = '<div class="muted">加载中…</div>';
  try {
    state.home = await invoke('recommend', { platform: state.platform, page: 1 });
    renderCards($('grid'), state.home);
  } catch (error) {
    $('grid').innerHTML = `<div class="muted">加载失败：${error}</div>`;
  }
}

async function doSearch() {
  const input = $('search-input').value.trim();
  if (!input) return;

  const direct = parseRoomInput(input);
  if (direct) {
    state.platform = direct.platform;
    syncPlatformButtons();
    openRoom(direct.platform, direct.roomId);
    return;
  }

  showPage('home');
  state.searching = true;
  $('home-title').textContent = `搜索结果：${input}`;
  $('grid').innerHTML = '<div class="muted">搜索中…</div>';
  try {
    state.searchResults = await invoke('search', { platform: state.platform, keyword: input });
    renderCards($('grid'), state.searchResults);
  } catch (error) {
    $('grid').innerHTML = `<div class="muted">搜索失败：${error}</div>`;
  }
}

function parseRoomInput(text) {
  const match = text.match(/(?:live\.bilibili\.com|douyu\.com|huya\.com)\/([A-Za-z0-9_-]+)/i);
  if (match) {
    const host = text.toLowerCase();
    const platform = host.includes('bilibili')
      ? 'bilibili'
      : host.includes('douyu')
        ? 'douyu'
        : 'huya';
    return { platform, roomId: match[1] };
  }
  if (/^[A-Za-z0-9_-]{1,32}$/.test(text)) {
    return { platform: state.platform, roomId: text };
  }
  return null;
}

// ---------------------------------------------------------------- 分类

async function loadCategories() {
  $('parents').innerHTML = '<span class="muted">加载分类…</span>';
  try {
    state.categories = await invoke('categories', { platform: state.platform });
  } catch (error) {
    $('parents').innerHTML = `<span class="muted">分类加载失败：${error}</span>`;
    return;
  }
  state.parentIndex = 0;
  state.subIndex = 0;
  renderParents();
  renderSubs();
  loadCategoryRooms();
}

function renderParents() {
  const box = $('parents');
  box.innerHTML = '';
  state.categories.forEach((category, index) => {
    const button = document.createElement('button');
    button.textContent = category.name;
    button.className = index === state.parentIndex ? 'active' : '';
    button.addEventListener('click', () => {
      state.parentIndex = index;
      state.subIndex = 0;
      renderParents();
      renderSubs();
      loadCategoryRooms();
    });
    box.appendChild(button);
  });
}

function renderSubs() {
  const box = $('subs');
  box.innerHTML = '';
  const parent = state.categories[state.parentIndex];
  if (!parent) return;
  parent.children.forEach((sub, index) => {
    const button = document.createElement('button');
    button.textContent = sub.name;
    button.className = index === state.subIndex ? 'active' : '';
    button.addEventListener('click', () => {
      state.subIndex = index;
      renderSubs();
      loadCategoryRooms();
    });
    box.appendChild(button);
  });
}

async function loadCategoryRooms() {
  const parent = state.categories[state.parentIndex];
  const sub = parent && parent.children[state.subIndex];
  if (!sub) {
    $('cat-grid').innerHTML = '<div class="muted">该分类下没有子分区</div>';
    return;
  }
  $('cat-grid').innerHTML = '<div class="muted">加载中…</div>';
  try {
    state.categoryRooms = await invoke('category_rooms', {
      platform: state.platform,
      parentId: sub.parent_id,
      subId: sub.id,
      name: sub.name,
    });
    renderCards($('cat-grid'), state.categoryRooms);
  } catch (error) {
    $('cat-grid').innerHTML = `<div class="muted">加载失败：${error}</div>`;
  }
}

// ---------------------------------------------------------------- 设置

const DANMAKU_ROWS = [
  { key: 'enabled', label: '弹幕开关' },
  { key: 'font', label: '字体大小' },
  { key: 'weight', label: '字体粗细' },
  { key: 'speed', label: '滚动速度' },
  { key: 'lanes', label: '显示行数（密度）' },
  { key: 'area', label: '显示区域' },
  { key: 'opacity', label: '不透明度' },
  { key: 'stroke', label: '描边宽度' },
  { key: 'dedupe', label: '重复弹幕过滤' },
];

function settingValue(key) {
  const s = state.settings;
  switch (key) {
    case 'enabled':
      return s.enabled ? '开' : '关';
    case 'dedupe':
      return s.dedupe ? '开' : '关';
    case 'font':
      return `${s.font} px`;
    case 'weight':
      return `${s.weight}`;
    case 'speed':
      return `${s.speed} px/s`;
    case 'lanes':
      return `${s.lanes} 行`;
    case 'area':
      return AREA_NAMES[s.area];
    case 'opacity':
      return `${Math.round(s.opacity * 100)}%`;
    case 'stroke':
      return `${s.stroke} px`;
    default:
      return '';
  }
}

function cycleSetting(key) {
  const s = state.settings;
  switch (key) {
    case 'enabled':
      s.enabled = !s.enabled;
      if (!s.enabled) $('danmaku-layer').innerHTML = '';
      break;
    case 'dedupe':
      s.dedupe = !s.dedupe;
      break;
    case 'font':
      s.font = s.font === 16 ? 20 : s.font === 20 ? 26 : 16;
      break;
    case 'weight':
      s.weight = s.weight === 600 ? 700 : s.weight === 700 ? 400 : 600;
      break;
    case 'speed':
      s.speed = s.speed === 110 ? 180 : s.speed === 180 ? 260 : 110;
      break;
    case 'lanes':
      s.lanes = s.lanes === 8 ? 12 : s.lanes === 12 ? 6 : 8;
      break;
    case 'area':
      s.area = s.area === 'top' ? 'bottom' : s.area === 'bottom' ? 'full' : 'top';
      break;
    case 'opacity':
      s.opacity = s.opacity === 1 ? 0.8 : s.opacity === 0.8 ? 0.6 : 1;
      break;
    case 'stroke':
      s.stroke = s.stroke === 2 ? 3 : s.stroke === 3 ? 1 : 2;
      break;
    default:
      break;
  }
  saveSettings();
  applyDanmakuStyle();
  renderDetail();
  $('danmaku-toggle').textContent = s.enabled ? '弹幕开' : '弹幕关';
}

function applyDanmakuStyle() {
  const root = document.documentElement.style;
  root.setProperty('--dm-font', `${state.settings.font}px`);
  root.setProperty('--dm-weight', `${state.settings.weight}`);
  root.setProperty('--dm-opacity', `${state.settings.opacity}`);
  root.setProperty('--dm-stroke', `${state.settings.stroke}px`);
}

let detailKind = 'danmaku';

function showDetail(kind) {
  detailKind = kind;
  $('detail-title').textContent =
    kind === 'danmaku' ? '弹幕设置' : kind === 'appearance' ? '外观设置' : '关于';
  showPage('detail');
  renderDetail();
}

function renderDetail() {
  const body = $('detail-body');
  body.innerHTML = '';

  if (detailKind === 'danmaku') {
    for (const row of DANMAKU_ROWS) {
      body.appendChild(makeRow(row.label, settingValue(row.key), () => cycleSetting(row.key)));
    }
    return;
  }

  if (detailKind === 'appearance') {
    for (const [label, dark] of [
      ['深色主题', true],
      ['浅色主题', false],
    ]) {
      body.appendChild(
        makeRow(label, document.body.dataset.theme === 'light' ? (dark ? '' : '当前') : dark ? '当前' : '', () => {
          document.body.dataset.theme = dark ? 'dark' : 'light';
          document.body.classList.toggle('light', !dark);
          renderDetail();
        })
      );
    }
    return;
  }

  const info = [
    ['版本', '0.1.0（Tauri 2）'],
    ['协议层', 'live_core：哔哩哔哩 / 斗鱼 / 虎牙'],
    ['播放', 'mpegts.js（FLV over MSE）'],
  ];
  for (const [label, value] of info) {
    body.appendChild(makeRow(label, value, null));
  }
  const link = makeRow('打开原项目主页', '↗', () => {
    invoke('open_url', { url: 'https://github.com/xiaoyaocz/dart_simple_live' }).catch(() => {});
  });
  body.appendChild(link);
}

function makeRow(label, value, onClick) {
  const row = document.createElement('button');
  row.className = 'row';
  const left = document.createElement('span');
  left.textContent = label;
  const right = document.createElement('span');
  right.className = 'value';
  right.textContent = value;
  row.append(left, right);
  if (onClick) {
    row.addEventListener('click', onClick);
  } else {
    row.style.cursor = 'default';
  }
  return row;
}

// ---------------------------------------------------------------- 直播间

async function openRoom(platform, roomId) {
  showPage('room');
  state.room = null;
  $('room-title').textContent = '正在读取房间…';
  $('room-meta').textContent = '';
  $('qualities').innerHTML = '';
  $('chat-list').innerHTML = '';
  $('chat-count').textContent = '0';
  setHint('正在读取房间…');

  let payload;
  try {
    payload = await invoke('open_room', { platform, roomId });
  } catch (error) {
    setHint(`打不开这个房间：${error}`);
    $('room-title').textContent = '打开失败';
    return;
  }

  state.room = {
    key: payload.key,
    detail: payload.detail,
    qualities: payload.qualities,
    urls: [],
    headers: [],
    index: -1,
  };
  $('room-title').textContent = payload.detail.title || '(无标题)';
  $('room-meta').textContent = `${payload.detail.user_name} · ${formatOnline(payload.detail.online)} 人气`;
  $('room-state').textContent = payload.detail.live ? '直播中' : '未开播';

  renderQualities();
  await selectQuality(0);
  try {
    await invoke('start_danmaku', { key: state.room.key });
  } catch (error) {
    toast(`弹幕连接失败：${error}`);
  }
}

function renderQualities() {
  const box = $('qualities');
  box.innerHTML = '';
  state.room.qualities.forEach((name, index) => {
    const button = document.createElement('button');
    button.textContent = name;
    button.className = index === state.room.index ? 'active' : '';
    button.addEventListener('click', () => selectQuality(index));
    box.appendChild(button);
  });
  $('line-info').textContent = `线路 1/${state.room.urls.length || 0}`;
}

async function selectQuality(index) {
  if (!state.room) return;
  setHint('正在取流…');
  try {
    const payload = await invoke('play', { key: state.room.key, index });
    state.room.urls = payload.urls;
    state.room.headers = payload.headers;
    state.room.index = index;
    renderQualities();
    if (payload.urls.length) {
      playStream(payload.urls[0], payload.headers);
    } else {
      setHint('没有可用的播放地址');
    }
  } catch (error) {
    setHint(`取流失败：${error}`);
    toast(`取流失败：${error}`);
  }
}

function playStream(url, headers) {
  stopPlayer();
  if (!window.mpegts || !mpegts.isSupported()) {
    setHint('当前 WebView 不支持 FLV 播放');
    return;
  }
  const source = { type: 'flv', url, isLive: true, cors: true };
  if (headers && headers.length) {
    source.headers = Object.fromEntries(headers);
  }
  const player = mpegts.createPlayer(source, {
    enableStaleStreamCleanup: true,
    liveBufferLatencyChasing: true,
    autoCleanupSourceBuffer: true,
  });
  player.attachMediaElement($('player'));
  player.on(mpegts.Events.ERROR, (_type, detail) => {
    setHint(`播放失败：${detail || '未知错误'}`);
  });
  player.load();
  $('player').play().catch(() => {});
  state.player = player;
  setHint(null);
}

function stopPlayer() {
  if (state.player) {
    try {
      state.player.pause();
      state.player.unload();
      state.player.detachMediaElement();
      state.player.destroy();
    } catch {
      /* 忽略销毁异常 */
    }
    state.player = null;
  }
}

function stopPlayback() {
  stopPlayer();
  if (state.room) {
    invoke('stop_danmaku').catch(() => {});
  }
  $('danmaku-layer').innerHTML = '';
}

function setHint(text) {
  const el = $('stage-hint');
  if (text) {
    el.textContent = text;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ---------------------------------------------------------------- 弹幕

function appendChat(message) {
  const list = $('chat-list');
  const line = document.createElement('div');
  if (message.system) {
    line.className = 'chat-line system';
    line.textContent = message.text;
  } else {
    line.className = 'chat-line';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${message.user}：`;
    const text = document.createElement('span');
    text.textContent = message.text;
    if (message.color) {
      text.style.color = `#${message.color.toString(16).padStart(6, '0')}`;
    }
    line.append(who, text);
  }
  list.appendChild(line);
  while (list.childElementCount > 300) {
    list.removeChild(list.firstElementChild);
  }
  list.scrollTop = list.scrollHeight;
  $('chat-count').textContent = list.childElementCount;
}

function shouldDrop(text) {
  if (!state.settings.dedupe) return false;
  const now = Date.now();
  const last = state.recent.get(text) || 0;
  state.recent.set(text, now);
  if (state.recent.size > 500) {
    for (const [key, time] of state.recent) {
      if (now - time > 10000) state.recent.delete(key);
    }
  }
  return now - last < 5000;
}

function spawnDanmaku(message) {
  const layer = $('danmaku-layer');
  const stage = $('stage');
  if (!layer || !stage || state.page !== 'room') return;
  if (shouldDrop(message.text)) return;

  const el = document.createElement('div');
  el.className = 'danmaku';
  el.textContent = message.text;
  el.style.color = message.color ? `#${message.color.toString(16).padStart(6, '0')}` : '#ffffff';
  layer.appendChild(el);

  const width = stage.clientWidth;
  const lineHeight = state.settings.font + 8;
  const lanes = Math.max(1, state.settings.lanes);
  const lane = state.lane++ % lanes;
  const offset = state.settings.area === 'bottom' ? stage.clientHeight * 0.45 : 0;
  const top = Math.min(offset + lane * lineHeight + 6, stage.clientHeight - lineHeight);
  el.style.top = `${top}px`;

  const duration = ((width + el.offsetWidth) / state.settings.speed) * 1000;
  const animation = el.animate(
    [
      { transform: `translateX(${width}px)` },
      { transform: `translateX(${-el.offsetWidth}px)` },
    ],
    { duration, easing: 'linear' }
  );
  animation.onfinish = () => el.remove();
}

// ---------------------------------------------------------------- 绑定

function syncPlatformButtons() {
  for (const button of document.querySelectorAll('#platforms button')) {
    button.classList.toggle('active', button.dataset.platform === state.platform);
  }
}

function bind() {
  for (const button of document.querySelectorAll('.rail-btn')) {
    button.addEventListener('click', () => {
      const page = button.dataset.page;
      showPage(page);
      if (page === 'home') loadHome();
      if (page === 'category') loadCategories();
    });
  }

  for (const row of document.querySelectorAll('[data-detail]')) {
    row.addEventListener('click', () => showDetail(row.dataset.detail));
  }
  $('detail-back').addEventListener('click', () => {
    showPage('settings');
  });

  for (const button of document.querySelectorAll('#platforms button')) {
    button.addEventListener('click', () => {
      state.platform = button.dataset.platform;
      syncPlatformButtons();
      showPage('home');
      loadHome();
    });
  }

  $('search-btn').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doSearch();
  });
  $('home-refresh').addEventListener('click', loadHome);

  $('back').addEventListener('click', () => {
    showPage('home');
    loadHome();
  });

  $('pause').addEventListener('click', () => {
    const video = $('player');
    if (video.paused) {
      video.play().catch(() => {});
      $('pause').textContent = '暂停';
    } else {
      video.pause();
      $('pause').textContent = '继续';
    }
  });

  $('danmaku-toggle').addEventListener('click', () => cycleSetting('enabled'));

  $('switch-line').addEventListener('click', () => {
    if (!state.room || state.room.urls.length <= 1) return;
    const current = Number($('line-info').dataset.line || 0);
    const next = (current + 1) % state.room.urls.length;
    $('line-info').dataset.line = next;
    playStream(state.room.urls[next], state.room.headers);
    $('line-info').textContent = `线路 ${next + 1}/${state.room.urls.length}`;
  });

  $('refresh-stream').addEventListener('click', () => {
    if (state.room) selectQuality(state.room.index < 0 ? 0 : state.room.index);
  });

  $('copy-url').addEventListener('click', async () => {
    const url = state.room && state.room.urls[0];
    if (!url) return;
    try {
      await invoke('copy_text', { text: url });
      toast('已复制直链');
    } catch (error) {
      toast(`复制失败：${error}`);
    }
  });

  $('open-page').addEventListener('click', () => {
    if (!state.room) return;
    invoke('open_url', { url: state.room.detail.url }).catch((error) => toast(`打开失败：${error}`));
  });
}

async function main() {
  document.body.dataset.theme = 'dark';
  bind();
  applyDanmakuStyle();
  $('danmaku-toggle').textContent = state.settings.enabled ? '弹幕开' : '弹幕关';
  await listen('danmaku', (event) => {
    const message = event.payload;
    appendChat(message);
    if (!message.system && state.settings.enabled) spawnDanmaku(message);
  });
  await loadHome();
}

main().catch((error) => toast(`初始化失败：${error}`));
