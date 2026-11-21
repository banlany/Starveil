// 分类：一级分区纵向排列，二级分类图标网格。
import { api, categoryImage } from '../api.js';
import { icon } from '../icons.js';
import { categorySlot } from '../store.js';
import { emptyState, escapeHtml, skeletonCategoryLines, toast } from '../ui.js';
import { scrollBehavior } from '../motion.js';

const COLLAPSED_COUNT = 15;

export function renderCategory(ctx) {
  // 页面绑定自己的数据槽：在后台时也能继续收数据，切回来直接是这一份。
  const slot = categorySlot();
  let disposed = false;
  const page = document.createElement('section');
  page.className = 'category-page';
  page.innerHTML = '<div id="category-body"></div>';
  const body = page.querySelector('#category-body');

  async function load() {
    slot.loading = true;
    slot.error = '';
    body.replaceChildren(skeletonCategoryLines());
    const platform = slot.platform;
    try {
      const tree = await api.categories(platform);
      if (disposed) return;
      slot.tree = tree;
      renderTree();
    } catch (error) {
      slot.error = String(error);
      body.replaceChildren(
        emptyState({
          iconName: 'category',
          title: '分类加载失败',
          text: String(error),
          actionLabel: '重新加载',
          onAction: load,
        })
      );
    } finally {
      // 提前返回时也要复位该标志。
      slot.loading = false;
    }
  }

  function renderTree() {
    body.innerHTML = '';
    if (!slot.tree.length) {
      body.appendChild(emptyState({ iconName: 'category', title: '这个平台暂时没有分类', text: '试试切换其他平台。' }));
      return;
    }
    for (const [index, parent] of slot.tree.entries()) {
      const expanded = Boolean(slot.expanded[parent.id]);
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
        // 分类名与图标地址来自接口，拼进 innerHTML 前必须转义。
        item.innerHTML = `
          <span class="category-icon">${pic ? `<img src="${escapeHtml(pic)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : escapeHtml(initial)}</span>
          <span class="category-name">${escapeHtml(child.name)}</span>`;
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
            platform: slot.platform,
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
          slot.expanded[parent.id] = !expanded;
          renderTree();
          if (!expanded) {
            // 展开后把这一节滚到可见区域
            setTimeout(() => title.scrollIntoView({ block: 'start', behavior: scrollBehavior() }), 20);
          }
        });
        grid.appendChild(more);
      }
      section.appendChild(grid);
      body.appendChild(section);
    }
  }

  document.getElementById('view').appendChild(page);
  if (slot.tree.length) {
    slot.loading = false;
    renderTree();
  } else {
    load();
  }

  // 分类页没有滚动联动逻辑，只标记自己被淘汰，回包不再写进来。
  return () => {
    disposed = true;
  };
}
