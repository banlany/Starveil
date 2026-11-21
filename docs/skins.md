# 皮肤系统

> 0.7.0 起，配色与组件代码彻底分开：**组件 CSS 只消费变量，变量只住在皮肤文件里**。
> 换皮肤 = 换一个 `skin.css`，不需要改任何组件样式。
>
> 想改某个具体组件（开关、单选点、卡片、按钮、SC、平台标签…）：
> 直接查 **[组件清单](skin-components.md)**，那里按界面区域列出了每个组件吃哪些变量。

## 目录

```
web/
  skins/
    registry.js          内置皮肤清单 + 运行时注册表
    overrides.js         用户变量覆盖层白名单
    pack.js              皮肤包格式、清洗与 CSS 生成
    base.css             圆角 / 时长 / 阴影的阶梯派生层
    motion.css           动效档位覆盖层
    default/
      skin.css           默认皮肤「星幕」：深色 + 浅色
    apple/
      skin.css           皮肤「苹果」：只有浅色，两个作用域写在一起
      icons.js           皮肤「苹果」的图标表：只覆盖要换的名字
  styles.css             外壳与通用控件
  pages.css              一级页面
  room.css               直播间
  mobile.css             移动端布局
  js/
    motion.js            动效档位数据与 JS 分支 helper
```

`web/index.html` 在首帧前按 `skins/<base>/skin.css` 的约定插入基底样式表，
并先读 `localStorage` 里的预涂缓存定下 `data-theme` / `data-skin` / `data-skin-pack` /
`data-motion`，注入变量覆盖与皮肤包差异样式，避免启动时闪一帧默认配色或动画。

## 两个维度

| 维度 | 载体 | 说明 |
| --- | --- | --- |
| 皮肤 | `<html data-skin="default">` | 配色与质感 |
| 明暗 | `<html data-theme="dark|light">` | 同一套皮肤的深/浅两档 |

皮肤文件固定两块作用域：

```css
html[data-skin="<id>"] {                     /* 深色（或该皮肤唯一的一套） */ }
html[data-skin="<id>"][data-theme="light"] { /* 浅色覆盖 */ }
```

**只提供一套配色的皮肤**：`registry.js` 里 `modes: ['dark']`（或 `['light']`）。
这时设置页的明暗选项自动收窄成一档，侧栏的主题按钮提示「当前皮肤只提供深色主题」，
`applyTheme()` 强制使用皮肤支持的那一档。

这种皮肤只有一套值，两个作用域可以写在一起（`apple/skin.css` 就是这么写的）：

```css
html[data-skin="apple"],
html[data-skin="apple"][data-theme="light"] {
  /* 一套值，data-theme 是深是浅都落在这里 */
}
```

两块作用域都要写，`check-skin` 会逐条核对。

## 注册表字段

`skins/registry.js` 里一条记录就是一套皮肤，**能改的东西全在这张表里**：

| 字段 | 必填 | 作用 |
| --- | --- | --- |
| `id` | 是 | 目录名，同时写进 `<html data-skin="<id>">`；只允许小写字母、数字、短横线 |
| `name` | 是 | 设置页显示的名字 |
| `desc` | 是 | 一句话说明，出现在皮肤卡片上 |
| `accents` | 是 | 这皮肤提供的主题色，**第一项是默认色**（设置页色板只读这里） |
| `modes` | 是 | 支持的明暗档；只写一项就等于锁定明暗 |
| `icons` | 否 | `true` = 这套皮肤自带 `skins/<id>/icons.js`，可以换图标图形 |
| `titlebar` | 否 | `windows` / `traffic`（枚举 `TITLEBAR_MODES`），缺省 `windows` |
| `allowUserFont` | 否 | `true` 表示开放「设置 → 外观 → 界面字体」，缺省关闭 |
| `base` | 否 | 皮肤包专用：变量基底指向的内置皮肤 id |

颜色与组件尺寸在 `skin.css`；圆角、时长、阴影的阶梯由 `base.css` 派生，
皮肤只写缩放系数与差异项。上面这张表只管皮肤的身份、档位与形态。

## 变量契约

分组见 `web/skins/default/skin.css` 的注释，阶梯派生见 `web/skins/base.css`。摘要：

| 组 | 变量 |
| --- | --- |
| 主题色 | `--accent` `--accent-soft` `--accent-on` `--accent-strong` `--accent-glow` |
| 基础面 | `--bg` `--bg-elev` `--surface` `--surface-2` `--surface-3` `--surface-overlay` `--surface-menu` |
| 分隔 | `--line` `--line-strong` |
| 蒙层 | `--wash-1` ~ `--wash-4`（hover 底、输入框底、按下态） |
| 文字 | `--fg` `--fg-muted` `--fg-subtle` `--muted` `--dim` |
| 状态 | `--success(-soft)` `--warning(-soft)` `--danger(-soft)` `--danger-line` `--info` |
| 容器 | `--card-bg` `--card-border` `--card-radius` `--card-shadow` `--card-gap`；组间距 `--group-gap` `--group-label-bottom`；行 `--row-divider` `--row-pad-x` `--row-pad-y` `--row-min-h` `--row-hover` |
| 图卡 | `--tile-bg` `--tile-border` `--tile-radius` `--tile-shadow` |
| 按钮 | `--btn-h` `--btn-pad-x` `--btn-radius` `--btn-font` `--btn-weight` `--btn-on-weight` `--btn-small-*` |
| 开关 | `--switch-w` `--switch-h` `--switch-pad` `--switch-knob-size` `--switch-travel` `--switch-radius` `--switch-knob-radius` `--switch-off` `--switch-on` `--switch-knob` `--switch-knob-off` `--switch-knob-shadow` `--switch-dur` `--switch-ease` |
| 单选 | `--radio-size` `--radio-ring` `--radio-radius` `--radio-dot` `--radio-dot-radius` `--radio-line` `--radio-line-on` `--radio-dot-fill` |
| 色板 | `--swatch-size` `--swatch-radius` `--swatch-ring` `--swatch-check-*` `--skin-dot-*` |
| 筛选切换 | `--chip-*`（`.chip`、`.segmented button`、`.follow-mode button`、`.sc-view-nav button` 共用） |
| 胶囊 chip | `--chip-h` `--chip-pad-x` `--chip-radius` `--chip-font` `--chip-bg` `--chip-fg` `--chip-line` `--chip-shadow` `--chip-hover-bg` `--chip-hover-fg` `--chip-on-bg` `--chip-on-fg` `--chip-on-line` `--chip-solid-bg` |
| 平台标签 | `--tab-pad-x` `--tab-font` `--tab-gap` `--tab-underline-h` `--tab-underline-bg` `--tab-underline-radius` `--platform-logo-radius` |
| 提示条 | `--toast-bg` `--toast-fg` `--toast-border` |
| 阴影/遮罩 | `--shadow-1/-2/-3` `--shadow-line` `--scrim` `--blur-overlay` `--panel-blur` |
| 媒体层 | `--media-bg` `--media-fg(-muted/-dim/-faint)` `--media-chip(-soft/-hover/-active)` `--media-surface(-strong/-hover)` `--media-line(-strong)` `--media-topbar-bg` `--media-bar-line` `--media-accent` `--media-on-accent` `--media-shadow` `--media-text-shadow` `--media-track` `--media-halo` `--media-blur` `--media-fade-top/-bottom/-side` `--stage-backdrop` |
| 直播间 | `--room-bg` `--room-panel` `--room-bar` `--room-field` `--room-line` `--room-float-bg/-fg/-line/-shadow` `--room-float-hover-bg/-fg` |
| SC 卡片 | `--on-sc` `--on-sc-strong` `--on-sc-weak` `--on-sc-hover` `--on-sc-ring` `--on-sc-shadow` `--sc-line` `--sc-radius` `--sc-msg-*` `--sc-border-w` `--sc-shade` `--sc-chat-fg` |
| 封面/头像 | `--cover-*` `--avatar-*` `--logo-bg` `--qr-bg` `--img-placeholder` |
| 骨架/滚动条 | `--shimmer` `--scrollbar-thumb` |
| 自绘标题栏 | `--titlebar-bg` `--titlebar-fg` `--titlebar-line` `--titlebar-btn` `--titlebar-btn-hover` `--titlebar-btn-active` |
| 窗口按钮 | `--window-close-hover` `--window-close-active` `--window-close-fg` |
| 红绿灯（mac 形态） | `--traffic-size` `--traffic-gap` `--traffic-close` `--traffic-min` `--traffic-max` `--traffic-edge` `--traffic-glyph` `--traffic-glyph-size` `--traffic-glyph-stroke` |
| 悬停提示 | `--tip-bg` `--tip-fg` `--tip-border` `--tip-shadow` `--tip-radius` `--tip-pad-x` `--tip-pad-y` `--tip-font` `--tip-max-w` |
| 图标 | `--icon-stroke` `--icon-cap` `--icon-join` `--icon-stroke-thin` |
| 圆角 | `--radius-2xs` `--radius-xs` `--radius-sm` `--radius-md` `--radius` `--radius-lg` `--radius-xl` `--radius-pill`（base.css） |
| 字体 | `--font` `--font-display` `--font-mono` |
| 动效 | `--dur-fast` `--dur-base` `--dur-slow`（base.css）`--motion-scale`（motion.css）`--ease`（皮肤） |

### 阶梯派生层

`web/skins/base.css` 在 `:root` 上把 8 档圆角、3 档时长、4 档阴影展开成 `calc()`：

```css
--radius-scale: 1;
--radius-sm: calc(8px * var(--radius-scale));
--dur-scale: 1;
--motion-scale: 1;
--dur-fast: calc(0.14s * var(--dur-scale) * var(--motion-scale));
--shadow-scale: 1;
--shadow-rgb: 0, 0, 0;
--shadow-a1: 0.22;
--shadow-1: 0 calc(2px * var(--shadow-scale)) calc(8px * var(--shadow-scale))
            rgba(var(--shadow-rgb), var(--shadow-a1));
```

- 皮肤只写 `--radius-scale` / `--dur-scale` / `--shadow-scale` / `--shadow-rgb` /
  `--shadow-a1` `-a2` `-a3` `-a-line`。星幕深色用默认值，苹果写放大与变慢的系数，
  星幕浅色只换阴影颜色与透明度。
- 单档要精确取值时直接覆盖派生变量（苹果把 `--radius` 写回 `12px`）。
- 皮肤包 `vars` 里写 `--radius-scale: 0.25` 即可整体收圆角，不必逐档重列。
- `calc()` 里的 `var()` 在使用处展开，`html[data-skin=...]` 上的系数会参与求值；
  用户覆盖层写进 `<html>` 的 inline style，优先级最高。
- 派生值是 `calc()` 文本，设置页滑杆用探针元素读取浏览器算出的长度/时长。

### 动效三档

`appearance.motion` 取 `full` / `reduced` / `off`，首次启动按
`prefers-reduced-motion` 推导；首帧脚本写 `<html data-motion>`，`applyTheme()`
每次重算，`starveil.boot.v1` 带档位，启动时不会先闪一帧动画。

| 档位 | 行为 |
| --- | --- |
| `full` | `--motion-scale: 1`，保留过渡、入场、错峰与加载动画 |
| `reduced` | `--motion-scale: 0.5`，入场只留淡入，去掉错峰与装饰性无限循环 |
| `off` | `--motion-scale: 0`，全局 `0.01ms !important` 兜底；JS 同步加 show、直接移除浮层节点、不加入场 class |

`web/js/motion.js` 是档位唯一取值来源：`currentMotion()` 读
`document.documentElement.dataset.motion`，`motionDelay()` / `showOnNextFrame()` /
`addEnterClass()` / `scrollBehavior()` 供 JS 分支使用。弹幕画布、播放重连、
SC 到期与停留、控制栏空闲等待、定时关闭、轮询与窗口保存是功能性计时，不归动效档。

组件 CSS 与 skin.css 不写死时长或缓动：`--dur-*` 由 `base.css` 派生，缓动走
`--ease`，较长的循环写 `calc(var(--dur-base) * N)`。`tools/check-skin.mjs`
会拦回潮；档位覆盖与 `0.01ms` 兜底只放在 `skins/motion.css`。

触屏左右滑切平台时 `render({ swipe })` 把方向带进入场 class，
`page-in-swipe-next` / `page-in-swipe-prev` 让页面跟着手势横移；`reduced`
收敛为淡入，`off` 不入场。首页卡片由 `ui.js::roomGrid()` 写入
`--card-delay`，间隔随序号收窄、总时延收敛，卡片再多也依次浮起。

### 字体：把要用的字体排进 `--font`，别指望系统装了什么

`--font` 是一整条 **font-family 栈**，按顺序 fallback。应用内置了一份
**HarmonyOS Sans SC**（`web/fonts.css` + `web/assets/fonts/harmonyos-sans/`，
GB2312 子集、三个字重），所以栈里可以放心写它：

- 系统真有的优先（macOS 的 `-apple-system` / 苹方、Windows 的雅黑），
- 没有的落到 `"HarmonyOS Sans SC"` —— 安卓两样都没有，以前直接掉到 Roboto，
  中文观感和苹方差一截，现在用的是随包的这份；
- 兜底再写 `system-ui, sans-serif`。

弹幕走 canvas，拿不到 CSS 变量，`danmaku.js` 会读 `getComputedStyle(document.body).fontFamily`
当作画布字体，所以**没单独设弹幕字体时，改皮肤就等于改弹幕字体**。
生僻字仍由系统字体逐字兜底（内置字体只到 GB2312），不会出现方块。

### 用户字体：两个运行时变量，皮肤里不要定义

设置页可以覆盖字体，覆盖值由 JS 写到 `:root` / 聊天列表上，皮肤里**不定义**这两个变量：

| 变量 | 写入方 | 用途 |
|---|---|---|
| `--font-user` | `store.js` 的 `applyTheme` | 外观 → 界面字体；值为 `"<字体>", var(--font)`，未设置时整条链落回 `--font` |
| `--dm-font` | `room.js` 的 `applyDanmakuStyle` | 弹幕 → 字体；写到 `#chat-list`，`.chat-line` 用 `var(--dm-font, inherit)` |

界面字体只对 `allowUserFont: true` 的皮肤开放：`applyTheme` 在其它皮肤下清掉 `--font-user`。
弹幕字体与皮肤无关，选中值由 canvas 直接使用。

### 主题色：一套皮肤提供一组，不是固定一个

皮肤不绑定单一品牌色，而是在 `registry.js` 里声明一组主题色，**第一个就是默认色**：

```js
accents: [
  { id: 'mist', name: '雾蓝', color: '#5b8def' },
  { id: 'sakura', name: '樱粉', color: '#fb7299' },
  // …
],
```

- 设置页「外观 → 主题颜色」的色板只读这一份清单，别处不要再写第二份色板；
- 色板只在 `accents` 多于一项时出现。只有一项的皮肤（苹果）固定用它，不接受用户自选；
- 用户自选记在 `appearance.accentSource`，跨皮肤保留，但只在该皮肤提供多个色时生效；
- 浅色档替代色写在这一项自身的 `light` 字段；`accentForMode(skinId, color, mode)`
  只在当前皮肤的 accents 里查同名色值，设置里存的始终是 `color` 原值；
- `skin.css` 里的 `--accent` 只作**首帧兜底**（JS 未执行时使用），必须等于 accents 第一项，
  `check-skin` 会核对这两个值。

### 图标也算皮肤的一部分

图标的图形在 `js/icons.js`，但**质感**归皮肤：

| 变量 | 作用 |
| --- | --- |
| `--icon-stroke` | 线条粗细（默认 1.75） |
| `--icon-cap` / `--icon-join` | 端点 / 拐角形状，做「机械感」可换成 `square` / `miter` |
| `--icon-stroke-thin` | 细线档，只给标题栏那三个 10px 的窗口按钮用 |

想连**图形轮廓**一起换的皮肤，在 `skins/<id>/icons.js` 里导出 `ICON_PATHS`
（只写要覆盖的名字），并在 registry 里给这套皮肤加 `icons: true`：

```js
export const ICON_PATHS = { home: '<path d="…"/>', settings: '<rect …/>' };
```

可覆盖的名字以 `web/js/icons.js` 的 `PATHS` 为全集（当前 66 个）：

`account` `accountFilled` `anchor` `back` `category` `categoryFilled` `check` `chevron`
`chevronDown` `chevronUp` `close` `contrast` `copy` `danmaku` `danmakuOff` `delay`
`download` `dual` `filter` `flame` `follow` `followFilled` `fullscreen` `fullscreenExit`
`github` `gridView` `history` `home` `homeFilled` `info` `link` `list`
`live` `minus` `moon` `more` `mute` `other` `parse` `pause`
`play` `player` `plus` `quality` `refresh` `route` `screen` `search`
`send` `settings` `share` `shield` `signal` `spark` `star` `stats`
`sun` `sync` `tag` `text` `timer` `upload` `userMinus` `users`
`volume` `wifi`

`icon()` 找不到覆盖项时静默退回基础表，所以 `check-skin` 会核对 `icons.js` 里的每个键
是否存在于 `js/icons.js` 的 `PATHS`。

图形里**不要**写 `stroke-width` / `linecap` / `linejoin`：线宽和端点归 `--icon-*`，
写死在 path 上等于这套皮肤换不了粗细。实心图形显式写 `fill="currentColor" stroke="none"`。

`store.js::loadSkinIcons()` 会在启动时（第一屏之前）和切皮肤时加载它，
已经画在页面上的图标会就地重画——侧栏、标题栏这些外壳不会跟着页面重渲染。

窗口按钮（最小化 / 最大化 / 关闭）不进覆盖表，保持系统通用符号；线宽仍受 `--icon-stroke-thin` 控制。

### 自绘标题栏

Windows 没有系统标题栏（`decorations: false`），顶部那条是我们自己画的。
它是一组独立 token，不复用 `--bg`，因此可以单独做「深色边框 + 浅色页面」。
默认皮肤里它们就是 `var(--bg)` / `var(--fg)` / `var(--line)`，**用引用而不是抄 hex**。

### 窗口按钮的两种形态

默认是 Windows 那种「右侧三个方框」。皮肤可以在 `registry.js` 里写一行换成 macOS 红绿灯：

```js
{ id: 'apple', titlebar: 'traffic', /* … */ }
```

`titlebar.js` 按这个字段把 `html[data-titlebar]` 设成 `traffic`，组件样式据此把三颗圆点
挪到左边、按 关闭 / 最小化 / 缩放 排序（DOM 顺序不变，靠 `order` 排）。颜色与尺寸仍归变量。

### 媒体层（画面上的浮层）

顶栏、控制条、音量浮层、小窗、加载提示、SC 浮卡都压在视频画面上，背后是未知亮度的画面。
默认给「白字 + 半透明黑底」，亮画面暗画面都读得出来——但这一组整组归皮肤，
不是组件写死的铁律。想做白色不透明、黑字的浮层（瑞士风那类），成套翻过来就行：

| 要改的东西 | 变量 |
| --- | --- |
| 底色 | `--media-bg` `--media-surface` `--media-surface-strong` `--media-surface-hover` |
| 文字 | `--media-fg` `--media-fg-muted` `--media-fg-dim` `--media-fg-faint` |
| 描边 | `--media-line` `--media-line-strong` |
| 条状背景 | `--media-topbar-bg`（顶栏整条）、`--media-fade-top` / `--media-fade-bottom`（渐隐，填纯色就是硬边条）、`--media-bar-line`（顶栏底边与控制条顶边的那道线） |
| 主题色 | `--media-accent`（画面上的高亮）、`--media-on-accent`（实心按钮上的字） |
| 质感 | `--media-blur`（要硬边就设 `none`）、`--media-text-shadow`（浅底上设 `none`）、`--media-halo` `--media-track` `--media-shadow` |

三条约定：翻底色就翻字色，别只改一半；浅底上把 `--media-text-shadow` 关掉，
不然黑字带黑影像是糊了；`--media-accent` 要跟着底一起换，
否则「为深色配的浅色主题色」压在白底上会看不见。

### 用户变量覆盖层

`web/skins/overrides.js` 是唯一白名单：`OVERRIDE_GROUPS` 声明可覆盖的变量、取值范围与单位，
设置页「外观 → 高级外观」按它生成滑杆。成对变量（`--media-*` 的底色与字色、`--on-sc*`）不列入，
`sanitizeOverrides()` 只接受表内变量与「数值 + 本项单位」。

- 值存在 `appearance.overrides`，只记改过的项；切皮肤保留，清除后回到皮肤自带值。
- `applyTheme()` 把 `DENSITY_PRESETS` 的密度预设与用户覆盖合并，写进 `<html>` 的 inline style，
  优先级高于 `skin.css`。`index.html` 的首帧脚本读 `starveil.boot.v1` 的 `overrides` 提前注入。
- 界面密度走 `--row-min-h` `--row-pad-y` `--item-min-h`，与用户覆盖共用同一组变量。
- 备份与同步包导入时用 `sanitizeOverrides()` 清洗覆盖值，并校验 `appearance.skin` 已注册。
- `check-skin.mjs` 核对白名单里的每个变量都有定义；新增可调项只改 `OVERRIDE_GROUPS` 一处。

### 运行时注入的变量

这几个不写在皮肤里，由 JS 直接 `setProperty`，检查脚本已放行：

| 变量 | 来源 |
| --- | --- |
| `--accent` `--accent-soft` | `store.js::applyTheme()`（用户选的主题色） |
| `--sc-bg` `--sc-bg-strong` | `room.js` 按 SC 档位写的浅色底 |
| `--big-emoji-lines` | `room.js` 大表情占几行 |
| `--avatar-hue` | 按用户名算出来的头像色相 |
| `--chat-width` | 聊天栏拖拽宽度 |

其余变量必须在皮肤文件里有定义，否则 `tools/check-skin.mjs` 会报错。

## 新增一套皮肤

1. 建目录 `web/skins/<id>/skin.css`（`<id>` 只能用小写字母、数字、短横线）；
2. 复制 `default/skin.css` 的两块作用域，把 `<id>` 换掉，按需要改值；
   不需要的变量可以整段删掉——但**组件用到的**必须在两块里都有定义（浅色块可以只覆盖差异项）；
3. 在 `web/skins/registry.js` 的 `BUILTIN_SKINS` 里加一条：

   ```js
   {
     id: 'cassette',
     name: '磁带未来',
     desc: '拉丝金属 + 琥珀荧光',
     accents: [
       { id: 'amber', name: '磁带橙', color: '#e9a13b' },
       { id: 'mint', name: '荧光绿', color: '#5ef2a8' },
     ],
     modes: ['dark'],
     // 自带图标表的皮肤才写这一行，并在同目录放 icons.js
     icons: true,
   },
   ```

4. 把新皮肤 `--accent` 的静态值写成就第 3 步 accents 第一项的颜色；
5. 跑 `node tools/check-skin.mjs`。

设置页不需要改：它读 `SKINS`（含运行时注册的皮肤包）与 `skinAccents()`，
多于一套时自动出现多张卡片、色板自动跟着换。

## 皮肤包

「设置 → 外观 → 皮肤包」安装、导出、删除 JSON 皮肤包。包存在 `localStorage` 的
`starveil.skin-packs.v1`，最多 16 套、单包 64 KB。同步包与备份只带 `appearance.skin` 的 id，
包本体不跨设备；本机没有这个 id 时保留本机皮肤。

包基于一套内置皮肤（`base`），只写差异变量：

| 字段 | 说明 |
| --- | --- |
| `format` / `version` | `starveil-skin` / `1` |
| `id` | 小写字母、数字、短横线，2–32 位，不能撞内置皮肤 id |
| `name` / `desc` | 卡片上的名字与说明 |
| `base` | 内置皮肤 id，变量基底来自它的 `skin.css` |
| `accents` | 同注册表；色值只收 3 / 6 位十六进制，可带 `light` 替代色 |
| `modes` | `dark` / `light`，只列一项即锁定该档 |
| `titlebar` | `windows` / `traffic`，枚举 `TITLEBAR_MODES` |
| `allowUserFont` | 布尔值，是否开放界面字体 |
| `vars.dark` / `vars.light` | 变量名 → 值，只写要改的变量；`--radius-scale` 这类系数写这里 |
| `icons` | 图标名 → SVG 片段，只写要换的图标 |

```json
{
  "format": "starveil-skin",
  "version": 1,
  "id": "oled",
  "name": "OLED 影院",
  "desc": "纯黑底 + 冷蓝，画面周边控件退场",
  "base": "default",
  "accents": [{ "id": "blue", "name": "冷蓝", "color": "#6f9dff" }],
  "modes": ["dark"],
  "vars": { "dark": { "--bg": "#000000", "--surface": "#0a0a0b", "--radius": "2px" } },
  "icons": { "flame": "<circle cx=\"12\" cy=\"12\" r=\"9\"/>" }
}
```

`packCss()` 生成两块作用域并注入 `#skin-pack-css` 的 `<style>`，紧跟基底 `skin.css` 之后：

```css
html[data-skin-pack="oled"] { --bg: #000000; }
html[data-skin-pack="oled"][data-theme="light"] { --bg: #ffffff; }
```

`<html data-skin>` 保持基底 id，`<html data-skin-pack>` 是包 id。包 CSS 自动补
`--accent`（浅色档取 `accent.light`）；运行时 `applyTheme()` 的 inline 变量优先级更高。
`index.html` 首帧从 `starveil.boot.v1` 读 `pack.css` 提前注入，重载不闪。

`pack.js::sanitizeSkinPack()` 是唯一入口：变量名限 `--[a-z0-9-]`，值拒绝分号、花括号、
尖括号、`@`、反斜杠、`url()` 与 `expression()`；图标片段只留 `path` `circle` `rect` `line`
`polyline` `polygon` `ellipse` `g`，事件属性与脚本标签整条丢弃。CSS 用 `textContent` 写入
`<style>`，图标按「基础 → 皮肤 → 用户」三层合并。

## 强制检查

```
node tools/check-skin.mjs
```

报这几类问题：

1. 组件 CSS 里出现颜色字面量（`#xxx` / `rgb()` / `hsl()`）、非零的写死圆角、写死 `font-family`、
   写死 `stroke-width`（图标线宽）、`[data-skin=...]` 或 `[data-theme=...]` 选择器；
2. `web/index.html` 里出现内联 `<svg>` 或 `stroke-width=`（内联图形绕过了皮肤契约）；
3. **开关 / 单选 / 色板 / 色点**的宽高、内距、描边粗细写死（这几类的尺寸就是它们的风格）；
4. **卡片三件套**（`--surface` 底 + `1px solid var(--line)` 描边 + `--radius` 圆角）写死——
   改用 `--card-*`，否则皮肤没法把设置页换成「无卡片列表」；
5. 皮肤文件缺失、缺少 `html[data-skin="<id>"]` 作用域、皮肤里出现了变量声明以外的规则、
   `--accent` 与 registry 里 accents 第一项不一致；
6. `registry.js` 里有皮肤没声明 `accents`，标了 `icons: true` 却没有 `icons.js`，
   或 `icons.js` 里写了 `js/icons.js` 里不存在的图标名；
7. `js/icons.js` 的 `icon()` 又把线宽写回标签，或丢了 `data-icon`（切皮肤时就地重画会失效）；
8. 组件里 `var(--x)` 用到但 `base.css` + 皮肤合并后仍没有定义
   （拼错变量名就是这样漏的）；
9. `base.css` 缺失或写了变量声明以外的规则，皮肤 `titlebar` 不在 `TITLEBAR_MODES` 里；
10. 皮肤包契约：合法包被拒、非法 id / base / format / version 被放过、CSS 注入与外链变量值、
    带事件属性或非白名单标签的图标没被清洗掉。

确实需要保留字面量的行，行尾加 `/* skin:allow 原因 */` 放行，并在 PR 里说明。

## 不要做的事

- 不要在组件 CSS 里按 `html[data-theme="light"]` 逐条覆盖颜色，
  浅色差异写在皮肤的浅色变量块里。
- 不要在 JS 里写死颜色（`#fff`、`#101014` 这类）。需要颜色时读计算值：
  `getComputedStyle(document.documentElement).getPropertyValue('--bg')`。
- 不要把主题色当成「皮肤的唯一身份」。要换色就加一项 accents，别复制一整套皮肤只改颜色。
- 不要在 `index.html` 里画 `<svg>`，图形与线宽都归 `js/icons.js` 与 `--icon-*`。
- 不要用同一个变量表达两种语义（比如把「画面上压的字」和「页面正文色」都塞进 `--fg`）。
  画面上的文字走 `--media-fg`，并且要跟 `--media-surface` 成对改。
- 不要在新的容器上重复「`--surface` 底 + `1px solid var(--line)` + `--radius`」三件套。
  一个块该长成卡片还是长成列表，是皮肤的决定，不是组件的决定：套 `--card-*`。
  图卡（首页 / 分类的封面卡）用 `--tile-*`，默认透明无描边；想让它们长成卡片，
  在皮肤里把 `--tile-*` 接回 `--card-*`。
- 不要给开关、单选点、色板写死宽高，尺寸即风格，走 `--switch-*` / `--radio-*` / `--swatch-*`。
- 不要在皮肤里重列 8 档圆角、3 档时长或 4 档阴影，改 `--radius-scale` / `--dur-scale`
  / `--shadow-scale` 与阴影系数；单档微调才覆盖派生变量。
