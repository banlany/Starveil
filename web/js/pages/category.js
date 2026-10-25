// 分类：一级分区纵向排列，二级分类图标网格。
import { api, categoryImage } from '../api.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { emptyState, skeletonGrid, toast } from '../ui.js';

const COLLAPSED_COUNT = 15;

export function renderCategory(ctx) {
  const page = document.createElement('section');
  page.className = 'category-page';
  page.innerHTML = '<div id="category-body"></div>';
  const body = page.querySelector('#category-body');

  async function load() {
    state.category.loading = true;
    state.category.error = '';
    body.replaceChildren(skeletonLines());
    const platform = state.platform;
    try {
      const tree = await api.categories(platform);
      if (platform !== state.platform || ctx.route() !== 'category') return;
      state.category.tree = tree;
      state.category.loading = false;
      renderTree();
    } catch (error) {
      state.category.loading = false;
      state.category.error = String(error);
      body.replaceChildren(
        emptyState({
          iconName: 'grid',
          title: '分类加载失败',
          text: String(error),
          actionLabel: '重新加载',
          onAction: load,
        })
      );
    }
  }

  function renderTree() {
    body.innerHTML = '';
    if (!state.category.tree.length) {
      body.appendChild(emptyState({ iconName: 'grid', title: '这个平台暂时没有分类', text: '试试切换其他平台。' }));
      return;
    }
    for (const [index, parent] of state.category.tree.entries()) {
      const expanded = Boolean(state.category.expanded[parent.id]);
      const section = document.createElement('section');
      section.className = 'category-section';
      const title = document.createElement('h2');
      title.className = 'category-title';
      title.textContent = parent.name;
      section.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'category-grid';
      const children = parent.children || [];
      const visible = expanded ? children : children.slice(0, COLLAPSED_COUNT);
      for (const child of visible) {
        const item = document.createElement('button');
        item.className = 'category-item';
        const pic = categoryImage(child.pic);
        const initial = (child.name || '?').slice(0, 1);
        item.innerHTML = `
          <span class="category-icon">${pic ? `<img src="${pic}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : initial}</span>
          <span class="category-name">${child.name}</span>`;
        const image = item.querySelector('.category-icon img');
        if (image) {
          image.addEventListener('error', () => {
            image.remove();
            item.querySelector('.category-icon').textContent = initial;
          }, { once: true });
        }
        item.title = child.name;
        item.addEventListener('click', () => {
          ctx.openCategoryRooms({
            platform: state.platform,
            parentId: child.parent_id || parent.id,
            subId: child.id,
            name: child.name,
          });
        });
        grid.appendChild(item);
      }
      if (children.length > COLLAPSED_COUNT) {
        const more = document.createElement('button');
        more.className = 'category-more';
        more.textContent = expanded ? '收起' : '显示全部';
        more.addEventListener('click', () => {
          state.category.expanded[parent.id] = !expanded;
          renderTree();
          if (!expanded) {
            // 展开后把这一节滚到可见区域
            setTimeout(() => title.scrollIntoView({ block: 'start', behavior: 'smooth' }), 20);
          }
        });
        grid.appendChild(more);
      }
      section.appendChild(grid);
      body.appendChild(section);
    }
  }

  document.getElementById('view').appendChild(page);
  if (state.category.tree.length) {
    state.category.loading = false;
    renderTree();
  } else {
    load();
  }

  const onScroll = () => {
    const view = document.getElementById('view');
    if (!view.dataset.categoryHint && view.scrollTop > 0) {
      view.dataset.categoryHint = '1';
    }
  };
  return () => {};
}

function skeletonLines() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="skeleton skeleton-line" style="width:120px;height:24px;margin:24px 0 22px"></div>
    <div class="category-grid">${Array.from({ length: 14 }, () => '<div class="category-item"><div class="category-icon skeleton"></div><div class="skeleton skeleton-line" style="width:56px;height:10px;margin-top:2px"></div></div>').join('')}</div>
    <div class="skeleton skeleton-line" style="width:100px;height:22px;margin:42px 0 20px"></div>
    <div class="category-grid">${Array.from({ length: 14 }, () => '<div class="category-item"><div class="category-icon skeleton"></div><div class="skeleton skeleton-line" style="width:56px;height:10px;margin-top:2px"></div></div>').join('')}</div>`;
  return wrap;
}
