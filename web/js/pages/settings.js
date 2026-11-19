// 设置：一级列表 + 二级详情。大部分选项会真正写入 localStorage 并即时生效。
import { api, formatCount, formatOnline, timeAgo, roomUrl } from '../api.js';
import {
  aggregateStats,
  applySkin,
  applyTheme,
  currentAccent,
  currentAccentValue,
  currentSkin,
  clearHistory,
  clearLogin,
  clearStats,
  collectAccounts,
  HISTORY_LIMIT,
  STATS_RANGES,
  getSetting,
  loadFollow,
  loadLogin,
  loadSearchHistory,
  loadStats,
  resetSettings,
  saveLogin,
  setAccent,
  setSetting,
  state,
} from '../store.js';
import { icon, PLATFORM_META, platformAsset } from '../icons.js';
import { SKINS, accentForMode, skinAccents, skinModes } from '../../skins/registry.js';
// 外部数据导入（starveil 备份 / dart profile / 中立同步包）与同步包构建。
import { buildBundle, bundleScope, importData } from '../importer.js';
// 弹幕性能/帧率选项由 danmaku.js 提供，与直播间共用。
import { DANMAKU_PRESETS, FPS_OPTIONS, PERF_OPTIONS } from '../danmaku.js';
// 缓冲档位和播放器参数是同一份定义（player-buffer.js），别再抄一遍数值。
import { BUFFER_PRESETS } from '../player-buffer.js';
// 移动端专属设置项（屏幕方向）要按平台显示。
import { IS_MOBILE } from '../platform.js';
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

// 兜底版本号，与 tauri.conf.json 一致；运行时优先用 app.getVersion()。
const FALLBACK_VERSION = '0.7.5';
// 本项目自己的仓库（「设置 → 开源主页」与关于页的「项目主页」都指向这里）。
const PROJECT_REPO = 'https://github.com/banlany/Starveil';
// 参考项目（原版 dart_simple_live 的 fork），保留在关于页作为致敬入口。
const REFERENCE_REPO = 'https://github.com/June6699/dart_simple_live';

// select 行要的是 { 值: 文案 }，这里由共享选项表派生，避免手工维护两份。
const PERF_MAP = Object.fromEntries(PERF_OPTIONS.map((option) => [option.value, option.label]));
const FPS_MAP = Object.fromEntries(FPS_OPTIONS.map((option) => [option.value, option.label]));

/// 档位数组转成 { 值: 文案 }；当前值不在档位里时补一项。
function presetMap(key, values, format) {
  const list = [...values];
  const current = Number(getSetting(key));
  if (Number.isFinite(current) && !list.includes(current)) {
    list.push(current);
    list.sort((a, b) => a - b);
  }
  return Object.fromEntries(list.map((value) => [value, format(value)]));
}

/// 弹幕数值项统一用预设下拉，与直播间「设置」页签共用 DANMAKU_PRESETS。
function presetRow(key, title, values, format, desc = '') {
  return { type: 'select', key, title, desc, numeric: true, valueMap: presetMap(key, values, format) };
}

// 一级列表按用途分组，同组项共用一个标签。
const SETTINGS_GROUPS = [
  {
    label: '通用',
    items: [
      { key: 'appearance', icon: 'moon', label: '外观设置' },
      { key: 'home', icon: 'home', label: '主页设置' },
    ],
  },
  {
    label: '直播',
    items: [
      { key: 'playback', icon: 'player', label: '播放与直播' },
      { key: 'danmaku', icon: 'danmaku', label: '弹幕设置' },
      { key: 'follow', icon: 'follow', label: '关注设置' },
      { key: 'link', icon: 'parse', label: '链接解析' },
    ],
  },
  {
    label: '数据',
    items: [
      { key: 'history', icon: 'history', label: '观看记录' },
      { key: 'account', icon: 'account', label: '账号管理' },
      { key: 'sync', icon: 'sync', label: '数据同步' },
    ],
  },
  {
    label: '应用',
    items: [{ key: 'about', icon: 'info', label: '关于 Starveil' }],
  },
];

const DETAIL_TITLES = {
  history: '观看记录',
  account: '账号管理',
  sync: '数据同步',
  link: '链接解析',
  appearance: '外观设置',
  home: '主页设置',
  playback: '播放与直播',
  danmaku: '弹幕设置',
  follow: '关注设置',
  disclaimer: '免责声明',
  licenses: '许可与致谢',
  about: '关于 Starveil',
};

export function renderSettings(ctx) {
  const page = document.createElement('section');
  page.className = 'settings-page';
  page.innerHTML = `
    <div class="settings-shell">
      <div class="profile-row" id="profile-row">
        <div class="profile-logo"><img src="assets/logo.png" alt="Starveil" /></div>
        <div class="profile-text">
          <h2>Starveil</h2>
          <p>把喜欢的直播，放在同一幕</p>
        </div>
        <span class="chev">${icon('chevron', 18)}</span>
      </div>
      <div class="settings-list" id="settings-list"></div>
    </div>`;
  const list = page.querySelector('#settings-list');
  for (const group of SETTINGS_GROUPS) {
    const label = document.createElement('div');
    label.className = 'settings-group-label';
    label.textContent = group.label;
    list.appendChild(label);
    for (const item of group.items) {
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
      row.addEventListener('click', () => ctx.go('settingsDetail', { key: item.key }));
      list.appendChild(row);
    }
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
  // 雪白的实际色值随明暗档变化，切换后需重绘色块。
  const onTheme = () => {
    if (key === 'appearance') paint();
  };
  window.addEventListener('simple-live:theme', onTheme);
  // 局域网轮询跟随页面生命周期，离页即停。
  return () => {
    window.removeEventListener('simple-live:theme', onTheme);
    stopSyncTimers();
  };
}

// ---------------------------------------------------------------- 行构建

/// 当前生效的明暗档，读 <html data-theme>。
function currentMode() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function buildRow(config, repaint, ctx) {
  if (config.type === 'skin') {
    // 皮肤清单来自 skins/registry.js，这里不维护第二份。
    const wrap = document.createElement('div');
    wrap.className = 'skin-picker';
    const grid = document.createElement('div');
    grid.className = 'skin-grid';
    const active = currentSkin().id;
    for (const skin of SKINS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `skin-card${skin.id === active ? ' is-active' : ''}`;
      card.setAttribute('aria-pressed', String(skin.id === active));
      // 色点：当前皮肤取实际在用的色，其它皮肤取 accents 第一项；都按当前明暗档换算。
      const modes = skinModes(skin.id);
      const fallback = skinAccents(skin.id)[0]?.color || 'currentColor';
      const dot = skin.id === active ? currentAccent() : accentForMode(fallback, currentMode());
      card.innerHTML = `
        <span class="skin-dot" style="background:${escapeHtml(dot)}" aria-hidden="true"></span>
        <span class="skin-text">
          <b>${escapeHtml(skin.name)}</b>
          <small>${escapeHtml(skin.desc || '')}</small>
          <em>${modes.length > 1 ? '深色 / 浅色' : modes[0] === 'light' ? '仅浅色' : '仅深色'}</em>
        </span>
        ${skin.id === active ? `<span class="skin-check">${icon('check', 15)}</span>` : ''}`;
      card.addEventListener('click', async () => {
        if (currentSkin().id === skin.id) return;
        await applySkin(skin.id);
        repaint();
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    if (SKINS.length < 2) {
      const note = document.createElement('p');
      note.className = 'skin-picker-note';
      note.textContent = '更多皮肤还在做。做好之后会直接出现在这里，不用更新这一版。';
      wrap.appendChild(note);
    }
    return wrap;
  }

  if (config.type === 'radioGroup') {
    const fragment = document.createDocumentFragment();
    for (const option of config.options) {
      const row = document.createElement('div');
      // 皮肤只支持一档时，这一行只做展示：点击会覆盖用户存着的明暗偏好。
      const locked = Boolean(config.lockedValue);
      row.className = `setting-row${locked ? '' : ' clickable'}`;
      const checked = locked ? option.value === config.lockedValue : getSetting(config.key) === option.value;
      row.innerHTML = `
        <span class="radio${checked ? ' checked' : ''}"></span>
        <div class="setting-info"><div class="setting-title">${escapeHtml(option.label)}</div>${option.desc ? `<div class="setting-desc">${escapeHtml(option.desc)}</div>` : ''}</div>`;
      if (!locked) {
        row.addEventListener('click', () => {
          setSetting(config.key, option.value);
          if (config.onChange) config.onChange(option.value);
          repaint();
        });
      }
      fragment.appendChild(row);
    }
    return fragment;
  }

  const row = document.createElement('div');
  row.className = `setting-row${config.type === 'action' || config.type === 'select' || config.type === 'colors' ? ' clickable' : ''}`;
  const info = document.createElement('div');
  info.className = 'setting-info';
  info.innerHTML = `<div class="setting-title">${config.icon ? `<span class="row-icon">${icon(config.icon, 20)}</span>` : ''}${escapeHtml(config.title)}${config.tag ? `<span class="chip solid mini">${escapeHtml(config.tag)}</span>` : ''}</div>${config.desc ? `<div class="setting-desc">${escapeHtml(config.desc)}</div>` : ''}`;
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
    // 超长值会被省略号截断，悬停时给出全文。
    value.title = config.value ?? '';
    control.appendChild(value);
  } else if (config.type === 'colors') {
    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    // 预设色来自当前皮肤 registry，第一项为默认色。
    const accents = skinAccents(currentSkin().id);
    const fallback = accents[0].color;
    const current = String(currentAccentValue()).toLowerCase();
    for (const accent of accents) {
      const isDefault = accent.color.toLowerCase() === fallback.toLowerCase();
      const swatch = document.createElement('button');
      swatch.className = `swatch${current === accent.color.toLowerCase() ? ' active' : ''}`;
      // 色块按当前明暗档换算后显示。
      swatch.style.background = accentForMode(accent.color, currentMode());
      swatch.title = isDefault ? `${accent.name}（这套皮肤的默认色）` : accent.name;
      swatch.setAttribute('aria-label', accent.name);
      swatch.addEventListener('click', () => {
        setAccent(accent.color, isDefault);
        repaint();
      });
      swatches.appendChild(swatch);
    }
    // 自定义色写入 appearance.accent，并标记为用户自选。
    const custom = !accents.some((accent) => accent.color.toLowerCase() === current);
    const picker = document.createElement('button');
    picker.className = `swatch swatch-custom${custom ? ' active' : ''}`;
    picker.title = custom ? `自定义：${current}` : '自定义颜色';
    if (custom) picker.style.background = current;
    picker.insertAdjacentHTML('beforeend', icon('plus', 14));
    picker.addEventListener('click', async () => {
      const input = await promptDialog({
        title: '自定义主题色',
        text: '输入十六进制色值，例如 #7C4DFF（也可以不写 #）',
        placeholder: '#7C4DFF',
        value: custom ? current : '',
      });
      if (input === null) return;
      const color = normalizeHex(input);
      if (!color) {
        toast('色值格式不对，需要 3 位或 6 位十六进制，比如 #7C4DFF');
        return;
      }
      setAccent(color);
      repaint();
    });
    swatches.appendChild(picker);
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

// 当前 WebView 实际使用的 GPU：ANGLE 字符串里取设备名。
function currentRendererName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const raw = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    const angled = /^ANGLE \([^,]+,\s*(.+)\)$/.exec(raw);
    const name = angled ? angled[1] : raw;
    return name
      .replace(/\s*\(0x[0-9A-Fa-f]+\)/, '')
      .replace(/\s*(Direct3D11|D3D11|Direct3D9|OpenGL|Vulkan|Metal).*$/, '')
      .trim();
  } catch {
    return '';
  }
}

function detailSections(key, ctx, repaint) {
  switch (key) {
    case 'appearance': {
      const modes = skinModes(currentSkin().id);
      const locked = modes.length === 1;
      const LOCKED_HINT = '当前皮肤只提供一套配色，明暗随皮肤固定；换一套支持双主题的皮肤即可切换';
      return [
        {
          label: '皮肤',
          rows: [{ type: 'skin' }],
        },
        {
          label: '显示主题',
          rows: [
            {
              type: 'radioGroup',
              key: 'appearance.theme',
              // 只列出皮肤支持的明暗档；单档皮肤这一行不可点，存的偏好留着不动。
              lockedValue: locked ? modes[0] : '',
              options: [
                ...(locked ? [] : [{ label: '跟随系统', value: 'system', desc: '随系统的深色/浅色设置自动切换' }]),
                ...(modes.includes('light') ? [{ label: '浅色模式', value: 'light', desc: locked ? LOCKED_HINT : '' }] : []),
                ...(modes.includes('dark') ? [{ label: '深色模式', value: 'dark', desc: locked ? LOCKED_HINT : '' }] : []),
              ],
              onChange: () => {
                state.settings.theme = getSetting('appearance.theme');
                applyTheme();
              },
            },
          ],
        },
        // 只有一套配色的皮肤不提供主题色选择。
        ...(skinAccents(currentSkin().id).length > 1
          ? [{ label: '主题颜色', rows: [{ type: 'colors' }] }]
          : []),
        { label: '界面密度', rows: [{ type: 'select', key: 'appearance.density', title: '卡片与列表间距', valueMap: { comfortable: '标准', compact: '紧凑', relaxed: '宽松' }, onChange: (value) => { document.body.dataset.density = value; } }] },
        // 屏幕方向只有移动端有意义：桌面窗口的尺寸方向由用户自己拖。
        ...(IS_MOBILE
          ? [{
            label: '屏幕方向',
            rows: [
              {
                type: 'radioGroup',
                key: 'appearance.orientation',
                options: [
                  { label: '自动', value: 'auto', desc: '跟随设备重力方向旋转' },
                  { label: '固定竖屏', value: 'portrait', desc: '手机转成横向时也保持竖屏' },
                  { label: '固定横屏', value: 'landscape', desc: '适合看直播，画面更大' },
                ],
                onChange: (value) => {
                  api.setScreenOrientation(value).catch((error) => console.warn('设置屏幕方向失败', error));
                },
              },
            ],
          }]
          : [{ label: '窗口', rows: [{ type: 'switch', key: 'other.rememberWindow', title: '记住窗口大小和位置', desc: '下次启动时恢复上次的窗口尺寸' }] }]),
      ];
    }
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
    case 'playback': {
      // 定时关闭的状态由应用层维护，这里只读。
      const timerInfo = ctx.sleepTimer?.() || { enabled: false, minutes: getSetting('timer.minutes'), remaining: 0 };
      const timerMinutes = timerInfo.enabled ? Math.max(1, Math.ceil(timerInfo.remaining / 60000)) : 0;
      return [
        {
          label: '播放器',
          rows: [
            ...(IS_MOBILE
              ? []
              : [
                  {
                    type: 'select',
                    key: 'player.gpu',
                    title: '图形设备',
                    desc: '重启后生效；软件渲染只在画面异常时用',
                    valueMap: {
                      auto: '自动（跟随系统）',
                      low: '核显',
                      high: '独立显卡',
                      off: '关闭硬件加速',
                    },
                    onChange: (mode) => {
                      api.setGpuMode(mode)
                        .then(() => toast('重启后生效', 'success'))
                        .catch((error) => toast(String(error), 'error'));
                    },
                  },
                  { type: 'info', title: '当前渲染器', value: currentRendererName() || '未知' },
                ]),
            { type: 'switch', key: 'player.rememberQuality', title: '记住清晰度', desc: '同一平台下次进入直播间时沿用上次选择' },
            {
              type: 'select',
              key: 'player.defaultQuality',
              title: '默认清晰度',
              desc: '没有记住的清晰度时按这里选；平台没提供对应档位时退回平台默认档',
              valueMap: {
                auto: '跟随平台',
                highest: '最高清晰度',
                // 键名不能是纯数字，否则对象键按数值排序会打乱菜单顺序。
                fullhd: '1080P 优先',
                hd: '720P 优先',
                sd: '480P 优先',
                smooth: '流畅优先',
              },
              onChange: () => {
                // 改默认清晰度时清掉各平台记住的档位；键面前缀与 room.js 一致。
                for (const key of Object.keys(localStorage)) {
                  if (key.startsWith('simple-live.quality.')) localStorage.removeItem(key);
                }
                toast('默认清晰度已更新，进入直播间时生效');
              },
            },
            {
              type: 'select',
              key: 'player.buffer',
              title: '播放缓冲',
              desc: '觉得画面比弹幕慢好几秒就选低延迟；网络差、频繁卡顿就选流畅优先。改完重新进直播间生效。',
              valueMap: Object.fromEntries(Object.entries(BUFFER_PRESETS).map(([key, preset]) => [key, preset.label])),
              onChange: (value) => toast(`已切到「${BUFFER_PRESETS[value]?.label || value}」，重新进入直播间生效`),
            },
            { type: 'switch', key: 'player.autoSwitchLine', title: '播放失败自动换线', desc: '当前线路连续失败时自动尝试下一条' },
            { type: 'switch', key: 'player.autoRefresh', title: '直播流自动刷新', desc: '长时间播放后重新获取直链，避免地址过期' },
            { type: 'switch', key: 'player.forceHttps', title: '强制 HTTPS', desc: '把平台下发的 http 链接改为 https（部分 CDN 不支持时请关闭）' },
            { type: 'select', key: 'player.scaleMode', title: '画面尺寸', valueMap: { contain: '适应', cover: '铺满', fill: '拉伸' }, onChange: (value) => applyScaleMode(value) },
            { type: 'switch', key: 'player.showStats', title: '显示播放统计信息' },
          ],
        },
        {
          label: '直播间',
          rows: [
            { type: 'switch', key: 'player.autoFullscreen', title: '进入直播间自动全屏' },
            { type: 'switch', key: 'player.muteOnStart', title: '进入直播间默认静音' },
            { type: 'switch', key: 'live.autoSwitchNext', title: '关播后自动换下一个', desc: '当前房间确认下播后，自动切到关注列表里的下一个直播间' },
            { type: 'switch', key: 'live.allowBackground', title: '允许后台继续播放', desc: '窗口失去焦点时保持视频与弹幕连接' },
            { type: 'switch', key: 'live.gesture', title: '滑动调节音量/亮度', desc: '播放页左右两侧上下滑动调节' },
            { type: 'switch', key: 'live.hideDanmakuOnMinimize', title: '最小化时隐藏弹幕' },
          ],
        },
        {
          label: '定时关闭',
          rows: [
            { type: 'switch', key: 'timer.enabled', title: '启用定时关闭', desc: '直播间「更多 → 定时关闭」也是同一个开关，两边同步', onChange: () => ctx.restartTimer?.() },
            { type: 'number', key: 'timer.minutes', title: '自动关闭时间', desc: '从开启那一刻开始倒计时', min: 5, max: 720, step: 5, unit: ' 分钟', onChange: () => ctx.restartTimer?.() },
            { type: 'switch', key: 'timer.once', title: '只生效一次', desc: '计时结束退出应用后自动关闭定时关闭；不打开则每次启动应用都会重新计时' },
            {
              type: 'info',
              title: '当前状态',
              desc: timerInfo.enabled
                ? `约 ${timerMinutes} 分钟后自动退出应用${getSetting('timer.once') ? '，退出后自动关闭' : '，每次启动都会重新计时'}`
                : '未开启，可以在直播间「更多」里直接开',
              value: timerInfo.enabled ? '计时中' : '关闭',
            },
          ],
        },
        {
          label: '提示',
          rows: [{ type: 'info', title: '平台差异', desc: '虎牙不提供贡献榜；抖音、快手已支持观看与账号登录，弹幕暂未接入，快手搜索暂不可用', value: '五站可选' }],
        },
      ];
    }
    case 'danmaku': {
      const groups = [
        {
          label: '弹幕屏蔽',
          rows: [
            { type: 'switch', key: 'danmaku.block', title: '启用弹幕屏蔽', desc: '关闭后，关键词屏蔽会暂时失效' },
            { type: 'textarea', key: 'danmaku.blockKeywords', title: '关键词屏蔽', desc: '每行一个关键词，命中后不显示该弹幕', placeholder: '例如：广告\n加群' },
          ],
        },
        {
          label: '弹幕显示',
          rows: [
            { type: 'switch', key: 'danmaku.enabled', title: '默认开启弹幕' },
            presetRow('danmaku.area', '显示区域', DANMAKU_PRESETS.area, (value) => `${value}%`, '弹幕占据播放器顶部的高度比例'),
            presetRow('danmaku.lines', '显示几行', DANMAKU_PRESETS.lines, (value) => `${value} 行`, '按区域优先，超出可用高度时自动收紧'),
            { type: 'switch', key: 'danmaku.emoji', title: '显示弹幕表情' },
            presetRow('danmaku.bigEmojiLines', '大表情大小', DANMAKU_PRESETS.bigEmoji, (value) => `${value} 行`, '只能单独发送的大表情占几行高；占几行就预留几条弹幕轨道，旁边的弹幕会自动让开'),
            presetRow('danmaku.speed', '滚动速度', DANMAKU_PRESETS.speed, (value) => `${value} 秒`, '弹幕持续秒数，越小越快'),
            presetRow('danmaku.opacity', '不透明度', DANMAKU_PRESETS.opacity, (value) => `${value}%`),
            presetRow('danmaku.font', '字体大小', DANMAKU_PRESETS.font, (value) => `${value} px`),
            { type: 'select', key: 'danmaku.weight', title: '字体粗细', numeric: true, valueMap: { 300: '极细', 400: '很细', 500: '正常', 600: '小粗', 700: '偏粗', 800: '很粗', 900: '极粗' } },
            { type: 'switch', key: 'danmaku.stroke', title: '弹幕描边' },
            presetRow('danmaku.strokeWidth', '描边宽度', DANMAKU_PRESETS.strokeWidth, (value) => `${value} px`),
            { type: 'select', key: 'danmaku.fps', title: '帧率上限', desc: '限制弹幕层的重绘频率，越低越省电', numeric: true, valueMap: FPS_MAP },
            presetRow('danmaku.safeTop', '顶部安全边距', DANMAKU_PRESETS.safe, (value) => `${value} px`, '相对画面顶端；0 表示贴着顶端'),
            presetRow('danmaku.safeBottom', '底部安全边距', DANMAKU_PRESETS.safe, (value) => `${value} px`),
          ],
        },
        {
          label: '性能',
          rows: [
            {
              type: 'select',
              key: 'danmaku.perf',
              title: '性能档位',
              desc: '弹幕密集时卡顿就往下调：流畅档降低画布精度，极速档还会关描边并少放一些弹幕',
              valueMap: PERF_MAP,
            },
          ],
        },
        {
          label: '重复弹幕过滤',
          rows: [
            { type: 'switch', key: 'danmaku.dedupe', title: '启用重复过滤' },
            { type: 'select', key: 'danmaku.dedupeMode', title: '过滤模式', valueMap: { content: '按内容', user: '按用户', strict: '刷屏严格' } },
            presetRow('danmaku.dedupeWindow', '过滤窗口', DANMAKU_PRESETS.dedupeWindow, (value) => `${value} 秒`, '窗口内重复的弹幕会被合并'),
            presetRow('danmaku.dedupeStep', '过滤步长', DANMAKU_PRESETS.dedupeStep, (value) => `${value}`),
          ],
        },
        { label: '提示', rows: [{ type: 'info', title: '即时生效', desc: '修改会立即保存，并在当前/下一个直播间生效', value: '已保存到本机' }] },
      ];
      // 发送弹幕默认隐藏，需在「关于」页连点版本号 7 次解锁。
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
            { type: 'info', title: '手动刷新', desc: '点击左上角的刷新按钮，随时刷新全部关注主播的直播状态。', value: '左上角 ↻' },
            { type: 'select', key: 'follow.threads', title: '更新线程数', numeric: true, valueMap: { 0: '自动', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8' } },
            { type: 'select', key: 'follow.pageSize', title: '关注每页数量', numeric: true, valueMap: { 50: '50', 100: '100', 150: '150', 200: '200', 300: '300', 400: '400' } },
          ],
        },
        {
          label: '排序',
          rows: [
            // 排序按近期观看次数，直播中的始终排在前面。
            { type: 'select', key: 'follow.sortWindow', title: '按进房热度排序', numeric: true, valueMap: { 7: '近 7 天的进房次数', 15: '近 15 天的进房次数', 0: '累计进房次数' }, desc: '直播中的主播始终排在前面；这一项决定其余情况下的顺序。' },
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
  // 观看记录页两个视图：原始记录与统计，共用同一份数据源。
  let view = 'records';
  let range = 'week';
  let shown = 120;

  const paint = ({ animate = true } = {}) => {
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
    if (!animate) return;
    // 重放动画 class 以重新触发过渡。
    content.classList.remove('pane-in');
    void content.offsetWidth;
    content.classList.add('pane-in');
  };

  function paintRecords() {
    // 重新渲染前清掉上一次画的内容，避免叠加。
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

  // 首次进来不额外淡入：页面本身已经有入场动画，叠两层反而显得慢。
  paint({ animate: false });
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

/// 局域网同步里显示包体大小：几百字节的包写成「0 KB」会让人以为什么都没收到。
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} 字节`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/// 规整为 `#rrggbb`，接受 `#RGB` / `#RRGGBB` / 无 `#`，无法识别时返回 null。
function normalizeHex(input) {
  const raw = String(input || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.split('').map((ch) => ch + ch).join('')}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

/// 毫秒转成「2 小时 13 分」，最大单位为小时。
function formatWatchTime(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

/// 同步包范围说明，清单取自 bundleScope()，每次现算。
function bundleScopeNote() {
  const scope = bundleScope();
  const list = (items) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<div class="pill-note">${icon('info', 16)}<div>
    <b>同步包包含</b><ul class="bundle-scope">${list(scope.included)}</ul>
    <b>不会同步（跟设备或凭据绑定）</b><ul class="bundle-scope">${list(scope.excluded)}</ul>
  </div></div>`;
}

/// 「同步内容」卡片：控制同步包是否带观看记录与登录信息，不影响本机备份。
function paintSyncScope(content, repaint) {
  const scope = getSetting('sync', {}) || {};
  const historyOn = scope.includeHistory !== false;
  const accountsOn = scope.includeAccounts === true;

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <h3>同步内容</h3>
    <p>决定「局域网同步」和「WebDAV 同步」打包时带哪些数据。本机备份是导出到自己磁盘上的文件，
       始终包含全部内容，不受这里影响。</p>
    <div class="sync-form">
      <div class="sync-toggles">
        <div class="sync-toggle"><span>同步观看记录</span>
          <button class="switch" id="sync-inc-history" aria-checked="${historyOn}"></button></div>
        <div class="sync-toggle"><span>同步登录信息（Cookie）</span>
          <button class="switch" id="sync-inc-accounts" aria-checked="${accountsOn}"></button></div>
      </div>
    </div>
    <div id="sync-inc-warn"></div>`;
  content.appendChild(card);

  const warn = card.querySelector('#sync-inc-warn');
  const paintWarn = (on) => {
    if (!on) {
      warn.innerHTML = '';
      return;
    }
    warn.innerHTML = `<div class="pill-note warn">${icon('info', 16)}<div>
      登录 Cookie 会写进同步包：WebDAV 上那份 JSON 谁拿到都能用，
      同一 Wi-Fi 下任何知道你地址的人也能从局域网同步端口<b>整包拉走</b>。
      只在完全信任的网络与网盘上用。</div></div>`;
  };
  paintWarn(accountsOn);

  card.querySelector('#sync-inc-history').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    setSetting('sync.includeHistory', next);
    repaint();
  });

  card.querySelector('#sync-inc-accounts').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    setSetting('sync.includeAccounts', next);
    repaint();
  });
}

// 「数据同步」页的局域网轮询定时器。页面级单例：进页启动、离页停掉。
let syncPollTimer = null;
function stopSyncTimers() {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
}

function paintSync(content, ctx, repaint) {
  // 轮询定时器由页面 dispose 清理，重画前先清旧定时器。
  stopSyncTimers();
  // ① 本机备份：仍是原来的导出一份 JSON / 导入回来。
  const backup = document.createElement('div');
  backup.className = 'tool-card';
  backup.innerHTML = `
    <h3>本机数据备份</h3>
    <p>导出设置、关注列表、观看记录、搜索历史、观看统计和登录信息为一个 JSON 文件；
       换机器或重装时可以再导入回来。</p>
    <div class="tool-actions">
      <button class="btn primary" id="sync-export">${icon('download', 16)} 导出备份</button>
      <button class="btn" id="sync-import">${icon('upload', 16)} 导入备份</button>
    </div>`;
  const backupNote = document.createElement('div');
  backupNote.className = 'pill-note';
  backupNote.style.marginTop = '14px';
  backupNote.innerHTML = `${icon('info', 16)}<div>备份文件存在你自己的磁盘上，所以<b>含登录 Cookie 与 WebDAV 口令</b>（同步包不含这两项）。
      数据平时只在本机 localStorage 里，不上传服务器；导入会覆盖同名类别的数据。</div>`;
  backup.appendChild(backupNote);
  content.appendChild(backup);

  backup.querySelector('#sync-export').addEventListener('click', async () => {
    const payload = {
      version: 2,
      app: 'Starveil',
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      // shield 沿用 dart 导出命名，导入侧认这个键。
      shield: {
        keywords: state.settings.danmaku?.blockKeywords || '',
      },
      // 走 store 读取，避免坏数据导致导出无反应。
      follows: loadFollow(),
      history: state.history,
      // 备份与同步包都带上这两项，否则换机后统计面板为空。
      search: loadSearchHistory(),
      stats: loadStats(),
      // 登录信息（Cookie）一并导出，换机后导入即可恢复登录态。
      accounts: collectAccounts(),
    };
    const filename = `starveil-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const saved = await saveJsonFile(filename, payload);
    if (saved) toast('备份已导出', 'success');
  });
  backup.querySelector('#sync-import').addEventListener('click', () => pickJsonFile(runImport));

  // ② 同步内容：决定局域网与 WebDAV 打包时带什么，开关改动后重绘。
  paintSyncScope(content, repaint);

  // ③ 局域网同步：同一 Wi-Fi 下自动发现并通过本机 HTTP 服务传输（src-tauri/src/lan_sync.rs）。
  const lan = document.createElement('div');
  lan.className = 'tool-card';
  lan.innerHTML = `
    <h3>局域网同步</h3>
    <p>同一 Wi-Fi 下打开了本页的设备会自动互相发现。可以直接拉取对方的配置覆盖本机，
       也可以把自己的配置发过去覆盖对方；数据只在两台设备之间传输。</p>
    <div class="lan-self" id="lan-self"></div>
    <div class="lan-peers" id="lan-peers"></div>
    <div class="lan-manual">
      <input class="input" id="lan-address" placeholder="没找到？手动填对方地址，如 192.168.1.20:23244" />
      <button class="btn" id="lan-connect">${icon('link', 16)} 连接</button>
    </div>
    <div id="lan-state"></div>`;
  content.appendChild(lan);
  const lanScope = document.createElement('div');
  lanScope.style.marginTop = '14px';
  lanScope.innerHTML = bundleScopeNote();
  lan.appendChild(lanScope);

  const lanSelf = lan.querySelector('#lan-self');
  const lanPeers = lan.querySelector('#lan-peers');
  const lanState = lan.querySelector('#lan-state');
  const showLanState = (text, tone = 'info') => {
    lanState.innerHTML = `<div class="pill-note" style="margin-top:14px">${icon(
      tone === 'error' ? 'info' : tone === 'success' ? 'check' : 'info',
      16
    )}<div>${escapeHtml(text)}</div></div>`;
  };

  // 发现列表每 2 秒刷新，自身数据每 15 秒发布一次。
  let lastPublish = 0;
  let busy = false;
  const publish = async () => {
    try {
      await api.lanSyncPublish(JSON.stringify(buildBundle()));
      lastPublish = Date.now();
    } catch (error) {
      console.warn('发布本机数据失败', error);
    }
  };

  const renderPeers = (peers) => {
    if (!peers.length) {
      lanPeers.innerHTML = `<div class="lan-empty">正在搜索同一局域网内的设备…</div>`;
      return;
    }
    lanPeers.innerHTML = '';
    for (const peer of peers) {
      const row = document.createElement('div');
      row.className = 'lan-peer';
      row.innerHTML = `
        <div class="lan-peer-main">
          <div class="lan-peer-name">${escapeHtml(peer.name || '未知设备')}</div>
          <div class="lan-peer-desc">${escapeHtml(peer.platform || '')}${
            peer.version ? ` · ${escapeHtml(peer.version)}` : ''
          } · ${escapeHtml(`${peer.address}:${peer.port}`)}</div>
        </div>
        <div class="lan-peer-actions">
          <button class="btn small" data-act="pull">拉取配置</button>
          <button class="btn small primary" data-act="push">发送配置</button>
        </div>`;
      const peerLabel = peer.name || `${peer.address}:${peer.port}`;
      row.querySelector('[data-act="pull"]').addEventListener('click', async () => {
        showLanState(`正在从「${peerLabel}」拉取配置…`);
        try {
          const payload = await api.lanSyncPull(peer.address, peer.port);
          if (!payload) throw new Error('浏览器演示模式没有局域网服务');
          const bundle = JSON.parse(payload);
          const ok = await confirmDialog({
            title: '拉取对方的配置',
            text: `「${peerLabel}」的${describeBundleContents(bundle)}会合并进本机：同名条目以对方为准，本机独有的保留（设置整段按对方覆盖）。`,
            okLabel: '覆盖本机',
            danger: true,
          });
          if (!ok) {
            showLanState('已取消，本机数据没有改动');
            return;
          }
          const summary = await applyImport(bundle);
          setSetting('sync.lastSyncAt', Date.now());
          showLanState(`已从「${peerLabel}」同步：${describeImport(summary)}，正在重新载入…`, 'success');
          setTimeout(() => location.reload(), 900);
        } catch (error) {
          showLanState(`拉取失败：${String(error?.message || error)}`, 'error');
        }
      });
      row.querySelector('[data-act="push"]').addEventListener('click', async () => {
        const outgoing = buildBundle();
        const ok = await confirmDialog({
          title: '发送配置给对端',
          text: `本机的${describeBundleContents(outgoing)}会覆盖「${peerLabel}」上的同名数据，对方那边无法撤销。`,
          okLabel: '发送',
        });
        if (!ok) return;
        showLanState(`正在发送给「${peerLabel}」…`);
        try {
          const size = await api.lanSyncPush(peer.address, peer.port, JSON.stringify(outgoing));
          setSetting('sync.lastSyncAt', Date.now());
          showLanState(`已发送，对端收到 ${formatBytes(size?.bytes)}`, 'success');
        } catch (error) {
          showLanState(`发送失败：${String(error?.message || error)}`, 'error');
        }
      });
      lanPeers.appendChild(row);
    }
  };

  // 本机地址要在「一个设备都没发现」时也显示——那正是对方需要手填地址的场景。
  const renderSelf = (status) => {
    if (!status?.running) {
      lanSelf.innerHTML = '';
      return;
    }
    const addresses = status.addresses?.length
      ? status.addresses.map((ip) => `${ip}:${status.http_port}`).join(' 或 ')
      : '（没拿到局域网地址）';
    lanSelf.innerHTML = `<div class="lan-self-line">${icon('wifi', 14)} 本机：${escapeHtml(
      status.device?.name || '未知设备'
    )} · ${escapeHtml(addresses)}</div>`;
  };

  const tick = async () => {
    try {
      const status = await api.lanSyncStatus();
      if (!status) {
        lanSelf.innerHTML = '';
        lanPeers.innerHTML = `<div class="lan-empty">浏览器预览模式没有局域网服务，请在应用内使用。</div>`;
        return;
      }
      if (!status.running) {
        lanPeers.innerHTML = `<div class="lan-empty">${
          status.error ? escapeHtml(status.error) : '同步服务未启动'
        }</div>`;
        lanSelf.innerHTML = '';
        return;
      }
      // 每 15 秒把最新的一份数据交给后端，别人来拉时拿到的是当下的状态。
      if (Date.now() - lastPublish > 15000) await publish();
      const peers = (await api.lanSyncPeers()) || [];
      renderSelf(status);
      renderPeers(peers);
      if (busy) return;
      const inbox = (await api.lanSyncInbox()) || [];
      if (!inbox.length) return;
      busy = true;
      const item = inbox[inbox.length - 1];
      // 先解包：解析失败要在这里就露出来，别卡在 busy=true 上让轮询再也不继续。
      let incoming;
      try {
        incoming = JSON.parse(item.payload);
      } catch {
        busy = false;
        showLanState('收到的配置包不是合法 JSON，已丢弃', 'error');
        return;
      }
      const ok = await confirmDialog({
        title: '收到配置包',
        text: `「${item.from || item.address}」发来一份配置（${formatBytes(item.bytes)}）：${describeBundleContents(
          incoming
        )}。应用后会覆盖本机同名数据。`,
        okLabel: '应用',
        danger: true,
      });
      busy = false;
      if (!ok) {
        showLanState('已忽略这次收到的配置');
        return;
      }
      try {
        const summary = await applyImport(incoming);
        setSetting('sync.lastSyncAt', Date.now());
        showLanState(`已应用对端配置：${describeImport(summary)}，正在重新载入…`, 'success');
        setTimeout(() => location.reload(), 900);
      } catch (error) {
        showLanState(`应用失败：${String(error?.message || error)}`, 'error');
      }
    } catch (error) {
      lanPeers.innerHTML = `<div class="lan-empty">${escapeHtml(String(error?.message || error))}</div>`;
    }
  };

  lan.querySelector('#lan-connect').addEventListener('click', async () => {
    const raw = lan.querySelector('#lan-address').value.trim();
    if (!raw) return;
    const [address, portText] = raw.replace(/^https?:\/\//, '').split(':');
    const port = Number(portText) || 23244;
    showLanState(`正在连接 ${address}:${port}…`);
    try {
      const peer = await api.lanSyncProbe(address, port);
      if (!peer) throw new Error('浏览器演示模式没有局域网服务');
      showLanState(`已找到「${peer.name || address}」，它下面的按钮可以直接拉取或发送`, 'success');
      await tick();
    } catch (error) {
      showLanState(`连不上 ${address}:${port}：${String(error?.message || error)}`, 'error');
    }
  });

  // 启动服务（已在跑就只返回状态），然后开始轮询。离开页面时由 dispose 清掉定时器。
  (async () => {
    await api.lanSyncStart().catch((error) => showLanState(String(error?.message || error), 'error'));
    await tick();
    if (!syncPollTimer) syncPollTimer = setInterval(tick, 2000);
  })();


  // ④ 从 dart_simple_live 导入 profile JSON；节点在 WebDAV 之后插入。
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

  const report = migrate.querySelector('#import-report');

  migrate.querySelector('#sync-dart').addEventListener('click', () => pickJsonFile(runImport));

  async function runImport(file) {
    try {
      const summary = await applyImport(JSON.parse(await file.text()));
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

  // ⑤ WebDAV 同步：整包上传/下载，不做字段级合并。
  const config = state.settings.sync.webdav;
  const sync = document.createElement('div');
  sync.className = 'tool-card';
  sync.innerHTML = `
    <h3>WebDAV 同步</h3>
    <p>把整份同步包（内容见本节末尾的清单）传到自己的 WebDAV（群晖、坚果云、Nextcloud 等），
       多台机器共用同一份数据；跨网络也能用。</p>
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
    // 先下载再确认，确认框列出包内实际内容。
    showState('正在读取云端文件…');
    try {
      const payload = await api.webdavDownload(target(), cfg.username, cfg.password, cfg.insecureTls);
      const incoming = JSON.parse(payload.content);
      const ok = await confirmDialog({
        title: '下载覆盖本机',
        text: `云端的${describeBundleContents(incoming)}会合并进本机：同名条目以对方为准，本机独有的保留（设置整段按对方覆盖）。`,
        okLabel: '覆盖',
        danger: true,
      });
      if (!ok) {
        showState('已取消，本机数据没有改动');
        return;
      }
      const summary = await applyImport(incoming);
      setSetting('sync.lastSyncAt', Date.now());
      showState(`已从云端同步：${describeImport(summary)}，正在重新载入…`);
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      showState(String(error), 'error');
    }
  });

  const tip = document.createElement('div');
  tip.className = 'pill-note';
  tip.style.marginTop = '14px';
  tip.innerHTML = `${icon('info', 16)}<div>账号密码以明文存在本机设置里，别在公用电脑上保存。
    冲突处理只有「整包覆盖」，不做字段级合并；自动拉取只在云端比本机新时才应用。</div>`;
  sync.appendChild(tip);

  const syncScope = document.createElement('div');
  syncScope.style.marginTop = '10px';
  syncScope.innerHTML = bundleScopeNote();
  sync.appendChild(syncScope);

  // 迁移卡片最后插入（节点在上面就建好了，这里只决定顺序）。
  content.appendChild(migrate);
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
  // 0 条的项不列：关了「同步观看记录」时还写「观看记录 0 条」会让人以为被清空了。
  const parts = [];
  if (summary.follows) parts.push(`关注 ${summary.follows} 个`);
  if (summary.history) parts.push(`观看记录 ${summary.history} 条`);
  if (summary.search) parts.push(`搜索历史 ${summary.search} 条`);
  if (summary.stats) parts.push(`观看统计 ${summary.stats} 个主播`);
  if (summary.settings) parts.push(`设置 ${summary.settings} 项`);
  if (summary.accounts?.length) parts.push(`登录 ${summary.accounts.length} 个平台`);
  const skipped = Object.entries(summary.skipped || {});
  if (skipped.length) {
    parts.push(`跳过 ${skipped.map(([platform, count]) => `${PLATFORM_META[platform]?.name || platform} ${count} 条`).join('、')}（尚未支持该平台）`);
  }
  if (summary.truncated) parts.push(`超出上限丢弃 ${summary.truncated} 条`);
  return `导入完成：${parts.length ? parts.join('，') : '没有可导入的内容'}`;
}

/// 同步包内容摘要，用于覆盖确认弹窗。
function describeBundleContents(bundle) {
  const parts = [];
  if (bundle.follow?.length) parts.push(`关注 ${bundle.follow.length} 个`);
  if (bundle.history?.length) parts.push(`观看记录 ${bundle.history.length} 条`);
  if (bundle.search?.length) parts.push(`搜索历史 ${bundle.search.length} 条`);
  const rooms = bundle.stats?.rooms ? Object.keys(bundle.stats.rooms).length : 0;
  if (rooms) parts.push(`观看统计 ${rooms} 个主播`);
  const accounts = bundle.accounts ? Object.keys(bundle.accounts).length : 0;
  if (accounts) parts.push(`登录信息 ${accounts} 个平台`);
  if (bundle.settings) parts.push('设置一整份');
  if (!parts.length) return '（空包）';
  return parts.join('、');
}

/// 导入数据并把 Cookie 注回后端；文件导入、WebDAV、局域网三条路共用。
async function applyImport(data) {
  const summary = importData(data);
  for (const platform of summary.accounts || []) {
    const login = loadLogin(platform);
    if (login?.cookie) await api.setCookie(platform, login.cookie).catch(() => {});
  }
  return summary;
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
    <h2>Starveil</h2>
    <p>聚合直播客户端 · Tauri 2 + ${IS_MOBILE ? 'WebView' : 'WebView2'}</p>
    <span class="about-version" id="about-version">${FALLBACK_VERSION}</span>
    <div class="settings-group" style="margin-top:22px;text-align:left">
      <div class="setting-row"><div class="setting-info"><div class="setting-title">协议层</div><div class="setting-desc">哔哩哔哩 / 斗鱼 / 虎牙（Rust live_core）</div></div></div>
      <div class="setting-row"><div class="setting-info"><div class="setting-title">播放</div><div class="setting-desc">mpegts.js · FLV over MSE</div></div></div>
      <div class="setting-row"><div class="setting-info"><div class="setting-title">界面</div><div class="setting-desc">HTML / CSS / ES Modules，无前端框架</div></div></div>
      <div class="setting-row"><div class="setting-info"><div class="setting-title">致敬</div><div class="setting-desc">界面与交互参考 dart_simple_live（xiaoyaocz）</div></div></div>
    </div>`;
  content.appendChild(card);
  // 连点版本号 7 次解锁「发送弹幕」（见 docs/hidden-features.md）。
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

  // 免责声明、运行日志、重置设置都属于「应用」层面的杂项，收在这里。
  const disclaimer = document.createElement('div');
  disclaimer.className = 'settings-action-card';
  disclaimer.innerHTML = `
    <div class="action-icon">${icon('shield', 20)}</div>
    <div class="action-text"><h4>免责声明</h4><p>数据来源、使用范围与责任边界</p></div>
    <button class="btn small">查看</button>`;
  disclaimer.querySelector('button').addEventListener('click', () => ctx.go('settingsDetail', { key: 'disclaimer' }));
  content.appendChild(disclaimer);

  const logs = document.createElement('div');
  logs.className = 'settings-action-card';
  logs.innerHTML = `
    <div class="action-icon">${icon('info', 20)}</div>
    <div class="action-text"><h4>${IS_MOBILE ? '分享日志文件' : '运行日志'}</h4><p>${IS_MOBILE ? '通过系统分享发出去，便于反馈播放问题' : '打开运行日志所在的文件夹'}</p></div>
    <button class="btn small">${IS_MOBILE ? '分享' : '打开'}</button>`;
  logs.querySelector('button').addEventListener('click', async () => {
    try {
      const path = await api.openLogDir();
      if (!IS_MOBILE) toast(`已打开：${path}`, 'success');
    } catch (error) {
      toast(String(error), 'error');
    }
  });
  content.appendChild(logs);

  const reset = document.createElement('div');
  reset.className = 'settings-action-card';
  reset.innerHTML = `
    <div class="action-icon">${icon('refresh', 20)}</div>
    <div class="action-text"><h4>重置所有设置</h4><p>恢复默认外观、播放、弹幕等选项；不会删除关注和观看记录</p></div>
    <button class="btn small danger">重置</button>`;
  reset.querySelector('button').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: '重置设置', text: '所有设置将恢复默认值，确定继续吗？', okLabel: '重置', danger: true });
    if (!ok) return;
    resetSettings();
    // GPU 模式存在数据目录里，重置设置时一并回到自动。
    if (!IS_MOBILE) api.setGpuMode('auto').catch(() => {});
    applyTheme();
    toast('已恢复默认设置', 'success');
    ctx.go('settings');
  });
  content.appendChild(reset);
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
    <p>Starveil 本身以 GPL-3.0 发布。下面列出的是本项目依赖或移植的上游项目，
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
