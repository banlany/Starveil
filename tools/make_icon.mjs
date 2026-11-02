// 把 src-tauri/icons/starveil-icon.svg 渲染成各尺寸 PNG。
//
// 为什么用 Chrome 而不是 ImageMagick / cairosvg：这台机器两样都没装
// （原来的 tools/make_icon.py 依赖 PIL，现在也跑不起来）。Chrome 本来就要
// 用无头模式做界面自检，顺路当渲染器，输出质量和矢量一致性都够。
//
// 用法：
//   node tools/make_icon.mjs             # 1024 源图 + 各平台图标 + 逐档渲染的 icon.ico
//   node tools/make_icon.mjs --only-logo # 只更新 web/assets/logo.png
//
// 需要本机有 cargo：脚本会调 `cargo tauri icon` 生成 icns 与各尺寸 png，
// 再用自己逐档渲染的 ico 覆盖它生成的那份（tauri 的 ico 是把大图缩下来的）。
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(root, 'src-tauri', 'icons', 'starveil-icon.svg');
const ICON_OUT = path.join(root, 'src-tauri', 'icons', 'icon.png');
const ICO_OUT = path.join(root, 'src-tauri', 'icons', 'icon.ico');
const LOGO_OUT = path.join(root, 'web', 'assets', 'logo.png');
const TMP_HTML = path.join(root, '.tmp', 'icon-render.html');

const onlyLogo = process.argv.includes('--only-logo');

const svg = await readFile(SVG, 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
</head><body>${svg.replace(/\swidth="\d+"\s+height="\d+"/, '')}</body></html>`;
await writeFile(TMP_HTML, html);

const CDP = 9452;
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    `--remote-debugging-port=${CDP}`, '--user-data-dir=C:/Windows/Temp/dbg-make-icon', 'about:blank'],
  { stdio: 'ignore' }
);
await sleep(2200);

const pages = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
};
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});

// 圆角外面必须是透明的，否则 ico/png 的四角会被填成白块。
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

async function render(size, out) {
  const data = await renderBuffer(size);
  if (out) {
    await writeFile(out, data);
    console.log(`${size}×${size} -> ${path.relative(root, out)}`);
  }
  return data;
}

// 每个尺寸都让浏览器从 SVG 重新光栅化，而不是把 1024 缩下来：
// Windows 的 16/24px 图标全靠这一档，缩放出来的会比原生渲染糊一圈。
async function renderBuffer(size) {
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  // 内联 SVG 的视口是 1024，用 CSS 缩放比改 width/height 属性更省事。
  await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('svg');
      el.style.width = '${size}px';
      el.style.height = '${size}px';
    })()`,
  });
  const res = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  return Buffer.from(res.result.data, 'base64');
}

// ICO 容器。Windows 只认位图，没有矢量格式；这里把每一档都放进容器里，
// 系统按实际显示尺寸挑最接近的一张（任务栏 16/24、开始菜单 32/48、大图标 256）。
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

async function buildIco(out) {
  const images = [];
  for (const size of ICO_SIZES) images.push({ size, data: await renderBuffer(size) });

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    // 256 在这里写 0（单字节放不下）
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // 调色板数
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  await writeFile(out, Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]));
  console.log(`${ICO_SIZES.join('/')} -> ${path.relative(root, out)}（${images.length} 档，逐档渲染）`);
}

// 安卓启动图标。`cargo tauri icon` 只在 icons/ 下留一套 10/29 的旧图，
// `gen/android/.../res` 它更是从来不碰（只有 `android init` 会拷），
// 所以两处都在这儿按实际显示尺寸重渲染。
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

async function buildAndroid() {
  const bases = [
    path.join(root, 'src-tauri', 'icons', 'android'),
    path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res'),
  ];
  for (const [density, launch, fg] of DENSITIES) {
    for (const base of bases) {
      // gen/android 只有做过 android init 的机器上才有，缺席时跳过
      if (!existsSync(base)) continue;
      const dir = path.join(base, `mipmap-${density}`);
      await mkdir(dir, { recursive: true });
      await render(launch, path.join(dir, 'ic_launcher.png'));
      await render(launch, path.join(dir, 'ic_launcher_round.png'));
      await render(fg, path.join(dir, 'ic_launcher_foreground.png'));
    }
  }
  console.log('安卓 mipmap：五档 × launcher/round/foreground 已更新');
}

await send('Page.navigate', { url: `file:///${TMP_HTML.replace(/\\/g, '/')}` });
await sleep(900);

if (!onlyLogo) {
  await render(1024, ICON_OUT);
  // tauri 的 icon 命令顺带生成 icns 与各尺寸 png，但它自己打的 ico 是从 1024 缩下来的，
  // 所以先让它跑完，再用逐档渲染的 ico 覆盖回去，最后补安卓 mipmap。
  const tauri = spawnSync('cargo', ['tauri', 'icon', ICON_OUT], { cwd: root, stdio: 'inherit', shell: true });
  if (tauri.status !== 0) console.warn('cargo tauri icon 失败，icon.ico 只包含逐档渲染的位图');
  await buildIco(ICO_OUT);
  await buildAndroid();
}
await render(256, LOGO_OUT);

ws.close();
chrome.kill();
await unlink(TMP_HTML).catch(() => {});
console.log('done');
