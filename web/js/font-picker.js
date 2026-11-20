// 字体选择浮层：搜索框 + 按字体自身字形渲染的列表。
// 设置页的界面字体、弹幕字体，以及直播间弹幕面板共用；字体清单来自后端 `list_fonts`。
import { listFonts } from './api.js';
import { icon } from './icons.js';

/// 字体名 → 显示名；清单里没有时原样返回，空值给 `fallback`。
export async function fontLabelOf(name, fallback = '跟随默认') {
  const key = String(name || '').trim();
  if (!key) return fallback;
  const fonts = await listFonts();
  return fonts.find((font) => font.name === key)?.label || key;
}

/// 打开字体选择浮层。`current` 为空串表示「跟随」，显示为 `followLabel`。
export function openFontPicker({ current = '', followLabel = '跟随默认', onPick } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'font-picker-overlay';
  overlay.innerHTML = `
    <div class="font-picker" role="dialog" aria-label="选择字体">
      <div class="font-picker-head">
        <span>选择字体</span>
        <button class="icon-btn font-picker-close" title="关闭">${icon('close', 16)}</button>
      </div>
      <label class="font-picker-search">
        ${icon('search', 15)}
        <input class="font-picker-input" type="search" placeholder="搜索字体名" spellcheck="false" autocomplete="off" />
      </label>
      <div class="font-picker-list" role="listbox"></div>
      <p class="font-picker-note">只列出系统已安装的字体；选中后缺字的部分回落到界面字体。</p>
    </div>`;

  const list = overlay.querySelector('.font-picker-list');
  const input = overlay.querySelector('.font-picker-input');
  let fonts = [];
  let loaded = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };

  // 跟随项 + 字体项；按关键字过滤后重建列表。
  const paint = () => {
    const query = input.value.trim().toLowerCase();
    list.innerHTML = '';
    const rows = [];
    if (!query || followLabel.toLowerCase().includes(query)) {
      rows.push({ name: '', label: followLabel });
    }
    for (const font of fonts) {
      if (query && !font.label.toLowerCase().includes(query) && !font.name.toLowerCase().includes(query)) continue;
      rows.push(font);
    }
    if (!rows.length) {
      list.innerHTML = '<div class="font-picker-empty">没有匹配的字体</div>';
      return;
    }
    for (const row of rows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `font-picker-item${row.name === current ? ' active' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(row.name === current));
      // 字体名走样式而不是 HTML，避免名字里的引号破坏标记。
      if (row.name) button.style.fontFamily = `"${row.name}"`;
      const label = document.createElement('span');
      label.className = 'font-picker-name';
      label.textContent = row.label;
      const sample = document.createElement('span');
      sample.className = 'font-picker-sample';
      sample.textContent = row.name ? 'Aa 直播' : '';
      button.append(label, sample);
      if (row.name === current) button.insertAdjacentHTML('beforeend', icon('check', 16));
      button.addEventListener('click', () => {
        close();
        onPick?.(row.name);
      });
      list.appendChild(button);
    }
    // 拿不到清单（非 Windows）时给一句说明，跟随项仍然可点。
    if (loaded && !fonts.length) {
      const note = document.createElement('div');
      note.className = 'font-picker-empty';
      note.textContent = '这个平台读不到系统字体清单';
      list.appendChild(note);
    }
  };

  overlay.querySelector('.font-picker-close').addEventListener('click', close);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  input.addEventListener('input', paint);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    list.querySelector('.font-picker-item')?.click();
  });
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(overlay);
  paint();
  input.focus();

  listFonts().then((result) => {
    if (closed) return;
    fonts = result;
    loaded = true;
    paint();
  });

  return close;
}
