// 整页横滑时从侧边露出的相邻页。只画骨架、不发请求：
// 拖到一半撒手就整块丢掉，提交后由真正的 render 接管，骨架直接换成数据。
import { icon, PLATFORM_META } from './icons.js';
import { escapeHtml, skeletonCategoryLines, skeletonGrid } from './ui.js';

export function buildSwipePeek(route, platform) {
  const page = document.createElement('section');
  if (route === 'category') {
    page.className = 'category-page';
    page.appendChild(skeletonCategoryLines());
    return page;
  }
  page.className = 'home-page';
  const status = document.createElement('div');
  status.className = 'home-status';
  // 状态行与真实页面同构：落位时不会突然多出一行排序。
  status.innerHTML = `<span class="dot-live"><span class="status-label">${escapeHtml(PLATFORM_META[platform]?.name || '')} 热门直播</span></span>` +
    `<span class="home-status-actions"><span class="sort">${icon('flame', 13)}<span>按人气排序</span></span></span>`;
  const body = document.createElement('div');
  body.className = 'page-pad';
  body.appendChild(skeletonGrid(14));
  page.append(status, body);
  return page;
}
