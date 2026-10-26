// 设置：一级列表 + 二级详情。大部分选项会真正写入 localStorage 并即时生效。
import { api, formatCount, formatOnline, timeAgo, roomUrl } from '../api.js';
import {
  ACCENTS,
  applyTheme,
  clearHistory,
  clearLogin,
  collectAccounts,
  restoreAccounts,
  getSetting,
  loadLogin,
  resetSettings,
  saveLogin,
  setSetting,
  state,
} from '../store.js';
import { icon, PLATFORM_META, platformAsset } from '../icons.js';
import { setCloseToTray } from '../titlebar.js';
import {
  avatarHtml,
  confirmDialog,
  emptyState,
  escapeHtml,
  openMenu,
  openModal,
  promptDialog,
  roomGrid,
  saveJsonFile,
  toast,
  loadMore,
} from '../ui.js';

// 版本号兜底值：与 src-tauri/tauri.conf.json 的 version 保持一致；
// 运行时优先用 Tauri 的 app.getVersion() 覆盖，避免打包时漏改这里。
const FALLBACK_VERSION = '0.4.2';
// 参考项目（原版 dart_simple_live 的 fork）。
const REFERENCE_REPO = 'https://github.com/June6699/dart_simple_live';

const SETTINGS_ITEMS = [
  { key: 'history', icon: 'history', label: '观看记录' },
  { key: 'account', icon: 'account', label: '账号管理' },
  { key: 'sync', icon: 'sync', label: '数据同步' },
  { key: 'link', icon: 'parse', label: '链接解析' },
  { key: 'appearance', icon: 'moon', label: '外观设置' },
  { key: 'home', icon: 'home', label: '主页设置' },
  { key: 'player', icon: 'player', label: '播放页设置' },
  { key: 'live', icon: 'live', label: '直播设置' },
  { key: 'danmaku', icon: 'text', label: '弹幕设置' },
  { key: 'follow', icon: 'heart', label: '关注设置' },
  { key: 'timer', icon: 'timer', label: '定时关闭' },
  { key: 'other', icon: 'other', label: '其他设置' },
  { key: 'disclaimer', icon: 'shield', label: '免责声明' },
  { key: 'github', icon: 'github', label: '开源主页', action: 'github' },
];

const DETAIL_TITLES = {
  history: '观看记录',
  account: '账号管理',
  sync: '数据同步',
  link: '链接解析',
  appearance: '外观设置',
  home: '主页设置',
  player: '播放页设置',
  live: '直播设置',
  danmaku: '弹幕设置',
  follow: '关注设置',
  timer: '定时关闭',
  other: '其他设置',
  disclaimer: '免责声明',
  about: '关于星幕直播',
};

export function renderSettings(ctx) {
  const page = document.createElement('section');
  page.className = 'settings-page';
  page.innerHTML = `
    <div class="settings-shell">
      <div class="profile-row" id="profile-row">
        <div class="profile-logo"><img src="assets/logo.png" alt="星幕直播" /></div>
        <div class="profile-text">
          <h2>星幕直播</h2>
          <p>把喜欢的直播，放在同一幕</p>
        </div>
        <span class="chev">${icon('chevron', 18)}</span>
      </div>
      <div class="settings-list" id="settings-list"></div>
    </div>`;
  const list = page.querySelector('#settings-list');
  for (const item of SETTINGS_ITEMS) {
    const row = document.createElement('button');
    row.className = 'settings-item';
    const value =
      item.key === 'appearance'
        ? themeLabel(getSetting('appearance.theme'))
        : item.key === 'danmaku'
          ? `${getSetting('danmaku.font', 20)} px`
          : '';
    row.innerHTML = `
      <span class="item-icon">${icon(item.icon, 22)}</span>
      <span class="item-label">${escapeHtml(item.label)}</span>
      ${value ? `<span class="item-value">${escapeHtml(value)}</span>` : ''}
      <span class="chev">${icon('chevron', 17)}</span>`;
    row.addEventListener('click', () => {
      if (item.action) {
        runSettingAction(ctx, item.action);
        return;
      }
      ctx.go('settingsDetail', { key: item.key });
    });
    list.appendChild(row);
  }
  page.querySelector('#profile-row').addEventListener('click', () => ctx.go('settingsDetail', { key: 'about' }));
  document.getElementById('view').appendChild(page);
  return () => {};
}

export function renderSettingsDetail(ctx, params = {}) {
  const key = params.key || 'appearance';
  const title = DETAIL_TITLES[key] || '设置';
  const page = document.createElement('section');
  page.className = 'subpage detail-page';
  page.innerHTML = `
    <header class="subpage-header">
      <button class="icon-btn back-btn" title="返回">${icon('back', 20)}</button>
      <h1>${escapeHtml(title)}</h1>
    </header>
    <div class="settings-content" id="detail-content"></div>`;
  page.querySelector('.back-btn').addEventListener('click', () => ctx.back());
  const content = page.querySelector('#detail-content');

  function paint() {
    const scrollTop = document.getElementById('view').scrollTop;
    content.innerHTML = '';
    if (key === 'history') return paintHistory(content, ctx);
    if (key === 'sync') return paintSync(content, ctx, paint);
    if (key === 'link') return paintLink(content, ctx);
    if (key === 'about') return paintAbout(content, ctx);
    if (key === 'disclaimer') return paintDisclaimer(content, ctx, paint);
    if (key === 'account') return paintAccount(content, ctx);
    const sections = detailSections(key, ctx, paint);
    for (const section of sections) {
      if (section.label) {
        const label = document.createElement('div');
        label.className = 'settings-group-label';
        label.textContent = section.label;
        content.appendChild(label);
      }
      if (section.node) {
        content.appendChild(section.node);
        continue;
      }
      const group = document.createElement('div');
      group.className = 'settings-group';
      for (const row of section.rows || []) group.appendChild(buildRow(row, paint, ctx));
      content.appendChild(group);
    }
    if (sections.note) {
      const note = document.createElement('p');
      note.className = 'settings-note';
      note.textContent = sections.note;
      content.appendChild(note);
    }
    document.getElementById('view').scrollTop = scrollTop;
  }

  document.getElementById('view').appendChild(page);
  paint();
  return () => {};
}

// ---------------------------------------------------------------- 行构建

function buildRow(config, repaint, ctx) {
  if (config.type === 'radioGroup') {
    const fragment = document.createDocumentFragment();
    for (const option of config.options) {
      const row = document.createElement('div');
      row.className = 'setting-row clickable';
      const checked = getSetting(config.key) === option.value;
      row.innerHTML = `
        <span class="radio${checked ? ' checked' : ''}"></span>
        <div class="setting-info"><div class="setting-title">${escapeHtml(option.label)}</div>${option.desc ? `<div class="setting-desc">${escapeHtml(option.desc)}</div>` : ''}</div>`;
      row.addEventListener('click', () => {
        setSetting(config.key, option.value);
        if (config.onChange) config.onChange(option.value);
        repaint();
      });
      fragment.appendChild(row);
    }
    return fragment;
  }

  const row = document.createElement('div');
  row.className = `setting-row${config.type === 'action' || config.type === 'select' || config.type === 'colors' ? ' clickable' : ''}`;
  const info = document.createElement('div');
  info.className = 'setting-info';
  info.innerHTML = `<div class="setting-title">${config.icon ? `<span class="row-icon">${icon(config.icon, 20)}</span>` : ''}${escapeHtml(config.title)}${config.tag ? `<span class="chip solid" style="height:19px;font-size:10px;padding:0 7px">${escapeHtml(config.tag)}</span>` : ''}</div>${config.desc ? `<div class="setting-desc">${escapeHtml(config.desc)}</div>` : ''}`;
  row.appendChild(info);

  const control = document.createElement('div');
  control.className = 'setting-control';
  row.appendChild(control);

  if (config.type === 'switch') {
    const button = document.createElement('button');
    button.className = 'switch';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(Boolean(getSetting(config.key))));
    button.addEventListener('click', () => {
      const next = !getSetting(config.key);
      setSetting(config.key, next);
      button.setAttribute('aria-checked', String(next));
      config.onChange?.(next);
      if (config.repaint !== false) repaint();
    });
    control.appendChild(button);
  } else if (config.type === 'number') {
    const stepper = document.createElement('div');
    stepper.className = 'stepper';
    const value = Number(getSetting(config.key, config.min || 0));
    stepper.innerHTML = `<button title="减少">${icon('minus', 15)}</button><span class="stepper-value">${formatNumber(value, config)}</span><button title="增加">${icon('plus', 15)}</button>`;
    const label = stepper.querySelector('.stepper-value');
    const [minus, plus] = stepper.querySelectorAll('button');
    const apply = (delta) => {
      let next = Number(getSetting(config.key, config.min || 0)) + delta * (config.step || 1);
      next = Math.max(config.min ?? 0, Math.min(config.max ?? 9999, next));
      if (config.float) next = Math.round(next * 10) / 10;
      setSetting(config.key, next);
      label.textContent = formatNumber(next, config);
      config.onChange?.(next);
    };
    minus.addEventListener('click', () => apply(-1));
    plus.addEventListener('click', () => apply(1));
    control.appendChild(stepper);
  } else if (config.type === 'range') {
    const wrap = document.createElement('div');
    wrap.className = 'gap-8';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(config.min ?? 0);
    input.max = String(config.max ?? 100);
    input.step = String(config.step ?? 1);
    input.value = String(getSetting(config.key, config.min ?? 0));
    const value = document.createElement('span');
    value.className = 'value-text';
    value.textContent = formatNumber(Number(input.value), config);
    input.addEventListener('input', () => {
      const next = Number(input.value);
      setSetting(config.key, next);
      value.textContent = formatNumber(next, config);
      config.onChange?.(next);
    });
    wrap.append(input, value);
    control.appendChild(wrap);
  } else if (config.type === 'select') {
    const button = document.createElement('button');
    button.className = 'select-btn';
    const current = getSetting(config.key);
    button.innerHTML = `<span>${escapeHtml(config.valueMap[current] ?? String(current ?? ''))}</span>${icon('chevron', 14)}`;
    button.addEventListener('click', () => {
      openMenu(
        button,
        Object.entries(config.valueMap).map(([value, label]) => ({
          label,
          active: String(getSetting(config.key)) === String(value),
          onClick: () => {
            const next = config.numeric ? Number(value) : value;
            setSetting(config.key, next);
            config.onChange?.(next);
            repaint();
          },
        }))
      );
    });
    control.appendChild(button);
  } else if (config.type === 'action') {
    if (config.value) {
      const value = document.createElement('span');
      value.className = 'value-text';
      value.textContent = config.value;
      control.appendChild(value);
    }
    control.insertAdjacentHTML('beforeend', `<span class="chev">${icon('chevron', 17)}</span>`);
    row.addEventListener('click', () => config.onClick?.(ctx, repaint));
  } else if (config.type === 'info') {
    const value = document.createElement('span');
    value.className = 'value-text';
    value.textContent = config.value ?? '';
    control.appendChild(value);
  } else if (config.type === 'colors') {
    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    const current = String(getSetting('appearance.accent', '#fb7299')).toLowerCase();
    for (const color of ACCENTS) {
      const swatch = document.createElement('button');
      swatch.className = `swatch${current === color.toLowerCase() ? ' active' : ''}`;
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => {
        setSetting('appearance.accent', color);
        setSetting('accent', color);
        applyTheme();
        repaint();
      });
      swatches.appendChild(swatch);
    }
    return swatches;
  } else if (config.type === 'textarea') {
    const wrap = document.createElement('div');
    wrap.className = 'settings-textarea';
    const area = document.createElement('textarea');
    area.className = 'input';
    area.placeholder = config.placeholder || '';
    area.value = String(getSetting(config.key, '') ?? '');
    area.addEventListener('change', () => {
      setSetting(config.key, area.value);
      config.onChange?.(area.value);
    });
    wrap.appendChild(area);
    row.appendChild(wrap);
    row.classList.add('stack');
  } else if (config.type === 'note') {
    row.classList.add('stack');
    const note = document.createElement('div');
    note.className = 'setting-desc';
    note.style.marginTop = '2px';
    note.textContent = config.desc;
    info.appendChild(note);
  }

  return row;
}

function formatNumber(value, config) {
  const number = config.float ? Math.round(Number(value) * 10) / 10 : Math.round(Number(value));
  return `${number}${config.unit || ''}`;
}

// ---------------------------------------------------------------- 各详情页 schema

function detailSections(key, ctx, repaint) {
  switch (key) {
    case 'appearance':
      return [
        {
          label: '显示主题',
          rows: [
            {
              type: 'radioGroup',
              key: 'appearance.theme',
              options: [
                { label: '跟随系统', value: 'system' },
                { label: '浅色模式', value: 'light' },
                { label: '深色模式', value: 'dark' },
              ],
              onChange: () => {
                state.settings.theme = getSetting('appearance.theme');
                applyTheme();
              },
            },
          ],
        },
        {
          label: '主题颜色',
          rows: [
            {
              type: 'switch',
              key: 'appearance.dynamicColor',
              title: '动态取色',
              desc: '从当前平台封面提取主题色（桌面端保持关闭时使用下面的固定色板）',
            },
            { type: 'colors' },
          ],
        },
        { label: '界面密度', rows: [{ type: 'select', key: 'appearance.density', title: '卡片与列表间距', valueMap: { comfortable: '标准', compact: '紧凑', relaxed: '宽松' }, onChange: (value) => { document.body.dataset.density = value; } }] },
      ];
    case 'home':
      return [
        {
          label: '首页内容',
          rows: [
            { type: 'select', key: 'home.platform', title: '默认平台', valueMap: Object.fromEntries(Object.entries(PLATFORM_META).map(([id, meta]) => [id, meta.name])) },
            { type: 'select', key: 'home.cardSize', title: '卡片尺寸', valueMap: { small: '小', medium: '标准', large: '大' }, onChange: (value) => applyCardSize(value) },
            { type: 'switch', key: 'home.autoRefresh', title: '回到首页时自动刷新', desc: '关闭后保留上次的推荐列表，点刷新才重新请求' },
            { type: 'switch', key: 'home.showMore', title: '显示「加载更多」', desc: '关闭后只显示首屏推荐，不再自动追加下一页' },
          ],
        },
        { label: '排序', rows: [{ type: 'info', title: '推荐排序', desc: '按平台默认热度排序', value: '人气优先' }] },
      ];
    case 'player':
      return [
        {
          label: '播放器',
          rows: [
            { type: 'switch', key: 'player.hardwareDecode', title: '硬件解码', desc: '由 WebView2 / 系统解码器处理视频；播放异常时可尝试关闭' },
            { type: 'switch', key: 'player.rememberQuality', title: '记住清晰度', desc: '同一平台下次进入直播间时沿用上次选择' },
            { type: 'switch', key: 'player.autoSwitchLine', title: '播放失败自动换线', desc: '当前线路连续失败时自动尝试下一条' },
            { type: 'switch', key: 'player.autoRefresh', title: '直播流自动刷新', desc: '长时间播放后重新获取直链，避免地址过期' },
            { type: 'switch', key: 'player.forceHttps', title: '强制 HTTPS', desc: '把平台下发的 http 链接改为 https（部分 CDN 不支持时请关闭）' },
            { type: 'select', key: 'player.scaleMode', title: '画面尺寸', valueMap: { contain: '适应', cover: '铺满', fill: '拉伸' }, onChange: (value) => applyScaleMode(value) },
          ],
        },
        {
          label: '直播间',
          rows: [
            { type: 'switch', key: 'player.autoFullscreen', title: '进入直播间自动全屏' },
            { type: 'switch', key: 'player.muteOnStart', title: '进入直播间默认静音' },
            { type: 'switch', key: 'player.showStats', title: '显示播放统计信息' },
          ],
        },
      ];
    case 'live':
      return [
        {
          label: '直播间行为',
          rows: [
            { type: 'switch', key: 'live.autoFullscreen', title: '进入直播自动全屏' },
            { type: 'switch', key: 'live.autoSwitchNext', title: '关播后自动换下一个', desc: '当前房间确认下播后，自动切到关注列表里的下一个直播间' },
            { type: 'switch', key: 'live.allowBackground', title: '允许后台继续播放', desc: '窗口失去焦点时保持视频与弹幕连接' },
            { type: 'switch', key: 'live.gesture', title: '滑动调节音量/亮度', desc: '播放页左右两侧上下滑动调节' },
            { type: 'switch', key: 'live.hideDanmakuOnMinimize', title: '最小化时隐藏弹幕' },
          ],
        },
        { label: '提示', rows: [{ type: 'info', title: '平台差异', desc: '虎牙暂不提供贡献榜数据；抖音、快手接口仍在接入中', value: '三站已接入' }] },
      ];
    case 'danmaku':
      return [
        {
          label: '弹幕屏蔽',
          rows: [
            { type: 'switch', key: 'danmaku.block', title: '启用弹幕屏蔽', desc: '关闭后，关键词和用户屏蔽都会暂时失效' },
            { type: 'textarea', key: 'danmaku.blockKeywords', title: '关键词屏蔽', desc: '每行一个关键词，命中后不显示该弹幕', placeholder: '例如：广告\n加群' },
            { type: 'textarea', key: 'danmaku.blockUsers', title: '用户屏蔽', desc: '每行一个用户名，支持包含匹配', placeholder: '例如：某用户' },
          ],
        },
        {
          label: '弹幕显示',
          rows: [
            { type: 'switch', key: 'danmaku.enabled', title: '默认开启弹幕' },
            { type: 'range', key: 'danmaku.area', title: '显示区域', desc: '弹幕占据播放器顶部的高度比例', min: 15, max: 100, step: 5, unit: '%' },
            { type: 'number', key: 'danmaku.lines', title: '显示几行', desc: '按区域优先，超出可用高度时自动收紧', min: 1, max: 30, unit: ' 行' },
            { type: 'switch', key: 'danmaku.emoji', title: '显示弹幕表情' },
            { type: 'number', key: 'danmaku.speed', title: '滚动速度', desc: '弹幕持续秒数，越小越快', min: 3, max: 20, unit: ' 秒' },
            { type: 'range', key: 'danmaku.opacity', title: '不透明度', min: 20, max: 100, step: 5, unit: '%' },
            { type: 'number', key: 'danmaku.font', title: '字体大小', min: 12, max: 40, unit: ' px' },
            { type: 'select', key: 'danmaku.weight', title: '字体粗细', numeric: true, valueMap: { 300: '极细', 400: '很细', 500: '正常', 600: '小粗', 700: '偏粗', 800: '很粗', 900: '极粗' } },
            { type: 'switch', key: 'danmaku.stroke', title: '弹幕描边' },
            { type: 'number', key: 'danmaku.strokeWidth', title: '描边宽度', min: 0, max: 5, step: 0.5, float: true, unit: ' px' },
            { type: 'select', key: 'danmaku.fps', title: '帧率上限', numeric: true, valueMap: { 0: '跟随屏幕', 60: '60 帧', 30: '30 帧' } },
            { type: 'number', key: 'danmaku.safeTop', title: '顶部安全边距', min: 0, max: 60, unit: ' px' },
            { type: 'number', key: 'danmaku.safeBottom', title: '底部安全边距', min: 0, max: 60, unit: ' px' },
          ],
        },
        {
          label: '重复弹幕过滤',
          rows: [
            { type: 'switch', key: 'danmaku.dedupe', title: '启用重复过滤' },
            { type: 'select', key: 'danmaku.dedupeMode', title: '过滤模式', valueMap: { content: '按内容', user: '按用户', strict: '刷屏严格' } },
            { type: 'number', key: 'danmaku.dedupeWindow', title: '过滤窗口', desc: '窗口内重复的弹幕会被合并', min: 1, max: 60, unit: ' 秒' },
            { type: 'number', key: 'danmaku.dedupeStep', title: '过滤步长', min: 1, max: 10, unit: '' },
          ],
        },
        { label: '提示', rows: [{ type: 'info', title: '即时生效', desc: '修改会立即保存，并在当前/下一个直播间生效', value: '已保存到本机' }] },
      ];
    case 'follow':
      return [
        {
          label: '关注状态',
          rows: [
            { type: 'info', title: '刷新方式', desc: '进入页面不会自动刷新；点击右上角刷新按钮，一次刷新全部关注主播（4 并发）。', value: '手动' },
            { type: 'select', key: 'follow.threads', title: '更新线程数', numeric: true, valueMap: { 0: '自动', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8' } },
            { type: 'select', key: 'follow.pageSize', title: '关注每页数量', numeric: true, valueMap: { 50: '50', 100: '100', 150: '150', 200: '200', 300: '300', 400: '400' } },
          ],
        },
      ];
    case 'timer':
      return [
        {
          label: '定时关闭',
          rows: [
            { type: 'switch', key: 'timer.enabled', title: '启用定时关闭', onChange: () => ctx.restartTimer?.() },
            { type: 'number', key: 'timer.minutes', title: '自动关闭时间', desc: '从进入直播间开始倒计时', min: 5, max: 720, step: 5, unit: ' 分钟', onChange: () => ctx.restartTimer?.() },
          ],
        },
        { label: '', rows: [{ type: 'info', title: '当前状态', desc: getSetting('timer.enabled') ? `已开启，${getSetting('timer.minutes')} 分钟后自动退出应用` : '未开启', value: getSetting('timer.enabled') ? '计时中' : '关闭' }] },
      ];
    case 'other':
      return [
        {
          label: '桌面窗口',
          rows: [
            {
              type: 'switch',
              key: 'other.closeToTray',
              title: '关闭窗口时退到托盘',
              desc: '点关闭只隐藏窗口，直播继续播放；从托盘图标或菜单可以恢复',
              onChange: (value) => setCloseToTray(value),
            },
            { type: 'switch', key: 'other.rememberWindow', title: '记住窗口大小和位置', desc: '下次启动时恢复上次的窗口尺寸' },
            { type: 'switch', key: 'other.log', title: '启用日志记录', desc: '记录调试日志，便于排查播放问题' },
          ],
        },
        {
          label: '维护',
          rows: [
            {
              type: 'action',
              icon: 'refresh',
              title: '重置所有设置',
              desc: '恢复默认外观、播放、弹幕等选项；不会删除关注和观看记录',
              onClick: async (innerCtx, repaintInner) => {
                const ok = await confirmDialog({ title: '重置设置', text: '所有设置将恢复默认值，确定继续吗？', okLabel: '重置', danger: true });
                if (!ok) return;
                resetSettings();
                applyTheme();
                repaintInner();
                toast('已恢复默认设置', 'success');
              },
            },
            { type: 'action', icon: 'info', title: '打开日志目录', desc: '查看 Tauri 运行日志', onClick: () => toast('日志目录：%LOCALAPPDATA%\\Starveil') },
          ],
        },
      ];
    default:
      return [{ label: '设置', rows: [{ type: 'info', title: '这个页面还在整理中', value: '' }] }];
  }
}

function themeLabel(theme) {
  return theme === 'light' ? '浅色' : theme === 'system' ? '跟随系统' : '深色';
}

function applyCardSize(size) {
  document.body.dataset.cardSize = size;
  const grid = document.getElementById('view');
  if (!grid) return;
}

function applyScaleMode(mode) {
  const player = document.getElementById('player');
  if (!player) return;
  player.style.objectFit = mode === 'cover' ? 'cover' : mode === 'fill' ? 'fill' : 'contain';
}

// ---------------------------------------------------------------- 特殊页

function paintHistory(content, ctx) {
  const head = document.createElement('div');
  head.className = 'history-actions';
  head.innerHTML = `<button class="btn small ghost">${icon('close', 15)} 清空记录</button>`;
  head.querySelector('button').addEventListener('click', async () => {
    if (!state.history.length) return;
    const ok = await confirmDialog({ title: '清空观看记录', text: '只会删除本机记录，不影响平台账号。', okLabel: '清空', danger: true });
    if (!ok) return;
    clearHistory();
    paintCurrent();
  });
  let shown = 120;
  const paintCurrent = () => {
    content.innerHTML = '';
    if (!state.history.length) {
      content.appendChild(
        emptyState({ iconName: 'history', title: '还没有观看记录', text: '打开一个直播间后，这里会按时间倒序保留最近的记录。', actionLabel: '去首页看看', onAction: () => ctx.go('home') })
      );
      return;
    }
    content.appendChild(head);
    const hint = document.createElement('div');
    hint.className = 'search-hint';
    hint.innerHTML = `共 <strong>${state.history.length}</strong> 条记录，最多保留最近 1000 条`;
    content.appendChild(hint);
    const pageItems = state.history.slice(0, shown);
    const grid = roomGrid(
      pageItems.map((item) => ({ ...item, live: true })),
      { onOpen: (room) => ctx.openRoom(room.platform, room.room_id), className: 'history-grid' }
    );
    content.appendChild(grid);
    if (shown < state.history.length) {
      const more = loadMore(`加载更多（还有 ${state.history.length - shown} 条）`);
      more.addEventListener('click', () => {
        shown += 120;
        paintCurrent();
      });
      content.appendChild(more);
    }
  };
  paintCurrent();
}

function paintSync(content, ctx, repaint) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <h3>本机数据备份</h3>
    <p>导出设置、关注列表、观看记录和登录信息为一个 JSON 文件；换机器或重装时可以再导入回来。</p>
    <div class="tool-actions">
      <button class="btn primary" id="sync-export">${icon('download', 16)} 导出备份</button>
      <button class="btn" id="sync-import">${icon('upload', 16)} 导入备份</button>
    </div>`;
  const note = document.createElement('div');
  note.className = 'pill-note';
  note.style.marginTop = '14px';
  note.innerHTML = `${icon('info', 16)}<div>当前版本使用本机 localStorage 保存数据，不会上传到服务器。导入会覆盖同名类别的数据。</div>`;
  card.appendChild(note);
  content.appendChild(card);

  card.querySelector('#sync-export').addEventListener('click', async () => {
    const payload = {
      version: 1,
      app: '星幕直播 Starveil',
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      shield: {
        keywords: state.settings.danmaku?.blockKeywords || '',
        users: state.settings.danmaku?.blockUsers || '',
      },
      follows: JSON.parse(localStorage.getItem('simple-live.follow.v2') || '[]'),
      history: state.history,
      // 登录信息（Cookie）一并导出，换机后导入即可恢复登录态。
      accounts: collectAccounts(),
    };
    const filename = `starveil-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const saved = await saveJsonFile(filename, payload);
    if (saved) toast('备份已导出', 'success');
  });

  card.querySelector('#sync-import').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.shield) {
          data.settings = data.settings || {};
          data.settings.danmaku = data.settings.danmaku || {};
          if (!data.settings.danmaku.blockKeywords) data.settings.danmaku.blockKeywords = data.shield.keywords || '';
          if (!data.settings.danmaku.blockUsers) data.settings.danmaku.blockUsers = data.shield.users || '';
        }
        if (data.settings) localStorage.setItem('simple-live.settings.v2', JSON.stringify(data.settings));
        if (Array.isArray(data.follows)) localStorage.setItem('simple-live.follow.v2', JSON.stringify(data.follows));
        if (Array.isArray(data.history)) localStorage.setItem('simple-live.history.v2', JSON.stringify(data.history));
        const restored = restoreAccounts(data.accounts);
        toast(
          restored.length ? `导入成功（含 ${restored.length} 个平台登录信息），正在重新载入…` : '导入成功，正在重新载入…',
          'success',
        );
        setTimeout(() => location.reload(), 700);
      } catch (error) {
        toast(`导入失败：${error}`, 'error');
      }
    });
    input.click();
  });
}

function paintLink(content, ctx) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <h3>直播间链接解析</h3>
    <p>粘贴哔哩哔哩、斗鱼、虎牙的直播间链接，或直接输入房间号，解析后进入直播间。</p>
    <input class="input" id="link-input" placeholder="https://live.bilibili.com/21452505" />
    <div class="tool-actions">
      <button class="btn primary" id="link-go">${icon('link', 16)} 解析并进入</button>
    </div>
    <div id="link-result" style="margin-top:14px"></div>`;
  content.appendChild(card);
  const input = card.querySelector('#link-input');
  const result = card.querySelector('#link-result');
  const go = async () => {
    const value = input.value.trim();
    if (!value) return;
    result.innerHTML = '';
    try {
      const parsed = await api.resolveInput(state.platform, value);
      if (parsed?.is_short_link) {
        result.innerHTML = `<div class="pill-note">${icon('info', 16)}<div>短链接需要先展开，请粘贴完整直播间地址。</div></div>`;
        return;
      }
      if (!parsed?.platform || !parsed?.room_id) {
        result.innerHTML = `<div class="pill-note">${icon('info', 16)}<div>没有识别出房间号，请检查链接。</div></div>`;
        return;
      }
      result.innerHTML = `
        <div class="pill-note" style="align-items:center">
          <img class="platform-img" src="assets/${parsed.platform}.png" width="22" height="22" alt="" />
          <div style="flex:1">识别为 <b>${escapeHtml(PLATFORM_META[parsed.platform]?.name || parsed.platform)}</b> · 房间号 <b>${escapeHtml(parsed.room_id)}</b></div>
          <button class="btn small primary" id="link-open">进入直播间</button>
        </div>`;
      result.querySelector('#link-open').addEventListener('click', () => ctx.openRoom(parsed.platform, parsed.room_id));
    } catch (error) {
      result.innerHTML = `<div class="page-error"><span>解析失败：${escapeHtml(error)}</span></div>`;
    }
  };
  card.querySelector('#link-go').addEventListener('click', go);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') go();
  });
  setTimeout(() => input.focus(), 60);
}

function paintAbout(content, ctx) {
  const card = document.createElement('div');
  card.className = 'settings-group about-card';
  card.innerHTML = `
    <div class="about-logo"><img src="assets/logo.png" alt="" /></div>
    <h2>星幕直播</h2>
    <p>Starveil · 聚合直播桌面客户端 · Tauri 2 + WebView2</p>
    <span class="about-version" id="about-version">${FALLBACK_VERSION}</span>
    <div class="settings-group" style="margin-top:22px;text-align:left">
      <div class="setting-row"><div class="setting-info"><div class="setting-title">协议层</div><div class="setting-desc">哔哩哔哩 / 斗鱼 / 虎牙（Rust live_core）</div></div></div>
      <div class="setting-row"><div class="setting-info"><div class="setting-title">播放</div><div class="setting-desc">mpegts.js · FLV over MSE</div></div></div>
      <div class="setting-row"><div class="setting-info"><div class="setting-title">界面</div><div class="setting-desc">HTML / CSS / ES Modules，无前端框架</div></div></div>
      <div class="setting-row"><div class="setting-info"><div class="setting-title">致敬</div><div class="setting-desc">界面与交互参考 dart_simple_live（xiaoyaocz）</div></div></div>
    </div>`;
  content.appendChild(card);
  // 版本号以打包配置为准：能读到运行时就覆盖，读不到（浏览器演示）显示兜底值。
  (async () => {
    const label = card.querySelector('#about-version');
    if (!label) return;
    try {
      const version = await window.__TAURI__?.app?.getVersion?.();
      if (version) label.textContent = version;
    } catch {
      /* 保持兜底版本 */
    }
  })();
  const actions = document.createElement('div');
  actions.className = 'settings-action-card';
  actions.innerHTML = `
    <div class="action-icon">${icon('github', 20)}</div>
    <div class="action-text"><h4>参考项目</h4><p>dart_simple_live 的 Windows 重制与原版源码</p></div>
    <button class="btn small">打开</button>`;
  actions.querySelector('button').addEventListener('click', () => api.openUrl(REFERENCE_REPO));
  content.appendChild(actions);
}

function paintDisclaimer(content, ctx, repaint) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <h3>免责声明</h3>
    <p>本应用仅用于学习与技术研究，所有直播内容、弹幕与商标均归各平台及主播所有。应用不提供任何直播源，也不对内容的合法性、准确性作任何保证。</p>
    <p>请遵守所在地区的法律法规以及各直播平台的服务条款。因使用本应用产生的任何纠纷或损失，开发者不承担责任。</p>
    <p>如果你不希望自己的直播间被展示，请通过平台渠道联系下架；本应用不存储、不转播任何视频内容。</p>
    <div class="pill-note">${icon('shield', 16)}<div>继续使用即表示你已阅读并同意上述说明。</div></div>`;
  content.appendChild(card);
  const action = document.createElement('div');
  action.className = 'settings-action-card';
  action.innerHTML = `
    <div class="action-icon">${icon(state.settings.disclaimerAccepted ? 'check' : 'info', 20)}</div>
    <div class="action-text"><h4>${state.settings.disclaimerAccepted ? '已阅读并同意' : '尚未确认'}</h4><p>首次启动时会弹出确认窗口</p></div>
    <button class="btn small primary">${state.settings.disclaimerAccepted ? '重新阅读' : '已阅读并同意'}</button>`;
  action.querySelector('button').addEventListener('click', () => {
    state.settings.disclaimerAccepted = true;
    state.settings.firstRun = false;
    localStorage.setItem('simple-live.settings.v2', JSON.stringify(state.settings));
    toast('已记录同意状态', 'success');
    repaint();
  });
  content.appendChild(action);
}

function paintAccount(content, ctx) {
  const repaint = () => {
    content.innerHTML = '';
    paintAccount(content, ctx);
  };
  const intro = document.createElement('div');
  intro.className = 'tool-card';
  intro.innerHTML = `
    <h3>账号登录</h3>
    <p>登录后可以使用账号 Cookie 获取更高画质，并让取流带上登录态。Cookie 只保存在本机 WebView 存储中，不会上传。</p>
    <div class="pill-note">${icon('info', 16)}<div>哔哩哔哩支持扫码登录和 Cookie 登录；斗鱼当前提供 Cookie 登录（扫码需要 Passport 会话，后续版本再补）。</div></div>`;
  content.appendChild(intro);

  const rows = [
    { platform: 'bilibili', login: loadLogin('bilibili'), canLogin: true },
    { platform: 'douyu', login: loadLogin('douyu'), canLogin: true },
    { platform: 'huya', login: null, canLogin: false },
  ];

  for (const entry of rows) {
    const { platform, login } = entry;
    const row = document.createElement('div');
    row.className = 'settings-action-card';
    const logged = Boolean(login?.cookie);
    const isBili = platform === 'bilibili';
    const subtitle = logged
      ? isBili
        ? `${login.name || 'B 站用户'}${login.uid ? ` · UID ${login.uid}` : ''}`
        : `已配置 Cookie（${String(login.cookie).length} 字符）`
      : entry.canLogin
        ? isBili
          ? '未登录 · 支持扫码 / Cookie'
          : '未登录 · 支持 Cookie'
        : '暂不支持账号登录';
    row.innerHTML = `
      <div class="action-icon" style="background:transparent">${
        logged && isBili && login.avatar
          ? avatarHtml(login.name, login.avatar, 30)
          : `<img class="platform-img" src="assets/${platformAsset(platform)}.png" width="28" height="28" alt="" />`
      }</div>
      <div class="action-text"><h4>${escapeHtml(PLATFORM_META[platform].name)}</h4><p>${escapeHtml(subtitle)}</p></div>
      <button class="btn small ${logged ? 'ghost' : 'primary'}" ${entry.canLogin ? '' : 'disabled'}>${logged ? '退出登录' : '登录'}</button>`;
    const button = row.querySelector('button');
    if (logged) {
      button.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '退出登录',
          text: `确定清除本机保存的${PLATFORM_META[platform].name}登录状态吗？`,
          okLabel: '退出登录',
          danger: true,
        });
        if (!ok) return;
        clearLogin(platform);
        await api.clearCookie(platform).catch(() => {});
        toast(`已退出${PLATFORM_META[platform].name}`, 'success');
        repaint();
      });
    } else if (entry.canLogin) {
      button.addEventListener('click', () => {
        if (isBili) openBiliLogin(repaint);
        else openDouyuLogin(repaint);
      });
    }
    content.appendChild(row);
  }
}

function openBiliLogin(onDone) {
  let timer = 0;
  let stopped = false;
  let qrKey = '';
  const body = document.createElement('div');
  body.className = 'login-body';
  body.innerHTML = `
    <div class="login-tabs">
      <button class="login-tab active" data-tab="qr">扫码登录</button>
      <button class="login-tab" data-tab="cookie">Cookie 登录</button>
    </div>
    <div class="login-panel" data-panel="qr">
      <div class="login-qr-box" id="bili-qr-box"><span class="spinner"></span></div>
      <div class="login-status" id="bili-qr-status">正在生成二维码…</div>
      <button class="btn small ghost" id="bili-qr-refresh">${icon('refresh', 14)} 刷新二维码</button>
    </div>
    <div class="login-panel hidden" data-panel="cookie">
      <p class="login-hint">在浏览器登录 bilibili.com，从开发者工具 Application → Cookies 复制完整 Cookie，至少包含 SESSDATA、bili_jct、DedeUserID。</p>
      <textarea class="input login-cookie" id="bili-cookie-input" placeholder="SESSDATA=...; bili_jct=...; DedeUserID=..."></textarea>
      <div class="login-actions"><button class="btn primary" id="bili-cookie-save">验证并登录</button></div>
    </div>`;

  const modal = openModal({
    title: '哔哩哔哩登录',
    subtitle: '扫码或在浏览器登录后粘贴 Cookie',
    width: 520,
    body,
    actions: [{ label: '关闭', kind: 'ghost' }],
    onClose: () => {
      stopped = true;
      clearInterval(timer);
    },
  });

  const qrBox = body.querySelector('#bili-qr-box');
  const qrStatus = body.querySelector('#bili-qr-status');
  const refresh = body.querySelector('#bili-qr-refresh');

  function finish(cookie, user) {
    clearInterval(timer);
    stopped = true;
    saveLogin('bilibili', {
      cookie,
      name: user?.name || 'B 站用户',
      avatar: user?.avatar || '',
      uid: user?.uid || '',
    });
    api
      .setCookie('bilibili', cookie)
      .then(() => {
        toast(`已登录：${user?.name || 'B 站用户'}`, 'success');
        modal.close();
        onDone();
      })
      .catch((error) => {
        qrStatus.textContent = `保存登录态失败：${error}`;
        stopped = false;
      });
  }

  async function poll() {
    if (stopped || !qrKey) return;
    try {
      const result = await api.biliQrPoll(qrKey);
      if (stopped) return;
      qrStatus.textContent = result.message;
      if (result.status === 'authorized' && result.cookie) {
        finish(result.cookie, result.user);
      } else if (result.status === 'expired' || result.status === 'error') {
        clearInterval(timer);
        refresh.classList.add('primary');
      }
    } catch (error) {
      qrStatus.textContent = `轮询失败：${error}`;
    }
  }

  async function loadQr() {
    clearInterval(timer);
    qrStatus.textContent = '正在生成二维码…';
    qrBox.innerHTML = '<span class="spinner"></span>';
    refresh.classList.remove('primary');
    try {
      const payload = await api.biliQrGenerate();
      if (stopped) return;
      qrKey = payload.key;
      if (!window.qrcode) throw new Error('二维码组件未加载');
      const qr = window.qrcode(0, 'M');
      qr.addData(payload.url);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8 });
      qrStatus.textContent = '请使用哔哩哔哩手机客户端扫码';
      timer = setInterval(poll, 2200);
    } catch (error) {
      qrBox.innerHTML = `<span class="login-error">${escapeHtml(error)}</span>`;
      qrStatus.textContent = '二维码生成失败，请重试';
    }
  }

  refresh.addEventListener('click', loadQr);
  body.querySelectorAll('.login-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      body.querySelectorAll('.login-tab').forEach((item) => item.classList.toggle('active', item === tab));
      body.querySelectorAll('.login-panel').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.tab);
      });
    });
  });
  body.querySelector('#bili-cookie-save').addEventListener('click', async () => {
    const cookie = body.querySelector('#bili-cookie-input').value.trim();
    if (!cookie) {
      toast('请先粘贴 Cookie', 'error');
      return;
    }
    try {
      const user = await api.loginStatus('bilibili', cookie);
      if (!user.logged_in) {
        toast(user.message || 'Cookie 无效', 'error');
        return;
      }
      finish(cookie, user);
    } catch (error) {
      toast(`验证失败：${error}`, 'error');
    }
  });
  loadQr();
}

function openDouyuLogin(onDone) {
  const body = document.createElement('div');
  body.className = 'login-body';
  body.innerHTML = `
    <p class="login-hint">先用浏览器打开斗鱼并登录，然后从开发者工具 Application → Cookies 复制 <strong>www.douyu.com</strong> 的完整 Cookie（含 acf_auth、acf_uid、acf_did 等），粘贴到这里。登录态只保存在本机，并会用于取流。</p>
    <textarea class="input login-cookie" id="douyu-cookie-input" placeholder="acf_auth=...; acf_uid=...; acf_did=..."></textarea>
    <div class="login-actions">
      <button class="btn small ghost" id="douyu-open-web">打开斗鱼网页</button>
      <button class="btn primary" id="douyu-cookie-save">保存并登录</button>
    </div>`;
  const modal = openModal({
    title: '斗鱼登录',
    subtitle: '当前版本使用 Cookie 登录',
    width: 540,
    body,
    actions: [{ label: '关闭', kind: 'ghost' }],
  });
  body.querySelector('#douyu-open-web').addEventListener('click', () => api.openUrl('https://www.douyu.com/'));
  body.querySelector('#douyu-cookie-save').addEventListener('click', async () => {
    const cookie = body.querySelector('#douyu-cookie-input').value.trim();
    if (!cookie) {
      toast('请先粘贴 Cookie', 'error');
      return;
    }
    try {
      const user = await api.loginStatus('douyu', cookie);
      if (!user.logged_in) {
        toast(user.message || 'Cookie 无效', 'error');
        return;
      }
      await api.setCookie('douyu', cookie);
      saveLogin('douyu', { cookie, name: '斗鱼账号' });
      toast('斗鱼登录态已保存', 'success');
      modal.close();
      onDone();
    } catch (error) {
      toast(`保存失败：${error}`, 'error');
    }
  });
}

// ---------------------------------------------------------------- 一级动作

function runSettingAction(ctx, action) {
  if (action === 'github') {
    api.openUrl('https://github.com/xiaoyaocz/dart_simple_live');
    return;
  }
}
