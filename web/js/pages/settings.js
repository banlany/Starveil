// 设置：一级列表 + 二级详情。大部分选项会真正写入 localStorage 并即时生效。
import { api, formatCount, formatOnline, timeAgo, roomUrl } from '../api.js';
import {
  ACCENTS,
  aggregateStats,
  applyTheme,
  clearHistory,
  clearLogin,
  clearStats,
  collectAccounts,
  HISTORY_LIMIT,
  STATS_RANGES,
  getSetting,
  loadFollow,
  loadLogin,
  resetSettings,
  saveLogin,
  setSetting,
  state,
} from '../store.js';
import { icon, PLATFORM_META, platformAsset } from '../icons.js';
// 外部数据导入（starveil 备份 / dart profile / 中立同步包）与同步包构建。
import { buildBundle, importData } from '../importer.js';
// 弹幕性能档位/帧率的选项表由弹幕层提供，直播间弹层共用同一份，
// 改档位定义时只改 danmaku.js 一处。
import { FPS_OPTIONS, PERF_OPTIONS } from '../danmaku.js';
import {
  avatarHtml,
  bindImageFallback,
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
const FALLBACK_VERSION = '0.5.0';
// 本项目自己的仓库（「设置 → 开源主页」与关于页的「项目主页」都指向这里）。
const PROJECT_REPO = 'https://github.com/banlany/Starveil';
// 参考项目（原版 dart_simple_live 的 fork），保留在关于页作为致敬入口。
const REFERENCE_REPO = 'https://github.com/June6699/dart_simple_live';

// select 行要的是 { 值: 文案 }，这里由共享选项表派生，避免手工维护两份。
const PERF_MAP = Object.fromEntries(PERF_OPTIONS.map((option) => [option.value, option.label]));
const FPS_MAP = Object.fromEntries(FPS_OPTIONS.map((option) => [option.value, option.label]));

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
  licenses: '许可与致谢',
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
    if (key === 'licenses') return paintLicenses(content, ctx);
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
        { label: '提示', rows: [{ type: 'info', title: '平台差异', desc: '虎牙不提供贡献榜；抖音、快手已支持观看与账号登录，弹幕暂未接入，快手搜索暂不可用', value: '五站可选' }] },
      ];
    case 'danmaku': {
      const groups = [
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
            { type: 'select', key: 'danmaku.fps', title: '帧率上限', desc: '限制弹幕层的重绘频率，越低越省电', numeric: true, valueMap: FPS_MAP },
            { type: 'number', key: 'danmaku.safeTop', title: '顶部安全边距', desc: '相对画面顶端；0 表示贴着顶端', min: 0, max: 60, unit: ' px' },
            { type: 'number', key: 'danmaku.safeBottom', title: '底部安全边距', min: 0, max: 60, unit: ' px' },
          ],
        },
        {
          label: '性能',
          rows: [
            {
              type: 'select',
              key: 'danmaku.perf',
              title: '性能档位',
              desc: '弹幕密集时卡顿就往下调：流畅档关阴影，极速档还会关描边并降低画布精度',
              valueMap: PERF_MAP,
            },
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
      // 发送弹幕是写操作：默认连这一组设置都不出现，要在「关于」页连点版本号
      // 7 次解锁（做法与安卓的开发者选项一致，见 docs/hidden-features.md）。
      // 解锁后仍然默认关闭，需要用户再手动打开。
      if (getSetting('danmaku.sendUnlocked')) {
        groups.push({
          label: '发送弹幕（实验）',
          rows: [
            {
              type: 'switch',
              key: 'danmaku.sendEnabled',
              title: '允许发送弹幕',
              desc: '开启后直播间聊天栏底部出现输入框；仅支持纯文本，目前只有哔哩哔哩实现了发送接口',
            },
            {
              type: 'info',
              title: '需要登录',
              desc: '发弹幕用的是账号 Cookie，未登录或登录态失效时会直接失败，不会静默吞掉',
              value: '账号管理',
            },
          ],
        });
      }
      return groups;
    }
    case 'follow':
      return [
        {
          label: '关注状态',
          rows: [
            {
              type: 'switch',
              key: 'follow.autoRefresh',
              title: '进入页面自动刷新',
              desc: '打开后每次进入关注页都刷新一次直播状态（并发数见下方）；默认关闭，避免一进页面就打几十个请求。',
            },
            { type: 'info', title: '手动刷新', desc: '点击右上角刷新按钮，随时刷新全部关注主播的直播状态。', value: '右上角 ↻' },
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
}

function applyScaleMode(mode) {
  const player = document.getElementById('player');
  if (!player) return;
  player.style.objectFit = mode === 'cover' ? 'cover' : mode === 'fill' ? 'fill' : 'contain';
}

// ---------------------------------------------------------------- 特殊页

function paintHistory(content, ctx) {
  // 观看记录页有两个视图：原始记录（最近看过的房间）与统计（按主播聚合的时长/次数）。
  // 两者共用同一份数据源，不新增路由，避免动返回栈。
  let view = 'records';
  let range = 'week';
  let shown = 120;

  const paint = () => {
    content.innerHTML = '';
    content.appendChild(
      segmented(
        [
          ['records', '观看记录'],
          ['stats', '统计'],
        ],
        view,
        (next) => {
          view = next;
          paint();
        }
      )
    );
    if (view === 'stats') paintStats();
    else paintRecords();
  };

  function paintRecords() {
    // 「加载更多」是直接再调一次本函数的，而顶部分段控件是 paint() 加的。
    // 这里先清掉上一次画的内容（只留第一段），否则每点一次就叠一层：
    // 两个「清空记录」、两份提示、两整份卡片，DOM 数量随点击次数涨。
    while (content.childElementCount > 1) content.lastElementChild.remove();
    const head = document.createElement('div');
    head.className = 'history-actions';
    head.innerHTML = `<button class="btn small ghost">${icon('close', 15)} 清空记录</button>`;
    head.querySelector('button').addEventListener('click', async () => {
      if (!state.history.length) return;
      const ok = await confirmDialog({ title: '清空观看记录', text: '只会删除本机记录，不影响平台账号。', okLabel: '清空', danger: true });
      if (!ok) return;
      clearHistory();
      paint();
    });
    if (!state.history.length) {
      content.appendChild(
        emptyState({ iconName: 'history', title: '还没有观看记录', text: '打开一个直播间后，这里会按时间倒序保留最近的记录。', actionLabel: '去首页看看', onAction: () => ctx.go('home') })
      );
      return;
    }
    content.appendChild(head);
    const hint = document.createElement('div');
    hint.className = 'search-hint';
    hint.innerHTML = `共 <strong>${state.history.length}</strong> 条记录，最多保留最近 ${HISTORY_LIMIT} 条`;
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
        paintRecords();
      });
      content.appendChild(more);
    }
  }

  function paintStats() {
    const data = aggregateStats(range);
    content.appendChild(
      segmented(
        STATS_RANGES.map((item) => [item.value, item.label]),
        range,
        (next) => {
          range = next;
          paint();
        }
      )
    );

    if (!data.rooms.length) {
      content.appendChild(
        emptyState({
          iconName: 'timer',
          title: '这个时间段还没有观看数据',
          text: '统计只累计真正在播的时长，挂着不动不会计数。换个时间范围看看，或者先去一个直播间。',
          actionLabel: '去首页看看',
          onAction: () => ctx.go('home'),
        })
      );
      return;
    }

    const summary = document.createElement('div');
    summary.className = 'stats-summary';
    summary.innerHTML = `
      <div class="stats-card"><span>总时长</span><strong>${formatWatchTime(data.totalMs)}</strong></div>
      <div class="stats-card"><span>观看次数</span><strong>${formatCount(data.totalVisits)} 次</strong></div>
      <div class="stats-card"><span>主播数</span><strong>${data.rooms.length} 位</strong></div>
      <div class="stats-card"><span>日均</span><strong>${formatWatchTime(data.activeDays ? data.totalMs / data.activeDays : 0)}</strong></div>`;
    content.appendChild(summary);

    const note = document.createElement('div');
    note.className = 'search-hint';
    note.innerHTML = `按有观看的 <strong>${data.activeDays}</strong> 天计算日均；点任意主播可直接进入直播间`;
    content.appendChild(note);

    const maxMs = data.rooms[0]?.ms || 1;
    const list = document.createElement('div');
    list.className = 'stats-list';
    for (const [index, item] of data.rooms.slice(0, 60).entries()) {
      const row = document.createElement('button');
      row.className = 'stats-row';
      const ratio = Math.max(3, Math.round((item.ms / maxMs) * 100));
      row.innerHTML = `
        <span class="stats-rank">${index + 1}</span>
        ${avatarHtml(item.user_name || '未知主播', item.cover, 34)}
        <span class="stats-main">
          <b title="${escapeHtml(item.user_name || '未知主播')}">${escapeHtml(item.user_name || '未知主播')}</b>
          <span class="stats-bar"><i style="width:${ratio}%"></i></span>
        </span>
        <span class="stats-value"><b>${formatWatchTime(item.ms)}</b><small>${item.visits} 次</small></span>`;
      row.addEventListener('click', () => ctx.openRoom(item.platform, item.room_id));
      list.appendChild(row);
    }
    content.appendChild(list);
    bindImageFallback(list);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.innerHTML = `<button class="btn small ghost">${icon('close', 15)} 清空统计</button>`;
    actions.querySelector('button').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: '清空观看统计', text: '时长与次数会一起清掉，观看记录不受影响。', okLabel: '清空', danger: true });
      if (!ok) return;
      clearStats();
      paint();
    });
    content.appendChild(actions);
  }

  paint();
}

/// 分段控件：设置页里「记录/统计」「本周/本月…」都用它，样式见 pages.css 的 .segmented。
function segmented(options, active, onPick) {
  const bar = document.createElement('div');
  bar.className = 'segmented';
  for (const [value, label] of options) {
    const button = document.createElement('button');
    button.className = value === active ? 'active' : '';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (value === active) return;
      onPick(value);
    });
    bar.appendChild(button);
  }
  return bar;
}

/// 把毫秒转成「2 小时 13 分」这类人话，统计卡片和排行都用它。
function formatWatchTime(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function paintSync(content, ctx, repaint) {
  // ① 本机备份：仍是原来的导出一份 JSON / 导入回来。
  const backup = document.createElement('div');
  backup.className = 'tool-card';
  backup.innerHTML = `
    <h3>本机数据备份</h3>
    <p>导出设置、关注列表、观看记录和登录信息为一个 JSON 文件；换机器或重装时可以再导入回来。</p>
    <div class="tool-actions">
      <button class="btn primary" id="sync-export">${icon('download', 16)} 导出备份</button>
      <button class="btn" id="sync-import">${icon('upload', 16)} 导入备份</button>
    </div>`;
  const backupNote = document.createElement('div');
  backupNote.className = 'pill-note';
  backupNote.style.marginTop = '14px';
  backupNote.innerHTML = `${icon('info', 16)}<div>当前版本使用本机 localStorage 保存数据，不会上传到服务器。导入会覆盖同名类别的数据。</div>`;
  backup.appendChild(backupNote);
  content.appendChild(backup);

  backup.querySelector('#sync-export').addEventListener('click', async () => {
    const payload = {
      version: 1,
      app: '星幕直播 Starveil',
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      shield: {
        keywords: state.settings.danmaku?.blockKeywords || '',
        users: state.settings.danmaku?.blockUsers || '',
      },
      // 走 store 的读取而不是直接 JSON.parse：localStorage 里的数据可能被
      // 半写入或手工改坏，未捕获的异常会让「导出备份」点了毫无反应。
      follows: loadFollow(),
      history: state.history,
      // 登录信息（Cookie）一并导出，换机后导入即可恢复登录态。
      accounts: collectAccounts(),
    };
    const filename = `starveil-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const saved = await saveJsonFile(filename, payload);
    if (saved) toast('备份已导出', 'success');
  });
  backup.querySelector('#sync-import').addEventListener('click', () => pickJsonFile(runImport));

  // ② 从 dart_simple_live 迁移：直接吃它导出的 profile JSON。
  const migrate = document.createElement('div');
  migrate.className = 'tool-card';
  migrate.innerHTML = `
    <h3>从 dart_simple_live 迁移</h3>
    <p>选择 SimpleLive 导出的 profile 文件（<code>simple_live_profile</code> 格式），
       会把关注、观看记录、弹幕/播放设置与关键词屏蔽搬到本机；抖音/快手的记录会被跳过。</p>
    <div class="tool-actions">
      <button class="btn primary" id="sync-dart">${icon('upload', 16)} 选择 profile 文件</button>
    </div>
    <div id="import-report"></div>`;
  content.appendChild(migrate);

  const report = migrate.querySelector('#import-report');

  migrate.querySelector('#sync-dart').addEventListener('click', () => pickJsonFile(runImport));

  async function runImport(file) {
    try {
      const summary = importData(JSON.parse(await file.text()));
      // 导入的 Cookie 要重新注入后端，否则页面看着「已登录」但取流仍是游客。
      for (const platform of summary.accounts) {
        const login = loadLogin(platform);
        if (login?.cookie) await api.setCookie(platform, login.cookie).catch(() => {});
      }
      report.innerHTML = `<div class="pill-note" style="margin-top:14px">${icon('check', 16)}<div>${escapeHtml(
        describeImport(summary)
      )}，正在重新载入…</div></div>`;
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      report.innerHTML = `<div class="pill-note" style="margin-top:14px">${icon('info', 16)}<div>导入失败：${escapeHtml(
        String(error?.message || error)
      )}</div></div>`;
    }
  }

  // ③ WebDAV 同步：整包上传/下载，不做字段级合并。
  const config = state.settings.sync.webdav;
  const sync = document.createElement('div');
  sync.className = 'tool-card';
  sync.innerHTML = `
    <h3>WebDAV 局域网同步</h3>
    <p>把关注、观看记录与设置打包成一个 JSON 传到自己的 WebDAV（群晖、坚果云、Nextcloud 等），
       多台机器共用同一份数据。</p>
    <div class="sync-form">
      <label class="sync-field"><span>服务器地址</span>
        <input class="input" id="dav-url" placeholder="https://nas.local:5006/dav/starveil/" value="${escapeHtml(config.url)}" /></label>
      <label class="sync-field"><span>文件名</span>
        <input class="input" id="dav-path" placeholder="starveil-sync.json" value="${escapeHtml(config.path)}" /></label>
      <label class="sync-field"><span>用户名</span>
        <input class="input" id="dav-user" value="${escapeHtml(config.username)}" autocomplete="off" /></label>
      <label class="sync-field"><span>密码</span>
        <input class="input" id="dav-pass" type="password" value="${escapeHtml(config.password)}" autocomplete="off" /></label>
      <div class="sync-toggles">
        <div class="sync-toggle"><span>允许自签证书</span><button class="switch" id="dav-insecure" aria-checked="${config.insecureTls}"></button></div>
        <div class="sync-toggle"><span>启动时自动拉取远端</span><button class="switch" id="dav-autopull" aria-checked="${config.autoPull}"></button></div>
      </div>
    </div>
    <div class="tool-actions">
      <button class="btn" id="dav-test">${icon('link', 16)} 测试连接</button>
      <button class="btn primary" id="dav-upload">${icon('upload', 16)} 上传覆盖云端</button>
      <button class="btn" id="dav-download">${icon('download', 16)} 下载覆盖本机</button>
    </div>
    <div id="dav-state"></div>`;
  content.appendChild(sync);

  const davState = sync.querySelector('#dav-state');
  const showState = (text, tone = 'info') => {
    davState.innerHTML = `<div class="pill-note" style="margin-top:14px">${icon(tone === 'error' ? 'info' : 'check', 16)}<div>${escapeHtml(text)}</div></div>`;
  };
  const readForm = () => {
    const next = {
      url: sync.querySelector('#dav-url').value.trim(),
      path: sync.querySelector('#dav-path').value.trim() || 'starveil-sync.json',
      username: sync.querySelector('#dav-user').value.trim(),
      password: sync.querySelector('#dav-pass').value,
      insecureTls: sync.querySelector('#dav-insecure').getAttribute('aria-checked') === 'true',
      autoPull: sync.querySelector('#dav-autopull').getAttribute('aria-checked') === 'true',
    };
    setSetting('sync.webdav', next);
    return next;
  };
  const target = () => webdavUrl(readForm());

  sync.querySelectorAll('.switch').forEach((button) => {
    button.addEventListener('click', () => {
      button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
      readForm();
    });
  });
  for (const id of ['#dav-url', '#dav-path', '#dav-user', '#dav-pass']) {
    sync.querySelector(id).addEventListener('change', readForm);
  }

  sync.querySelector('#dav-test').addEventListener('click', async () => {
    const cfg = readForm();
    try {
      const info = await api.webdavTest(target(), cfg.username, cfg.password, cfg.insecureTls);
      // 浏览器演示模式下命令会返回 null，这里给一句明确的提示而不是 TypeError。
      if (!info) throw new Error('浏览器演示模式没有后端，WebDAV 只能在应用内使用');
      showState(
        info.exists
          ? `连接正常，云端已有同步文件${info.modified ? `（${info.modified}）` : ''}`
          : '连接正常，云端还没有同步文件，可以直接上传'
      );
    } catch (error) {
      showState(String(error), 'error');
    }
  });

  sync.querySelector('#dav-upload').addEventListener('click', async () => {
    const cfg = readForm();
    try {
      const bundle = buildBundle();
      await api.webdavUpload(target(), cfg.username, cfg.password, JSON.stringify(bundle, null, 2), cfg.insecureTls);
      setSetting('sync.lastSyncAt', Date.now());
      showState('已上传，云端文件被本机数据覆盖');
    } catch (error) {
      showState(String(error), 'error');
    }
  });

  sync.querySelector('#dav-download').addEventListener('click', async () => {
    const cfg = readForm();
    const ok = await confirmDialog({
      title: '下载覆盖本机',
      text: '云端的关注、观看记录与设置会覆盖本机同名数据，本机独有的条目不会保留。',
      okLabel: '覆盖',
      danger: true,
    });
    if (!ok) return;
    try {
      const payload = await api.webdavDownload(target(), cfg.username, cfg.password, cfg.insecureTls);
      importData(JSON.parse(payload.content));
      setSetting('sync.lastSyncAt', Date.now());
      showState('已从云端同步，正在重新载入…');
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      showState(String(error), 'error');
    }
  });

  const tip = document.createElement('div');
  tip.className = 'pill-note';
  tip.style.marginTop = '14px';
  tip.innerHTML = `${icon('info', 16)}<div>同步包<b>不含登录 Cookie</b>；账号密码以明文存在本机设置里，别在公用电脑上保存。
    冲突处理只有「整包覆盖」，不做字段级合并；自动拉取只在云端比本机新时才应用。</div>`;
  sync.appendChild(tip);
}

/// 选一个 JSON 文件交给回调处理，导入入口（备份/迁移）共用。
function pickJsonFile(onPick) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onPick(file);
  });
  input.click();
}

/// 把导入摘要翻成一句人话。
function describeImport(summary) {
  const parts = [`关注 ${summary.follows} 个`, `观看记录 ${summary.history} 条`];
  if (summary.settings) parts.push(`设置 ${summary.settings} 项`);
  if (summary.accounts?.length) parts.push(`登录 ${summary.accounts.length} 个平台`);
  const skipped = Object.entries(summary.skipped || {});
  if (skipped.length) {
    parts.push(`跳过 ${skipped.map(([platform, count]) => `${PLATFORM_META[platform]?.name || platform} ${count} 条`).join('、')}（尚未支持该平台）`);
  }
  if (summary.truncated) parts.push(`超出上限丢弃 ${summary.truncated} 条`);
  return `导入完成：${parts.join('，')}`;
}

/// 把 WebDAV 的目录地址与文件名拼成完整 URL，容忍多写/少写斜杠。
function webdavUrl(config) {
  const base = String(config.url || '').trim();
  if (!base) throw new Error('请先填写 WebDAV 服务器地址');
  const path = String(config.path || 'starveil-sync.json').trim().replace(/^\/+/, '');
  return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
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
  // 隐藏开关：连点版本号 7 次解锁「发送弹幕」，做法与安卓的开发者选项一致。
  // 解锁说明见 docs/hidden-features.md（本地文档，不入库）。
  const versionLabel = card.querySelector('#about-version');
  let taps = 0;
  let lastTap = 0;
  versionLabel.addEventListener('click', async () => {
    const now = Date.now();
    taps = now - lastTap < 1500 ? taps + 1 : 1;
    lastTap = now;
    if (taps < 7) {
      // 点到第 4 下才开始给提示，正常浏览版本号的人不会误触发。
      if (taps >= 4) toast(`再点 ${7 - taps} 次…`, 'success');
      return;
    }
    taps = 0;
    const unlocked = Boolean(getSetting('danmaku.sendUnlocked'));
    const ok = await confirmDialog({
      title: unlocked ? '关闭实验功能' : '开启实验功能',
      text: unlocked
        ? '关闭后「弹幕设置 → 允许发送弹幕」会重新隐藏，已经发出去的弹幕不受影响。'
        : '发送弹幕会以你的账号向直播间发出真实消息，内容会公开显示。发送过快或内容违规可能被平台限流、禁言甚至封禁，风险由你自己承担。解锁后还需要到「弹幕设置」里手动打开开关；目前只有哔哩哔哩实现了发送接口，并且要求先登录。',
      okLabel: unlocked ? '关闭' : '我了解风险，解锁',
      danger: !unlocked,
    });
    if (!ok) return;
    setSetting('danmaku.sendUnlocked', !unlocked);
    // 关掉实验功能时顺手把发送开关也关掉，否则聊天栏的输入框还会留着。
    if (unlocked) setSetting('danmaku.sendEnabled', false);
    toast(
      unlocked ? '已关闭实验功能' : '已解锁：到「弹幕设置」里打开「允许发送弹幕」',
      'success',
    );
  });
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
    <div class="action-text"><h4>项目主页</h4><p>本项目的源码、更新日志与问题反馈</p></div>
    <button class="btn small">打开</button>`;
  actions.querySelector('button').addEventListener('click', () => api.openUrl(PROJECT_REPO));
  content.appendChild(actions);

  const reference = document.createElement('div');
  reference.className = 'settings-action-card';
  reference.innerHTML = `
    <div class="action-icon">${icon('github', 20)}</div>
    <div class="action-text"><h4>参考项目</h4><p>dart_simple_live —— 界面与协议层的来源</p></div>
    <button class="btn small">打开</button>`;
  reference.querySelector('button').addEventListener('click', () => api.openUrl(REFERENCE_REPO));
  content.appendChild(reference);

  const licenses = document.createElement('div');
  licenses.className = 'settings-action-card';
  licenses.innerHTML = `
    <div class="action-icon">${icon('shield', 20)}</div>
    <div class="action-text"><h4>许可与致谢</h4><p>协议层来源、第三方开源库与素材署名</p></div>
    <button class="btn small">查看</button>`;
  licenses.querySelector('button').addEventListener('click', () => ctx.go('settingsDetail', { key: 'licenses' }));
  content.appendChild(licenses);
}

// 许可与致谢：内容与仓库根目录的 THANKS.md 保持一致，改一处要同步改另一处。
const LICENSE_UPSTREAM = [
  ['dart_simple_live', 'xiaoyaocz · GPL-3.0', '界面与交互的参照物'],
  ['simple_live_core', 'xiaoyaocz · GPL-3.0', '三站取流与弹幕协议的主要来源'],
  ['AllLive', 'AllLive', '多平台聚合的早期思路'],
  ['simple-live-kuaishou', 'xuanxuan123xuan', '快手取流与弹幕的来源'],
];

const LICENSE_LIBS = [
  ['Tauri 2', 'MIT / Apache-2.0', '桌面外壳与 IPC'],
  ['mpegts.js 4.2.8', 'Apache-2.0', 'FLV 解封装 + MSE 播放'],
  ['hls.js 1.x', 'Apache-2.0', 'HLS（m3u8）播放'],
  ['fly-barrage', 'MIT', '弹幕渲染'],
  ['CryptoJS', 'MIT', '斗鱼 / 抖音签名计算'],
  ['douyin-sign.js', '字节跳动 webmssdk（仅本地随包，非商用）', '抖音弹幕握手签名'],
  ['qrcode', 'MIT', '扫码登录二维码'],
  ['reqwest / tungstenite / rustls', 'MIT / Apache-2.0', 'HTTP 与弹幕 WebSocket'],
  ['serde / brotli / flate2 / md5', 'MIT / Apache-2.0', '序列化与签名工具'],
];

function paintLicenses(content, ctx) {
  const intro = document.createElement('div');
  intro.className = 'tool-card';
  intro.innerHTML = `
    <h3>授权说明</h3>
    <p>星幕直播本身以 GPL-3.0 发布。下面列出的是本项目依赖或移植的上游项目，
       各自的授权不因本项目而改变。</p>
    <div class="pill-note">${icon('info', 16)}<div>直播平台的取流与弹幕均为各站私有接口，
      本项目没有从零逆向，协议实现移植自上表所列的开源项目。</div></div>`;
  content.appendChild(intro);

  const readme = document.createElement('div');
  readme.className = 'settings-action-card';
  readme.innerHTML = `
    <div class="action-icon">${icon('github', 20)}</div>
    <div class="action-text"><h4>完整声明</h4><p>仓库根目录的 THANKS.md（含素材与免责说明）</p></div>
    <button class="btn small">打开</button>`;
  readme.querySelector('button').addEventListener('click', () => api.openUrl(`${PROJECT_REPO}/blob/main/THANKS.md`));
  content.appendChild(readme);

  for (const [title, rows] of [
    ['协议层来源', LICENSE_UPSTREAM],
    ['开源库', LICENSE_LIBS],
  ]) {
    const label = document.createElement('div');
    label.className = 'settings-group-label';
    label.textContent = title;
    content.appendChild(label);
    const group = document.createElement('div');
    group.className = 'settings-group';
    for (const [name, license, purpose] of rows) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.innerHTML = `
        <div class="setting-info">
          <div class="setting-title">${escapeHtml(name)}</div>
          <div class="setting-desc">${escapeHtml(purpose)}</div>
        </div>
        <span class="item-value">${escapeHtml(license)}</span>`;
      group.appendChild(row);
    }
    content.appendChild(group);
  }

  const assets = document.createElement('div');
  assets.className = 'tool-card';
  assets.innerHTML = `
    <h3>素材、商标与签名脚本</h3>
    <p>「哔哩哔哩」「斗鱼」「虎牙」「抖音」「快手」等名称与图标是各公司的商标，
       本项目仅用于指示所对接的平台，与各公司无隶属或合作关系。</p>
    <p>抖音游戏分类的封面素材来自 dart_simple_live 的 DouyinGameArtwork，
       原始来源含 App Store / Steam / FLATICON 等，<b>仅限非商业使用</b>，不并入 GPL-3.0 授权。</p>
    <p>抖音取流所需的 a_bogus 签名脚本沿用 dart 版内置内容，
       原作者声明为「仅供学习交流，禁止商业与违法用途」，著作权归原作者所有。</p>`;
  content.appendChild(assets);
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
    <div class="pill-note">${icon('info', 16)}<div>哔哩哔哩支持扫码登录和 Cookie 登录；抖音、快手、斗鱼使用独立登录窗口，
      在窗口里登录完点「读取登录状态」即可，不用手动复制 Cookie。</div></div>`;
  content.appendChild(intro);

  const rows = [
    { platform: 'bilibili', login: loadLogin('bilibili'), canLogin: true },
    { platform: 'douyu', login: loadLogin('douyu'), canLogin: true },
    { platform: 'douyin', login: loadLogin('douyin'), canLogin: true },
    { platform: 'kuaishou', login: loadLogin('kuaishou'), canLogin: true },
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
        : `${login.name || '已登录'} · Cookie ${String(login.cookie).length} 字符`
      : entry.canLogin
        ? isBili
          ? '未登录 · 支持扫码 / Cookie'
          : platform === 'douyu'
            ? '未登录 · 支持 Cookie'
            : '未登录 · 支持网页登录'
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
        else if (platform === 'douyu') openDouyuLogin(repaint);
        else openWebLogin(platform, repaint);
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

/**
 * 抖音 / 快手（以及任何有网页登录页的平台）的登录框。
 *
 * 登录本身在一个独立窗口里完成，和主窗口共用 WebView2 的 Cookie 存储；
 * 这里只负责「打开窗口」和「把 Cookie 读回来」，不让用户去开发者工具里翻。
 */
function openWebLogin(platform, onDone) {
  const meta = PLATFORM_META[platform];
  const body = document.createElement('div');
  body.className = 'login-body';
  body.innerHTML = `
    <p class="login-hint">点「打开登录窗口」会弹出一个独立窗口，在窗口里扫码或输入账号登录 ${escapeHtml(meta.name)}。
      登录完成后回到这里点「读取登录状态」，客户端会直接从窗口里取出 Cookie，不需要手动复制。</p>
    <div class="login-actions">
      <button class="btn primary" id="web-login-open">打开登录窗口</button>
      <button class="btn" id="web-login-capture">读取登录状态</button>
    </div>
    <div class="login-status" id="web-login-status">还没有读取登录状态</div>`;
  const modal = openModal({
    title: `${meta.name}登录`,
    subtitle: '独立登录窗口 · 登录后自动读取 Cookie',
    width: 540,
    body,
    actions: [{ label: '关闭', kind: 'ghost' }],
  });

  const status = body.querySelector('#web-login-status');
  const openButton = body.querySelector('#web-login-open');
  const captureButton = body.querySelector('#web-login-capture');

  openButton.addEventListener('click', async () => {
    openButton.disabled = true;
    status.textContent = '正在打开登录窗口…';
    try {
      await api.openLoginWindow(platform);
      status.textContent = '登录窗口已打开：在窗口里完成扫码或账号登录，然后回到这里点「读取登录状态」';
    } catch (error) {
      status.textContent = `打开失败：${error}`;
    } finally {
      openButton.disabled = false;
    }
  });

  captureButton.addEventListener('click', async () => {
    captureButton.disabled = true;
    captureButton.textContent = '读取中…';
    status.textContent = '正在读取窗口里的 Cookie…';
    try {
      const { user, cookie } = await api.captureLogin(platform);
      if (!user.logged_in) {
        status.textContent = user.message || '没有读到登录状态';
        return;
      }
      await api.setCookie(platform, cookie);
      saveLogin(platform, {
        cookie,
        name: user.name || `${meta.name}账号`,
        avatar: user.avatar || '',
        uid: user.uid || '',
      });
      status.textContent = user.message || '已登录';
      toast(`已登录：${user.name || meta.name}`, 'success');
      modal.close();
      onDone();
    } catch (error) {
      status.textContent = `读取失败：${error}`;
    } finally {
      captureButton.disabled = false;
      captureButton.textContent = '读取登录状态';
    }
  });
}

// ---------------------------------------------------------------- 一级动作

function runSettingAction(ctx, action) {
  if (action === 'github') {
    api.openUrl(PROJECT_REPO);
    return;
  }
}
