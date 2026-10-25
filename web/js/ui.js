// 通用 UI：卡片、提示、弹窗、空态、骨架屏。
import { canonicalImage, coverImage, formatOnline } from './api.js';
import { icon, PLATFORM_META, platformIcon } from './icons.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function on(target, event, handler, options) {
  target?.addEventListener(event, handler, options);
}

export function debounce(fn, wait = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = 0;
  return (...args) => {
    const now = Date.now();
    const left = wait - (now - last);
    if (left <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn(...args);
      }, left);
    }
  };
}

export function platformBadge(platform, withName = false) {
  const meta = PLATFORM_META[platform] || PLATFORM_META.bilibili;
  return `<span class="platform-badge" title="${escapeHtml(meta.name)}">${platformIcon(platform, 18)}${withName ? `<span>${escapeHtml(meta.name)}</span>` : ''}</span>`;
}

export function avatarHtml(name, image, size = 22, className = '') {
  const label = escapeHtml((name || '?').trim().slice(0, 1));
  const src = canonicalImage(image);
  if (src) {
    return `<span class="avatar ${className}" style="width:${size}px;height:${size}px;font-size:${Math.max(10, size * 0.42)}px"><img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="avatar-fallback">${label}</span></span>`;
  }
  return `<span class="avatar avatar-text ${className}" style="width:${size}px;height:${size}px;font-size:${Math.max(10, size * 0.42)}px;--avatar-hue:${hashHue(name)}">${label}</span>`;
}

function hashHue(value) {
  let hash = 0;
  for (const char of String(value || '?')) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function bindImageFallback(root = document) {
  for (const img of $$('img[data-fallback], .avatar img', root)) {
    if (img.dataset.bound) continue;
    img.dataset.bound = '1';
    img.addEventListener('error', () => {
      img.classList.add('is-broken');
      img.closest('.cover')?.classList.add('cover-broken');
      img.removeAttribute('src');
    }, { once: true });
    if (img.complete && img.naturalWidth === 0) {
      img.classList.add('is-broken');
      img.closest('.cover')?.classList.add('cover-broken');
    }
  }
}

export function roomCard(room, options = {}) {
  const card = document.createElement('article');
  card.className = 'room-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'link');
  const platform = room.platform || options.platform || 'bilibili';
  const cover = coverImage(room.cover, platform);
  const title = room.title || '未命名直播间';
  card.innerHTML = `
    <div class="cover${cover ? '' : ' cover-broken'}">
      ${cover ? `<img class="cover-img" src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback />` : ''}
      <div class="cover-fallback"><span>${escapeHtml(title.slice(0, 18))}</span></div>
      <div class="cover-top">
        <span class="live-badge" title="${room.live === false ? '未开播' : '直播中'}">${platformIcon(platform, 17)}</span>
        ${options.favorite ? `<button class="cover-fav${options.favorite(room) ? ' active' : ''}" title="收藏">${icon('heart', 15)}</button>` : ''}
      </div>
    </div>
    <h3 class="room-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
    <div class="room-meta">
      ${avatarHtml(room.user_name, room.avatar, 18, 'avatar-mini')}
      <span class="room-user">${escapeHtml(room.user_name || '未知主播')}</span>
      <span class="room-online">${icon('flame', 12)}${formatOnline(room.online)}</span>
    </div>`;
  bindImageFallback(card);
  const open = () => options.onOpen?.(room);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  if (options.favorite) {
    card.querySelector('.cover-fav')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const button = event.currentTarget;
      const result = options.favoriteToggle?.(room);
      if (typeof result === 'boolean') button.classList.toggle('active', result);
    });
  }
  return card;
}

export function roomGrid(rooms, options = {}) {
  const grid = document.createElement('div');
  grid.className = `room-grid ${options.className || ''}`.trim();
  for (const room of rooms) grid.appendChild(roomCard(room, options));
  return grid;
}

export function skeletonGrid(count = 12) {
  const grid = document.createElement('div');
  grid.className = 'room-grid';
  for (let index = 0; index < count; index += 1) {
    const card = document.createElement('div');
    card.className = 'room-card skeleton-card';
    card.innerHTML = `
      <div class="cover skeleton"></div>
      <div class="skeleton skeleton-line" style="width:88%"></div>
      <div class="skeleton skeleton-line" style="width:52%;height:12px"></div>`;
    grid.appendChild(card);
  }
  return grid;
}

export function emptyState({ iconName = 'spark', title, text, actionLabel, onAction, compact = false }) {
  const box = document.createElement('div');
  box.className = `empty-state${compact ? ' compact' : ''}`;
  box.innerHTML = `
    <div class="empty-icon">${icon(iconName, compact ? 26 : 38)}</div>
    <h3>${escapeHtml(title)}</h3>
    ${text ? `<p>${escapeHtml(text)}</p>` : ''}
    ${actionLabel ? `<button class="btn primary empty-action">${escapeHtml(actionLabel)}</button>` : ''}`;
  box.querySelector('.empty-action')?.addEventListener('click', onAction);
  return box;
}

export function sectionHeader(title, extra = '') {
  const row = document.createElement('div');
  row.className = 'section-header';
  row.innerHTML = `<h2>${escapeHtml(title)}</h2><div class="section-extra">${extra}</div>`;
  return row;
}

export function toast(message, type = 'info', duration = 2400) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.innerHTML = `${icon(type === 'error' ? 'info' : type === 'success' ? 'check' : 'spark', 16)}<span>${escapeHtml(message)}</span>`;
  root.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 220);
  }, duration);
}

function portalRoot() {
  const fullscreen = document.fullscreenElement;
  if (fullscreen && fullscreen !== document.documentElement) return fullscreen;
  return document.getElementById('overlay-root');
}

export function openModal({ title = '', subtitle = '', body, actions = [], width = 460, className = '', onClose }) {
  const root = portalRoot();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const panel = document.createElement('div');
  panel.className = `modal ${className}`.trim();
  panel.style.maxWidth = `${width}px`;
  panel.innerHTML = `
    <div class="modal-head">
      <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
      <button class="icon-btn modal-close" aria-label="关闭">${icon('close', 18)}</button>
    </div>
    <div class="modal-body"></div>
    <div class="modal-actions"></div>`;
  const bodyNode = panel.querySelector('.modal-body');
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body) bodyNode.appendChild(body);
  const actionNode = panel.querySelector('.modal-actions');
  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 160);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  for (const action of actions) {
    const button = document.createElement('button');
    button.className = `btn ${action.kind || 'ghost'}`;
    button.textContent = action.label;
    button.addEventListener('click', () => {
      if (action.onClick) {
        const result = action.onClick(close);
        if (result === false) return;
      }
      if (action.close !== false) close();
    });
    actionNode.appendChild(button);
  }
  panel.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  overlay.appendChild(panel);
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  return { close, panel };
}

export function confirmDialog({ title = '确认', text = '', okLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      width: 400,
      body: `<p class="modal-text">${escapeHtml(text)}</p>`,
      actions: [
        { label: cancelLabel, kind: 'ghost', onClick: () => resolve(false) },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

export function promptDialog({ title = '输入', text = '', placeholder = '', value = '', okLabel = '确定' } = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const body = document.createElement('div');
    body.innerHTML = `${text ? `<p class="modal-text">${escapeHtml(text)}</p>` : ''}<input class="input modal-input" type="text" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" />`;
    const modal = openModal({
      title,
      width: 420,
      body,
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => { resolved = true; resolve(null); } },
        {
          label: okLabel,
          kind: 'primary',
          onClick: () => {
            resolved = true;
            resolve(body.querySelector('input').value.trim());
          },
        },
      ],
      onClose: () => {
        if (!resolved) resolve(null);
      },
    });
    const input = body.querySelector('input');
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        modal.panel.querySelector('.modal-actions .primary')?.click();
      }
    });
  });
}

export function openMenu(anchor, items, { align = 'end', placement = 'bottom', gap = 6 } = {}) {
  const rect = anchor.getBoundingClientRect();
  const root = portalRoot();
  const overlay = document.createElement('div');
  overlay.className = 'menu-overlay';
  const menu = document.createElement('div');
  menu.className = `menu ${align === 'start' ? 'align-start' : ''}`;
  if (placement === 'top') {
    menu.style.bottom = `${Math.max(12, window.innerHeight - rect.top + gap)}px`;
  } else {
    menu.style.top = `${Math.min(rect.bottom + gap, window.innerHeight - 40)}px`;
  }
  if (align === 'start') {
    // 左对齐菜单，避免窄按钮的菜单向左溢出容器/窗口。
    menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 190))}px`;
  } else {
    menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  }
  for (const item of items) {
    if (item.separator) {
      menu.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>');
      continue;
    }
    const button = document.createElement('button');
    button.className = `menu-item${item.active ? ' active' : ''}`;
    button.innerHTML = `${item.icon ? icon(item.icon, 17) : ''}<span>${escapeHtml(item.label)}</span>${item.value ? `<em>${escapeHtml(item.value)}</em>` : item.active ? icon('check', 16) : ''}`;
    button.addEventListener('click', () => {
      close();
      item.onClick?.();
    });
    menu.appendChild(button);
  }
  const close = () => {
    overlay.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey);
  };
  const outside = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  overlay.appendChild(menu);
  root.appendChild(overlay);
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey);
  }, 0);
  return close;
}

export async function saveJsonFile(filename, payload) {
  const text = JSON.stringify(payload, null, 2);
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON 备份', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      // 某些 WebView 不允许 File System Access，回退到下载。
    }
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

export function spinner(label = '加载中…') {
  const box = document.createElement('div');
  box.className = 'loading-block';
  box.innerHTML = `<span class="spinner"></span><span>${escapeHtml(label)}</span>`;
  return box;
}

export function loadMore(text = '加载更多') {
  const box = document.createElement('button');
  box.className = 'load-more';
  box.innerHTML = `<span>${escapeHtml(text)}</span>`;
  return box;
}

export function setPageChrome({ rail = true, topbar = false, search = false, className = '' }) {
  document.getElementById('rail').classList.toggle('is-hidden', !rail);
  document.getElementById('topbar').classList.toggle('is-hidden', !topbar);
  document.getElementById('topbar-search').classList.toggle('is-hidden', !search);
  const view = document.getElementById('view');
  view.className = `view ${className}`.trim();
}

export function autoHideOnScroll(header, threshold = 8) {
  let last = window.scrollY;
  const onScroll = () => {
    const current = window.scrollY;
    header.classList.toggle('is-scrolled', current > threshold);
    last = current;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => window.removeEventListener('scroll', onScroll);
}
