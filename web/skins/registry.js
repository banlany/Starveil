// 皮肤注册表（唯一的皮肤清单）。
//
// 一套皮肤 = `web/skins/<id>/skin.css` + 这里的一条记录。
// skin.css 只声明 CSS 变量（契约见 docs/skins.md），组件样式不许跟着改；
// 新增皮肤时把文件夹丢进去、在这里加一行即可，设置页会自动出现这一项。
//
// 字段说明：
//   id      目录名，同时写进 `<html data-skin="<id>">`；只允许小写字母/数字/短横线
//   name    设置页里显示的名字
//   desc    一句话说明
//   accents 这套皮肤提供的主题色，**第一个就是默认色**。设置页的色板只读这里，
//           别在别处再维护一份；用户自己挑过颜色之后就不再跟随皮肤，
//           换皮肤会回到新皮肤的第一个色。
//   modes   这套皮肤提供的明暗档位。只写一个就等于「锁死明暗」，
//           设置页的深/浅色选项会自动收窄，侧栏的主题按钮也会跳过不可用的档。
//   icons   可选。true 表示这套皮肤自带 `skins/<id>/icons.js`（导出 ICON_PATHS，
//           只写要覆盖的图标名）。不写就沿用 js/icons.js 的基础图形，
//           线宽/端点仍由 skin.css 的 --icon-* 控制。
//   titlebar 可选。'traffic' 表示窗口按钮换成 macOS 的左侧红绿灯，
//           不写就是默认的 Windows 右侧三键；颜色走 skin.css 的 --traffic-*。

export const SKINS = [
  {
    id: 'default',
    name: '星幕',
    // 默认皮肤不绑定某一个品牌色：中性深灰打底，主题色由用户在这一组里挑。
    // 皮肤文件里的 `--accent` 只是首帧的静态兜底，必须和这里第一个色一致；
    // check-skin 会盯着这件事。
    accents: [
      { id: 'mist', name: '雾蓝', color: '#5b8def' },
      { id: 'sakura', name: '樱粉', color: '#fb7299' },
      { id: 'violet', name: '藤紫', color: '#9575cd' },
      { id: 'teal', name: '青碧', color: '#26c6da' },
      { id: 'jade', name: '森绿', color: '#26a69a' },
      { id: 'amber', name: '琥珀', color: '#ffb020' },
    ],
    desc: '中性深灰打底，六种主题色可选。深色/浅色都支持，适合长时间挂着看。',
    modes: ['dark', 'light'],
  },
  {
    id: 'apple',
    name: '苹果',
    // 参考文档只允许一支系统蓝（#0071e3），所以这套皮肤只给一个色。
    // 用户仍然可以在设置里换成自定义色，那属于用户自己的选择，不算皮肤违约。
    accents: [{ id: 'blue', name: '系统蓝', color: '#0071e3' }],
    desc: '浅灰画布、白卡片、一支系统蓝。全圆角按钮与慢一档的动效，只提供浅色。',
    // 风格参考本身定的就是 light：只有一套配色，明暗档锁在浅色。
    modes: ['light'],
    // 标题栏形态：'traffic' = 左侧三颗红绿灯（macOS），不写就是 Windows 右侧那三个。
    // 只决定「长在哪一侧、是圆点还是方框」，颜色仍在 skin.css 的 --traffic-* 里。
    titlebar: 'traffic',
    // 自带图标表 `skins/apple/icons.js`：关注换成心形、返回只留 chevron、
    // 更多是横排三点……只覆盖要换的名字，其余沿用 js/icons.js。
    icons: true,
  },
];

export const DEFAULT_SKIN_ID = 'default';

const BY_ID = new Map(SKINS.map((skin) => [skin.id, skin]));

/// 取皮肤定义；id 不认识时退回默认皮肤（比如用户从旧版本备份里导入了别的皮肤名）。
export function getSkin(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_SKIN_ID);
}

/// 皮肤文件的固定路径约定：`skins/<id>/skin.css`。
/// index.html 的首帧内联脚本也按这条约定拼地址，别在这里改成别的结构。
export function skinHref(id) {
  return `skins/${id}/skin.css`;
}

/// 这套皮肤实际可用的明暗档位。
export function skinModes(id) {
  const modes = getSkin(id).modes || ['dark'];
  return modes.length ? modes : ['dark'];
}

/// 这套皮肤的主题色清单（至少一项）。
/// 旧的 `accent` 单值写法当作「只有一个色」兼容掉，免得老皮肤定义直接取不到颜色。
export function skinAccents(id) {
  const skin = getSkin(id);
  if (Array.isArray(skin.accents) && skin.accents.length) return skin.accents;
  return [{ id: 'default', name: '默认', color: skin.accent || '#5b8def' }];
}

/// 皮肤的默认主题色 = accents 的第一项。
export function skinAccent(id) {
  return skinAccents(id)[0].color;
}
