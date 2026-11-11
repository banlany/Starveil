#!/usr/bin/env node
// 皮肤契约检查：组件样式里不许再出现配色/圆角/阴影字面量。
//
// 用法：node tools/check-skin.mjs  [--verbose]
//
// 三件事：
//   1. 组件 CSS（styles/pages/room/mobile）里出现颜色字面量、非零圆角数字、
//      非变量字体就报错；确有必要的行尾写 `/* skin:allow 原因 */` 放行。
//   2. 每个皮肤的 skin.css 必须存在，且定义了自己 id 对应的两块作用域。
//   3. 组件里 `var(--x)` 用到的每个变量都必须有定义（皮肤或运行时注入），
//      拦住拼错变量名这种「看着没事、其实整块样式没生效」的问题。
//
// 只依赖 node 内置模块，接 CI 直接加一步 `node tools/check-skin.mjs`。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const COMPONENT_FILES = ['styles.css', 'pages.css', 'room.css', 'mobile.css'];
const VERBOSE = process.argv.includes('--verbose');

/// 运行时由 JS 写进去、或者由布局文件自己声明的变量，不算皮肤契约的一部分。
const RUNTIME_VARS = new Set([
  // store.js / room.js 直接 setProperty 的
  '--accent',
  '--accent-soft',
  '--sc-bg',
  '--sc-bg-strong',
  '--big-emoji-lines',
  '--avatar-hue',
  '--chat-width',
  // styles.css / mobile.css 里的布局尺寸
  '--rail-width',
  '--topbar-height',
  '--titlebar-height',
  '--safe-top',
  '--safe-bottom',
  '--safe-left',
  '--safe-right',
  '--tab-underline-inset',
  '--mask-solid',
]);

const problems = [];
const notes = [];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/// 逐行扫描，跳过整行注释块（/* ... */ 之间的内容不参与判断）。
function eachLine(source, fn) {
  const lines = source.split('\n');
  let inComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!inComment && trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inComment = true;
      return;
    }
    if (inComment) {
      if (trimmed.includes('*/')) inComment = false;
      return;
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
    fn(line, index + 1);
  });
}

// ---------------------------------------------------------------- 1. 字面量

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const RADIUS_PATTERN = /border-radius:\s*(?!var\()\s*(-?[\d.]+)(px|rem|em)?/;
// 0 或 50% / 100% 这类几何值不是「风格量」，换皮肤也不需要变
const RADIUS_OK = new Set(['0', '50', '100']);
// 图标质感（线宽/端点/拐角）也是皮肤量，写死就等于这套皮肤管不到图标。
const STROKE_PATTERN = /stroke-(?:width|linecap|linejoin|dasharray)\s*:(?!\s*var\()/;

for (const name of COMPONENT_FILES) {
  const file = path.join(WEB, name);
  if (!fs.existsSync(file)) {
    problems.push(`${name}: 文件不存在`);
    continue;
  }
  eachLine(read(file), (line, lineNumber) => {
    if (line.includes('skin:allow')) return;
    const where = `web/${name}:${lineNumber}`;
    if (COLOR_PATTERN.test(line)) {
      problems.push(`${where}  颜色字面量，改用皮肤变量： ${line.trim()}`);
    }
    const radius = line.match(RADIUS_PATTERN);
    if (radius && !RADIUS_OK.has(radius[1]) && radius[1] !== '0') {
      problems.push(`${where}  圆角写死，改用 --radius-* 阶梯： ${line.trim()}`);
    }
    if (/font-family:/.test(line) && !line.includes('var(--font')) {
      problems.push(`${where}  字体写死，改用 --font / --font-display / --font-mono： ${line.trim()}`);
    }
    if (STROKE_PATTERN.test(line)) {
      problems.push(`${where}  图标线宽/端点写死，改用 --icon-stroke / --icon-cap / --icon-join： ${line.trim()}`);
    }
    if (/data-skin=/.test(line)) {
      problems.push(`${where}  组件样式里不许出现 data-skin 选择器，皮肤差异只该由变量体现`);
    }
    if (/data-theme=/.test(line)) {
      problems.push(`${where}  组件样式里不许按 data-theme 覆盖颜色，明暗差异写进皮肤的两块作用域`);
    }
  });
}

// ---------------------------------------------------------------- 1b. 控件几何

// 开关、单选点、色板这几类小控件，「长多宽多高」本身就是风格：
// 方形开关、细长条开关、小圆点单选、大色块，都只差几个尺寸。
// 尺寸写死在组件里，皮肤就只能换个颜色，换不了形状。
const GEOMETRY_SELECTOR = /(^|[\s,>+~])\.(?:switch|radio|swatch|skin-dot)(?![\w-])/;
const GEOMETRY_PROP =
  /^\s*(?:width|height|padding|padding-(?:top|right|bottom|left)|(?:left|top|right|bottom)|border-width)\s*:\s*(-?[\d.]+)(px|rem|em)\s*$/;

for (const name of COMPONENT_FILES) {
  const file = path.join(WEB, name);
  if (!fs.existsSync(file)) continue;
  const source = read(file);
  // 不做完整 CSS 解析：`选择器 { 声明 }` 的扁平匹配已经够用，
  // @media / @keyframes 因为带嵌套会匹配失败一次、再从内层规则重新匹配，正好被跳过。
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    if (!GEOMETRY_SELECTOR.test(selector)) continue;
    const lineAt = source.slice(0, rule.index + rule[1].length).split('\n').length;
    const decls = rule[2].split(';');
    decls.forEach((decl, offset) => {
      if (decl.includes('skin:allow')) return;
      const [prop, value = ''] = decl.split(':');
      if (!GEOMETRY_PROP.test(`${prop}: ${value.trim()}`)) return;
      problems.push(
        `${`web/${name}:${lineAt + offset}`}  控件尺寸写死（${selector}），改用 --switch-* / --radio-* / --swatch-* / --skin-dot-* 变量： ${decl.trim()}`
      );
    });
  }
}

// ---------------------------------------------------------------- 1c. 卡片

// 卡片是「底色 + 一圈描边 + 圆角」三件套。三样都写死的块，皮肤只能换颜色，
// 换不了形态（比如把设置页改成没有卡片的纯列表）。认这三样一起出现，误报很低。
const CARD_TRIPLE = [
  /background:\s*var\(--surface\)\s*;/,
  /border:\s*1px solid var\(--line\)\s*;/,
  /border-radius:\s*var\(--radius\)\s*;/,
];

for (const name of COMPONENT_FILES) {
  const file = path.join(WEB, name);
  if (!fs.existsSync(file)) continue;
  const source = read(file);
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2];
    if (!CARD_TRIPLE.every((pattern) => pattern.test(body))) continue;
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    const lineAt = source.slice(0, rule.index + rule[1].length).split('\n').length;
    problems.push(
      `web/${name}:${lineAt}  卡片样式写死（${selector}），改用 --card-bg / --card-border / --card-radius / --card-shadow`
    );
  }
}

// ---------------------------------------------------------------- 2. 皮肤文件

const registrySource = read(path.join(WEB, 'skins', 'registry.js'));
// 只做最朴素的解析：注册表是手写数据，不是需要跑起来的代码。
const entries = [...registrySource.matchAll(/\{\s*id:\s*'([^']+)'[\s\S]*?modes:\s*\[([^\]]*)\][\s\S]*?\}/g)]
  .map((match) => ({
    id: match[1],
    modes: [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]),
    icons: /icons:\s*true/.test(match[0]),
    // accents 数组是「皮肤提供的主题色」，第一个即默认色
    accent: (match[0].match(/accents:\s*\[[\s\S]*?color:\s*'(#[0-9a-fA-F]{3,8})'/) || [])[1] || '',
  }));

if (!entries.length) problems.push('web/skins/registry.js: 没解析到任何皮肤，检查 SKINS 的字面量格式');
for (const entry of entries) {
  if (!entry.accent) {
    problems.push(`web/skins/registry.js: 皮肤 "${entry.id}" 没有声明 accents（第一项就是默认主题色）`);
  }
}

const definedVars = new Set();

for (const entry of entries) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
    problems.push(`web/skins/registry.js: 皮肤 id "${entry.id}" 只能用小写字母、数字、短横线`);
  }
  if (!entry.modes.length) {
    problems.push(`web/skins/registry.js: 皮肤 "${entry.id}" 没有声明 modes`);
  }
  const file = path.join(WEB, 'skins', entry.id, 'skin.css');
  if (!fs.existsSync(file)) {
    problems.push(`web/skins/${entry.id}/skin.css 不存在（路径约定：skins/<id>/skin.css）`);
    continue;
  }
  const css = read(file);
  const darkScope = `html[data-skin="${entry.id}"]`;
  if (!css.includes(darkScope)) {
    problems.push(`web/skins/${entry.id}/skin.css: 缺少 ${darkScope} 变量块`);
  }
  if (entry.modes.includes('light') && !css.includes(`${darkScope}[data-theme="light"]`)) {
    problems.push(`web/skins/${entry.id}/skin.css: 声明了浅色，但缺少 ${darkScope}[data-theme="light"] 覆盖块`);
  }
  // 首帧用的是 skin.css 里的静态 --accent（JS 还没跑）。它必须等于 registry 里
  // accents 的第一个色，否则每次启动都会先闪一下别的颜色再被覆盖。
  if (entry.accent) {
    const baked = (css.match(/--accent:\s*(#[0-9a-fA-F]{3,8})\s*;/) || [])[1];
    if (!baked) {
      problems.push(`web/skins/${entry.id}/skin.css: 没有声明 --accent，首帧会没有主题色`);
    } else if (baked.toLowerCase() !== entry.accent.toLowerCase()) {
      problems.push(`web/skins/${entry.id}/skin.css: --accent 是 ${baked}，但 registry 里 accents 第一项是 ${entry.accent}（首帧会闪一下别的颜色）`);
    }
  }
  // 标了 icons: true 的皮肤必须真的有图标表，否则运行时只会静默退回基础图标。
  if (entry.icons) {
    const iconFile = path.join(WEB, 'skins', entry.id, 'icons.js');
    if (!fs.existsSync(iconFile)) {
      problems.push(`web/skins/${entry.id}/icons.js 不存在（registry 里这套皮肤标了 icons: true）`);
    } else if (!/ICON_PATHS/.test(read(iconFile))) {
      problems.push(`web/skins/${entry.id}/icons.js: 必须导出 ICON_PATHS（只写要覆盖的图标名）`);
    }
  }
  // 收集所有 skin 里定义过的变量（含浅色块）
  for (const match of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) definedVars.add(match[1]);
  // 皮肤文件只准声明变量
  eachLine(css, (line, lineNumber) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('html[data-skin') || trimmed === '}' || trimmed === '{') return;
    if (trimmed.includes('{')) return;
    if (!/^--[a-zA-Z0-9-]+\s*:|^color-scheme\s*:|^\}/.test(trimmed)) {
      problems.push(`web/skins/${entry.id}/skin.css:${lineNumber}  皮肤文件里只准声明变量： ${trimmed}`);
    }
  });
}

// ---------------------------------------------------------------- 3. 变量闭环

// 组件文件里自己声明的变量也算有定义（布局尺寸那一类）
for (const name of COMPONENT_FILES) {
  const file = path.join(WEB, name);
  if (!fs.existsSync(file)) continue;
  for (const match of read(file).matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*[^;]+;/g)) definedVars.add(match[1]);
}

const usedVars = new Map();
for (const name of COMPONENT_FILES) {
  const file = path.join(WEB, name);
  if (!fs.existsSync(file)) continue;
  eachLine(read(file), (line, lineNumber) => {
    for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!usedVars.has(match[1])) usedVars.set(match[1], `web/${name}:${lineNumber}`);
    }
  });
}

for (const [name, where] of usedVars) {
  if (definedVars.has(name) || RUNTIME_VARS.has(name)) continue;
  problems.push(`${where}  var(${name}) 没有定义：皮肤里补上，或者确实是运行时注入就加进 RUNTIME_VARS`);
}

// ---------------------------------------------------------------- 4. 图标

// 图标的质感必须来自皮肤变量。原来 icon() 把 stroke-width="1.75" 写在标签上，
// 换皮肤最多换颜色，线宽纹丝不动 —— 这条检查就是防止再写回去。
const iconsFile = path.join(WEB, 'js', 'icons.js');
if (fs.existsSync(iconsFile)) {
  const source = read(iconsFile);
  const factory = source.slice(source.indexOf('export function icon('));
  if (/stroke-(?:width|linecap|linejoin)=/.test(factory)) {
    problems.push('web/js/icons.js: icon() 里不许写 stroke-width/linecap/linejoin 属性，交给 .ico 的 --icon-* 变量');
  }
  if (!/OVERRIDES/.test(factory)) {
    problems.push('web/js/icons.js: icon() 没走皮肤覆盖表（OVERRIDES），皮肤将无法替换图形');
  }
  if (!/data-icon=/.test(factory)) {
    problems.push('web/js/icons.js: icon() 输出里少了 data-icon，切皮肤时就地重画图标会失效');
  }
}

// 皮肤的图标表只能覆盖**已经存在**的图标名。
// icon() 是 `OVERRIDES[name] || PATHS[name]`：名字写错不会报错，只会静默回落到
// 基础图形 —— 作者以为自己换了图标，界面上却纹丝不动，查起来极费劲。
const ICON_NAME = /^\s{2}([a-zA-Z][\w]*):/gm;
const baseIconNames = new Set();
if (fs.existsSync(iconsFile)) {
  const source = read(iconsFile);
  const start = source.indexOf('const PATHS = {');
  const end = source.indexOf('\n};', start);
  const block = start >= 0 && end > start ? source.slice(start, end) : '';
  for (const m of block.matchAll(ICON_NAME)) baseIconNames.add(m[1]);
}
if (baseIconNames.size) {
  for (const entry of entries) {
    const skinIcons = path.join(WEB, 'skins', entry.id, 'icons.js');
    if (!fs.existsSync(skinIcons)) continue;
    for (const m of read(skinIcons).matchAll(ICON_NAME)) {
      if (!baseIconNames.has(m[1])) {
        problems.push(`web/skins/${entry.id}/icons.js: "${m[1]}" 不是 js/icons.js 里的图标名（写错名字会静默不生效）`);
      }
    }
  }
}

// 页面骨架里的内联 SVG 同样绕过皮肤：窗口按钮那三个图形原来就写在 index.html，
// 线宽 `stroke-width="1.2"` 跟着一起写死，换皮肤只能改颜色。
const htmlFile = path.join(WEB, 'index.html');
if (fs.existsSync(htmlFile)) {
  eachLine(read(htmlFile), (line, lineNumber) => {
    if (line.includes('skin:allow')) return;
    if (/<svg/.test(line) || /stroke-width=/.test(line)) {
      problems.push(`web/index.html:${lineNumber}  内联图标画在骨架里，皮肤管不到；挪进 js/icons.js 再输出`);
    }
  });
}

// ---------------------------------------------------------------- 输出

if (VERBOSE) {
  console.log(`皮肤 ${entries.length} 套，变量 ${definedVars.size} 个，组件用到 ${usedVars.size} 个`);
  notes.forEach((note) => console.log(`  · ${note}`));
}

if (problems.length) {
  console.error(`\n皮肤解耦检查未通过，${problems.length} 处：\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('\n规则见 docs/skins.md。确有必要保留的字面量，在该行行尾加 `/* skin:allow 原因 */`。\n');
  process.exit(1);
}

console.log(`皮肤解耦检查通过：${entries.length} 套皮肤，${usedVars.size} 个变量全部有定义。`);
