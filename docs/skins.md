# 皮肤设计指南

> 面向皮肤设计者。本文列出设计一套皮肤需要的全部字段与变量，按本文操作不需要读组件 CSS、JS 或 Rust 代码。
> 想知道「某个控件吃哪些变量」查 **[组件清单](skin-components.md)**；现成的形态配方也在那份文档末尾。
> 内置皮肤的代码级流程收在 [§14](#14-内置皮肤)，只做皮肤包可以跳过。

## 目录

1. [两条路径](#1-两条路径)
2. [皮肤管什么、不管什么](#2-皮肤管什么不管什么)
3. [皮肤包：从零到可用](#3-皮肤包从零到可用)
4. [元数据字段](#4-元数据字段)
5. [能力开关与设置页](#5-能力开关与设置页)
6. [两块作用域、首帧与优先级](#6-两块作用域首帧与优先级)
7. [变量总表](#7-变量总表)
8. [派生阶梯与动效](#8-派生阶梯与动效)
9. [主题色与字体链路](#9-主题色与字体链路)
10. [媒体层](#10-媒体层)
11. [图标](#11-图标)
12. [标题栏与窗口按钮](#12-标题栏与窗口按钮)
13. [用户覆盖层与密度](#13-用户覆盖层与密度)
14. [内置皮肤](#14-内置皮肤)
15. [校验](#15-校验)
16. [常见错误速查](#16-常见错误速查)
17. [不要做的事](#17-不要做的事)

---

## 1. 两条路径

| | 皮肤包 | 内置皮肤 |
| --- | --- | --- |
| 载体 | 一个 JSON 文件 | `web/skins/<id>/skin.css` + `registry.js` 一条记录 |
| 改代码 | 不需要 | 需要 |
| 分发 | 「设置 → 外观 → 皮肤包」导入 / 导出 | 随应用发布 |
| 变量来源 | 指向一套内置皮肤作基底（`base`），只写差异项 | 自己写全量 |
| 可用能力 | 配色、形态、字体、图标、主题色、明暗档、标题栏、能力开关 | 同左 |
| 数量上限 | 本机 16 套，单包 64 KB | 无限 |

新设计走皮肤包：导出模板 → 改 JSON → 安装，界面立即生效，改坏了删掉重来。
内置皮肤适合要随应用发布的设计。

---

## 2. 皮肤管什么、不管什么

一套皮肤 = **元数据** + **变量表** + 可选的**图标表**。

皮肤能决定的：所有颜色（含压在视频画面上的浮层）、圆角与描边、阴影与模糊、字体栈、
图标线宽与端点、缓动、控件几何（开关 / 单选 / 色板的宽高）、卡片长成卡片还是列表、
标题栏形态、主题色清单、明暗档数量、用户能否改主题色与字体。

皮肤不碰的：

| 类别 | 例子 | 归属 |
| --- | --- | --- |
| 布局尺寸 | `--rail-width` `--topbar-height` `--titlebar-height` `--safe-*` `--stage-h` `--chat-width` `--mask-solid` | 组件 CSS / 移动端安全区 / JS 测量 |
| 运行时值 | `--accent` `--accent-soft` `--accent-on` `--sc-bg` `--sc-bg-strong` `--avatar-hue` `--big-emoji-lines` `--font-user` `--dm-font` `--card-delay` | JS `setProperty` |
| 组件规则 | 选择器、布局、`@media`、`@keyframes` | 组件 CSS |

**两条硬约束**：

- 皮肤侧只允许 CSS 变量声明。`skin.css` 里不写选择器、不写 `{}` 规则（两块作用域除外）；
  皮肤包的 `vars` 是「变量名 → 值」的扁平对象。
- 组件侧只消费 `var(--x)`，不写颜色字面量、非零圆角、字体名、图标线宽、动效时长与缓动，
  不写 `[data-skin=...]` / `[data-theme=...]` 选择器。`tools/check-skin.mjs` 逐行拦回潮。

---

## 3. 皮肤包：从零到可用

**第 1 步 · 取模板**
「设置 → 外观 → 皮肤包 → 导出当前皮肤」。选哪套皮肤，导出的 `base` 就是哪套。

**第 2 步 · 身份**
改 `id`（小写字母 / 数字 / 短横线，2–32 位，不能撞内置 id）、`name`、`desc`。

**第 3 步 · 基底与档位**
`base` 选 `default` / `apple` / `cinema`；`modes` 填 `["dark"]`、`["light"]` 或 `["dark","light"]`。
只填一项时设置页的明暗选项收窄成一项。

**第 4 步 · 主题色与能力**
写 `accents`，第一项是默认色；按设计意图写 `allowAccent` / `allowUserFont` / `allowOverrides`（见 §5）。
`titlebar` 填 `windows` 或 `traffic`（见 §12）。

**第 5 步 · 变量**
`vars.dark` 写深色档差异，`vars.light` 写浅色档差异。只写要改的项，其余继承基底。
单档皮肤把值写进 `vars.dark`（`data-theme` 停在皮肤锁定的那一档）。
不知道该改哪个变量时查 §7 与 [组件清单](skin-components.md)。

**第 6 步 · 图标（可选）**
`icons` 写「图标名 → SVG 片段」，只写要换的图形。名字全集见 §11。

**第 7 步 · 安装与验证**
「安装皮肤包」选这个 JSON，安装后立即切换。同 `id` 覆盖。
验收走三处：设置页卡片与色板、首页/分类页卡片、直播间（亮画面与暗画面各看一次控制条与加载提示）。

完整示例（浅色纸感、只提供浅色、锁定主题色、字体与高级外观）：

```json
{
  "format": "starveil-skin",
  "version": 1,
  "id": "paper",
  "name": "纸张",
  "desc": "暖白纸面、硬边细线、单色墨蓝",
  "base": "default",
  "accents": [{ "id": "ink", "name": "墨蓝", "color": "#2b4d7e", "light": "#2b4d7e" }],
  "modes": ["light"],
  "titlebar": "windows",
  "allowAccent": false,
  "allowUserFont": false,
  "allowOverrides": false,
  "vars": {
    "dark": {
      "--bg": "#f7f5ef",
      "--bg-elev": "#fffdf8",
      "--surface": "#fffdf8",
      "--surface-2": "#f0ece2",
      "--surface-3": "#e6e1d5",
      "--surface-overlay": "#fffdf8",
      "--surface-menu": "#fffdf8",
      "--line": "rgba(43, 50, 62, 0.12)",
      "--line-strong": "rgba(43, 50, 62, 0.24)",
      "--fg": "#1d222b",
      "--fg-muted": "#4a5160",
      "--fg-subtle": "#6c7381",
      "--muted": "#5c6371",
      "--dim": "#8b9099",
      "--radius-scale": "0.25",
      "--card-bg": "#fffdf8",
      "--card-border": "1px solid rgba(43, 50, 62, 0.18)",
      "--card-radius": "2px",
      "--card-shadow": "none",
      "--icon-cap": "butt",
      "--icon-join": "miter",
      "--icon-stroke": "1.5",
      "--ease": "cubic-bezier(0.2, 0.7, 0.3, 1)",
      "--font": "\"Georgia\", \"Songti SC\", \"SimSun\", serif"
    },
    "light": {}
  },
  "icons": {
    "home": "<path d=\"M3 11 12 4l9 7v9H3z\"/>"
  }
}
```

`vars.dark` 里没写的变量全部继承基底；`vars.light` 为空表示浅色档沿用深色档的值。
单档皮肤两个作用域会写成同一套值。

---

## 4. 元数据字段

`内置` 一列是 `web/skins/registry.js` 的 `BUILTIN_SKINS` 记录字段；`皮肤包` 一列是 JSON 字段。

| 字段 | 皮肤包 | 内置 | 取值 / 约束 | 作用 |
| --- | --- | --- | --- | --- |
| `format` | 必填 | — | `"starveil-skin"` | 格式标识 |
| `version` | 必填 | — | `1`，大于 1 拒绝 | 包版本 |
| `id` | 必填 | 必填 | `^[a-z0-9][a-z0-9-]{1,31}$`；包不能撞内置 id | 目录名 / `<html data-skin>` / `data-skin-pack` |
| `name` | 可选 | 必填 | ≤24 字符 | 皮肤卡片名称 |
| `desc` | 可选 | 必填 | ≤100 字符 | 卡片说明 |
| `base` | 必填 | 包专用 | 内置皮肤 id | 变量基底来自 `skins/<base>/skin.css` |
| `accents` | 必填 | 必填 | 1–8 项，缺省补一项 `#5b8def` | 主题色清单，第一项为默认色 |
| `modes` | 必填 | 必填 | `dark` / `light` 的数组，缺省 `["dark"]` | 支持的明暗档；只列一项即锁定 |
| `titlebar` | 可选 | 可选 | `windows`（缺省）/ `traffic` | 窗口按钮形态 |
| `allowAccent` | 可选 | 可选 | 布尔，缺省 `true` | 用户能否改主题色 |
| `allowUserFont` | 可选 | 可选 | 布尔，缺省 `true` | 用户能否改界面字体 |
| `allowOverrides` | 可选 | 可选 | 布尔，缺省 `true` | 用户能否调整高级外观（形状 / 间距 / 动效 / 密度） |
| `vars` | 必填 | — | `{ dark: {}, light: {} }` | 差异变量，见 §7 |
| `icons` | 可选 | 可选 | 图标名 → SVG 片段；内置侧写 `icons: true` + `icons.js` | 图形覆盖，见 §11 |

`accents` 每一项：

| 字段 | 约束 | 作用 |
| --- | --- | --- |
| `id` | `^[a-z0-9-]{1,24}$`，非法时自动生成 `c1`、`c2`… | 色板项标识 |
| `name` | ≤16 字符 | 色板上显示的名字 |
| `color` | 3 / 6 位十六进制 | **默认色**，同时是首帧 `--accent` 的取值 |
| `light` | 可选，3 / 6 位十六进制 | 浅色档替代色；设置里始终存 `color` 原值 |

清洗规则（`sanitizeSkinPack()`）：变量名限 `--[a-z0-9-]{1,48}`，单值 ≤256 字符，
每档最多 300 项；值里出现 `;` `{}` `<>` `@` `\` `url()` `expression()` `javascript:` 整条丢弃。
图标片段只保留 `path` `circle` `rect` `line` `polyline` `polygon` `ellipse` `g`，
事件属性、`style`、`href`、`<script>` 整条丢弃，单个图标最多 24 个标签、1024 字符，最多 64 项。

---

## 5. 能力开关与设置页

三项能力**缺省开放**，只有显式写 `false` 才锁定。皮肤包导出模板会带上当前皮肤的取值。

| `allowAccent` | 设置 → 外观 → 主题颜色 | 运行时 |
| --- | --- | --- |
| 省略 / `true` | 色板：`accents` 全部色 + 自定义色 | 用户选色（`appearance.accents[皮肤 id]`）生效 |
| `false` | 只读一行，显示 `accents[0].name`，说明「这套皮肤固定主题色」 | `--accent` 固定为 `accents[0].color` |

| `allowUserFont` | 设置 → 外观 → 界面字体（桌面 / 移动端横屏） | 运行时 |
| --- | --- | --- |
| 省略 / `true` | 字体下拉 + 「跟随皮肤」 | 写入 `--font-user` |
| `false` | 只读一行「跟随皮肤」，说明「这套皮肤固定字体」 | 不写 `--font-user` |

| `allowOverrides` | 设置 → 外观 → 界面密度 / 高级外观 | 运行时 |
| --- | --- | --- |
| 省略 / `true` | 密度下拉 + 高级外观总开关与 9 条滑杆 | 密度预设与 `appearance.overrides` 都生效 |
| `false` | 两组各一行只读说明，总开关与滑杆都不出现 | 形状、间距、动效全部取皮肤自带值，密度预设也不参与 |

内置皮肤现状：

| 皮肤 | `accents` | `modes` | `allowAccent` | `allowUserFont` | `allowOverrides` | `titlebar` |
| --- | --- | --- | --- | --- | --- | --- |
| `default` 星幕 | 7 色 | `dark` + `light` | 开放 | 开放 | 开放 | `windows` |
| `apple` 苹果 | 1 色（系统蓝） | `light` | **锁定** | **锁定** | **锁定** | `traffic` |
| `cinema` OLED 影院 | 5 色 | `dark` | 开放 | 开放 | **锁定** | `windows` |

苹果把系统蓝、系统字体与全圆角当作设计的一部分：注册表里写 `allowAccent: false`、
`allowUserFont: false`、`allowOverrides: false`，设置页三项都只显示只读说明。
OLED 影院的硬边与紧凑间距同理，只锁 `allowOverrides`。

`modes` 只有一项时，明暗档也锁定：设置页只列出皮肤支持的那一档，存着的偏好保留但不生效。

---

## 6. 两块作用域、首帧与优先级

内置皮肤的 `skin.css` 固定两块：

```css
html[data-skin="<id>"] { /* 深色，或该皮肤唯一的一套 */ }
html[data-skin="<id>"][data-theme="light"] { /* 浅色覆盖 */ }
```

皮肤包的 `vars.dark` / `vars.light` 生成等价的两块：

```css
html[data-skin-pack="<id>"] { --bg: #000000; }
html[data-skin-pack="<id>"][data-theme="light"] { --bg: #ffffff; }
```

`<html data-skin>` 保持基底 id，`data-skin-pack` 是包 id，两者同时存在。

只提供一套配色的皮肤，两块可以写在一起，`data-theme` 落在深或浅都命中同一套值：

```css
html[data-skin="apple"],
html[data-skin="apple"][data-theme="light"] { /* 一套值 */ }
```

**首帧**：`web/index.html` 的内联脚本读 `localStorage` 的 `starveil.boot.v1`
（含 theme / 基底皮肤 / 皮肤包 CSS / overrides / motion），在组件样式表加载前插入
`skins/<base>/skin.css` 与皮肤包差异 CSS，并先定下 `data-theme` / `data-skin` /
`data-skin-pack` / `data-motion`。启动不会先闪一帧默认配色或动效。

由此产生三条约定：

1. `skin.css` 的静态 `--accent` **必须等于** `accents[0].color`；`check-skin` 逐套核对。
2. 浅色档的 `--accent` 取 `accents[0].light`（没有 `light` 就取 `color`）；皮肤包的 `packCss()`
   自动补上这两块里的 `--accent`，不用手写。
3. `--accent` / `--accent-soft` / `--accent-on` / `--font-user` 与用户覆盖层由 `applyTheme()`
   写成 `<html>` 的 inline style。

优先级从低到高：`base.css` 派生值 → 基底 `skin.css` → 皮肤包 `vars` → inline style。
用户在「高级外观」里拖的滑杆默认盖过皮肤自带值；总开关关闭或皮肤锁定 `allowOverrides`
时覆盖项不写入 inline style，「恢复皮肤默认值」清掉覆盖项后回到皮肤值。

切皮肤时 `applySkin()` 等新样式表 `load` 后再重算与重画设置页：改 `link[href]` 是异步加载，
不等的话设置页滑杆读到的还是上一套皮肤的计算值。

---

## 7. 变量总表

组件消费、皮肤必须提供的变量共 **213 项**（下表 `必填` 列）。
皮肤包只写差异项，缺的继承基底；内置皮肤要在两块作用域里写全（浅色块可以只覆盖差异项）。
`保留` 列是当前内置皮肤定义但组件未直接消费的项，写出来是为了链路完整，可选。

值类型约定：`<color>` 颜色 / `<len>` 长度 / `<num>` 无单位数 / `<border>` 完整 border 值 /
`<shadow>` 完整 box-shadow 值 / `<filter>` filter 函数 / `<gradient>` linear-gradient() /
`<font>` 整条 font-family 栈 / `<timing>` 缓动函数 / `<keyword>` CSS 关键字。

### 7.1 主题色

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--accent` | 全局强调色；skin.css 里是首帧兜底，运行时由 JS 覆盖 | `<color>` `#5b8def` | 首帧 |
| `--accent-soft` | 强调色淡底（选中态、淡色 chip） | `color-mix(in srgb, var(--accent) 16%, transparent)`；浅色 18% | 运行时 |
| `--accent-on` | 压在强调色上的文字 / 图标 | `<color>` `#ffffff` | ✓ |
| `--accent-strong` | 强调色按下态 | `color-mix(in srgb, var(--accent) 82%, #000)` | 保留 |
| `--accent-glow` | 强调色光晕（渐变里那一团） | `color-mix(in srgb, var(--accent) 35%, transparent)` | ✓ |
| `--media-accent` | 画面上的高亮：加载转圈、进度条、实心按钮 | `var(--accent)` 或独立 `<color>` | ✓ |

### 7.2 基础面、分隔、蒙层

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--bg` | 页面底；安卓系统栏与标题栏 meta 取这个值 | `<color>` `#101014` | ✓ |
| `--bg-elev` | 略高一层：输入框、侧栏 | `<color>` `#17171c` | ✓ |
| `--surface` `--surface-2` `--surface-3` | 容器 / 按钮 / hover 三级 | `<color>` `#1c1c22` … | ✓ |
| `--surface-overlay` | 弹窗底 | `<color>` `#1b1b21` | ✓ |
| `--surface-menu` | 下拉菜单底 | `<color>` `#222229` | ✓ |
| `--line` | 常规分隔线 | `<color>` `rgba(255,255,255,.07)` | ✓ |
| `--line-strong` | 强调分隔线、输入框描边 | `<color>` `rgba(255,255,255,.13)` | ✓ |
| `--wash-1` `--wash-2` `--wash-3` `--wash-4` | hover 底 → 输入框底 → 按下态四级蒙层 | `<color>` `rgba(255,255,255,.035)` / `.07` / `.12` / `.18` | ✓ |
| `--scrim` | 弹窗背后的压暗层 | `<color>` `rgba(5,5,8,.58)` | ✓ |
| `--blur-overlay` | 弹窗背后的模糊 | `<filter>` `blur(5px)` | ✓ |
| `--panel-blur` | 弹窗 / 菜单自身的毛玻璃 | `<filter>` `blur(14px)` | ✓ |
| `--shadow-rgb` `--shadow-a1` `--shadow-a2` `--shadow-a3` `--shadow-a-line` | 阴影颜色与四级透明度，详见 §8 | `0, 0, 0` / `0.22` … | 系数 |

### 7.3 文字与状态

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--fg` | 正文 / 主要文字 | `<color>` `#f2f2f4` | ✓ |
| `--fg-muted` | 次要说明、SC 正文 | `<color>` `#b6b6c0` | ✓ |
| `--fg-subtle` | 三级说明 | `<color>` `#878793` | ✓ |
| `--muted` | 未选中标签、图标按钮 | `<color>` `#9d9da7` | ✓ |
| `--dim` | 占位符、空状态 | `<color>` `#6e6e79` | ✓ |
| `--success` `--success-soft` | 成功 / 直播中圆点 | `<color>` `#57d38c` / `rgba(...,.14)` | ✓ |
| `--warning` `--warning-soft` | 警告 | `<color>` `#f0b232` / `rgba(...,.14)` | `--warning` ✓ |
| `--danger` `--danger-soft` `--danger-line` | 危险 / 删除 | `<color>` `#ff6b6b` … | ✓ |
| `--info` | 付费身份、大航海这类信息色 | `<color>` `#58a8ff` | ✓ |

### 7.4 容器：卡片、图卡与列表行

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--card-bg` `--card-border` `--card-radius` `--card-shadow` | 卡片四件套：设置分组、工具卡、统计卡、信息表、列表行 | `var(--surface)` / `1px solid var(--line)` / `var(--radius)` / `none` | ✓ |
| `--card-gap` | 卡片之间的间距 | `<len>` `14px` | ✓ |
| `--group-gap` | 设置页组与组的距离 | `<len>` `20px` | ✓ |
| `--group-label-bottom` | 组标题与卡片之间 | `<len>` `9px` | ✓ |
| `--row-divider` | 分组内行分隔线 | `<border>` `1px solid var(--line)` | ✓ |
| `--row-pad-x` `--row-pad-y` | 行内距 | `<len>` `18px` / `11px` | ✓ |
| `--row-min-h` | 分组内行最小高 | `<len>` `60px` | ✓ |
| `--row-hover` | 列表行 hover 底 | `<color>` `var(--surface-2)` | ✓ |
| `--item-min-h` | 一级设置项行高，独立于分组内行 | `<len>` `57px` | ✓ |
| `--tile-bg` `--tile-border` `--tile-radius` `--tile-shadow` | 首页 / 分类封面图卡，默认透明无框 | `transparent` / `none` / `var(--card-radius)` / `none` | ✓ |

### 7.5 按钮、胶囊 chip、平台标签

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--btn-h` `--btn-pad-x` | 按钮高度与左右内距 | `<len>` `34px` / `15px` | ✓ |
| `--btn-radius` `--btn-font` | 按钮圆角、字号 | `var(--radius-md)` / `13.5px` | ✓ |
| `--btn-weight` `--btn-on-weight` | 常规 / 主按钮字重 | `<num>` `400` / `600` | ✓ |
| `--btn-small-h` `--btn-small-pad-x` `--btn-small-radius` `--btn-small-font` | 小按钮四件套 | `28px` / `11px` / `var(--radius-sm)` / `12.5px` | ✓ |
| `--chip-h` `--chip-pad-x` `--chip-radius` `--chip-font` | 胶囊 chip 几何与字号（关注页筛选、观看记录 segmented、SC 页签共用） | `30px` / `13px` / `var(--radius-pill)` / `13px` | ✓ |
| `--chip-bg` `--chip-fg` `--chip-line` `--chip-shadow` | chip 未选中态 | `transparent` / `var(--muted)` / `1.5px solid var(--line-strong)` / `none` | ✓ |
| `--chip-hover-bg` `--chip-hover-fg` | chip hover 态 | `var(--surface)` / `var(--fg)` | ✓ |
| `--chip-on-bg` `--chip-on-fg` `--chip-on-line` | chip 选中态；`--chip-line` 与 `--chip-on-line` 的描边宽度一致，尺寸才不跳 | `var(--accent-soft)` / `var(--accent)` / `1.5px solid var(--accent)` | ✓ |
| `--chip-solid-bg` | 实心变体底 | `var(--surface-2)` | ✓ |
| `--tab-pad-x` `--tab-font` `--tab-gap` | 顶部平台标签内距、字号、间距 | `14px` / `15px` / `8px` | ✓ |
| `--tab-underline-h` `--tab-underline-bg` `--tab-underline-radius` | 标签下主题色指示条 | `2px` / `var(--accent)` / `var(--radius-pill)` | ✓ |
| `--platform-logo-radius` | 平台图标圆角 | `50%` | ✓ |

### 7.6 开关、单选、色板、皮肤色点

尺寸即风格：方形开关、细长条开关、小圆点单选都只改这几组值。

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--switch-w` `--switch-h` `--switch-pad` | 开关外形与内距 | `<len>` `44px` / `25px` / `3px` | ✓ |
| `--switch-knob-size` `--switch-knob-radius` | 滑块尺寸与圆角 | `19px` / `50%` | ✓ |
| `--switch-travel` | 滑块行程 | `calc(var(--switch-w) - var(--switch-knob-size) - var(--switch-pad) * 2)` | ✓ |
| `--switch-radius` | 轨道圆角 | `var(--radius-pill)` | ✓ |
| `--switch-off` `--switch-on` | 关 / 开轨道色 | `var(--surface-3)` / `var(--accent)` | ✓ |
| `--switch-knob` `--switch-knob-off` | 滑块开 / 关色 | `#ffffff` / `#b9b9c2` | ✓ |
| `--switch-knob-shadow` | 滑块投影 | `<shadow>` `0 1px 2px rgba(0,0,0,.3)` | ✓ |
| `--switch-dur` `--switch-ease` | 滑块过渡时长与缓动 | `var(--dur-fast)` / `var(--ease)` | ✓ |
| `--radio-size` `--radio-ring` `--radio-radius` | 单选外圈尺寸、线宽、圆角 | `20px` / `1.8px` / `50%` | ✓ |
| `--radio-dot` `--radio-dot-radius` `--radio-dot-fill` | 选中实心点 | `10px` / `50%` / `var(--accent)` | ✓ |
| `--radio-line` `--radio-line-on` | 未选中 / 选中圈色 | `var(--line-strong)` / `var(--accent)` | ✓ |
| `--swatch-size` `--swatch-radius` `--swatch-ring` | 主题色色板方块 | `34px` / `var(--radius-sm)` / `inset 0 0 0 1px var(--media-line)` | ✓ |
| `--swatch-check-w` `--swatch-check-h` `--swatch-check-stroke` `--swatch-check-on` | 色板选中勾 | `11px` / `6px` / `2px` / `var(--accent-on)` | ✓ |
| `--skin-dot-size` `--skin-dot-radius` `--skin-dot-ring` | 皮肤卡片前的小圆点 | `14px` / `50%` / `inset 0 0 0 1px var(--line-strong)` | ✓ |

### 7.7 提示条、悬停气泡、骨架与滚动条

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--toast-bg` `--toast-fg` `--toast-border` | 提示条 | `rgba(34,34,42,.96)` / `#f2f2f4` / `rgba(255,255,255,.1)` | ✓ |
| `--tip-bg` `--tip-fg` `--tip-border` `--tip-shadow` | 悬停气泡（所有 `title` 由 `tooltip.js` 接管后画出的 `.app-tip`） | `rgba(34,34,42,.97)` / `#f2f2f4` / `rgba(255,255,255,.09)` / `<shadow>` | ✓ |
| `--tip-radius` `--tip-pad-x` `--tip-pad-y` `--tip-font` `--tip-max-w` | 气泡几何 | `var(--radius-sm)` / `9px` / `5px` / `12px` / `260px` | ✓ |
| `--shimmer` | 骨架屏扫光 | `<color>` `rgba(255,255,255,.055)` | ✓ |
| `--scrollbar-thumb` | 滚动条滑块色（`scrollbar-color` 用；不要写 `::-webkit-scrollbar*`） | `<color>` `#34343d` | ✓ |
| `--img-placeholder` | 图片 / 头像占位底 | `<color>` `#222222` | ✓ |

### 7.8 媒体层：压在视频画面上的一切

顶栏、控制条、音量浮层、小窗、加载提示、SC 浮卡都压在未知亮度的画面上。
这一整组独立于页面配色，见 §10。

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--media-bg` | 画面区底色 | `<color>` `#000000` | ✓ |
| `--media-fg` `--media-fg-muted` `--media-fg-dim` | 画面上三级文字 | `#ffffff` / `rgba(255,255,255,.78)` / `rgba(255,255,255,.55)` | ✓ |
| `--media-fg-faint` | 第四级文字 | `rgba(255,255,255,.38)` | 保留 |
| `--media-chip` `--media-chip-soft` `--media-chip-hover` `--media-chip-active` | 画面上胶囊（返回、更多、小窗）四态底 | `rgba(0,0,0,.32)` … | ✓ |
| `--media-surface` `--media-surface-strong` `--media-surface-hover` | 加载提示、音量浮层等卡片底三态 | `rgba(14,14,19,.78)` … | ✓ |
| `--media-line` `--media-line-strong` | 画面上描边两级 | `rgba(255,255,255,.16)` / `.28` | ✓ |
| `--media-topbar-bg` | 顶栏整条底色，缺省透明只留胶囊 | `transparent` | ✓ |
| `--media-bar-line` | 顶栏底边 / 控制条顶边那道线（inset 阴影，不占高度） | `transparent` | ✓ |
| `--media-fade-top` `--media-fade-bottom` | 上下渐隐；填纯色即硬边条 | `<gradient>` | ✓ |
| `--media-fade-side` | 侧边渐隐 | `<gradient>` | 保留 |
| `--media-track` | 画面上滑条轨道 | `rgba(255,255,255,.28)` | ✓ |
| `--media-accent` `--media-on-accent` | 画面上高亮 / 实心按钮上的字色 | `var(--accent)` / `#ffffff` | ✓ |
| `--media-shadow` `--media-halo` `--media-text-shadow` | 投影、光晕、文字描影 | `<shadow>` / `<color>` / `<shadow>` | ✓ |
| `--media-blur` | 胶囊与卡片的毛玻璃，硬边设 `none` | `<filter>` `blur(10px)` | ✓ |
| `--stage-backdrop` | 竖屏画面填不满时垫在背后的放大虚化背景 | `<filter>` `blur(26px) brightness(.38) saturate(1.15)` | ✓ |

### 7.9 直播间表面

独立于 `--surface` 阶梯，避免影响其它页面。

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--room-bg` `--room-panel` `--room-bar` `--room-field` | 房间外壳 / 聊天栏 / 底部动作栏 / 输入框 | `#050507` / `#101015` / `#0b0b0f` / `#1a1a22` | ✓ |
| `--room-line` | 直播间分隔线 | `rgba(255,255,255,.06)` | ✓ |
| `--room-float-bg` `--room-float-fg` `--room-float-line` `--room-float-shadow` | 聊天栏上的浮层（回到底部、展开聊天） | `rgba(30,32,40,.92)` / `rgba(255,255,255,.86)` / `<color>` / `<shadow>` | ✓ |
| `--room-float-hover-bg` `--room-float-hover-fg` | 同上 hover 态；压在画面上，不用 `--wash-*` | `var(--wash-3)` / `var(--fg)` | ✓ |

### 7.10 SC（醒目留言）

卡片底色是平台档位色（`--sc-bg`，运行时写入），文字色由下面这组定，不跟随明暗。

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--on-sc` `--on-sc-strong` `--on-sc-weak` | SC 卡三级文字 | `#2a1c0d` / `#ffffff` / `rgba(0,0,0,.45)` | ✓ |
| `--on-sc-hover` `--on-sc-ring` `--on-sc-shadow` | hover 底 / 焦点圈 / 投影 | `rgba(0,0,0,.12)` / `rgba(255,255,255,.55)` / `rgba(0,0,0,.28)` | ✓ |
| `--sc-line` | SC 卡分隔线 | `rgba(0,0,0,.08)` | ✓ |
| `--sc-radius` `--sc-msg-radius` | 大卡 / 聊天里 SC 条圆角 | `var(--radius-md)` / `var(--radius-sm)` | ✓ |
| `--sc-msg-pad-y` `--sc-msg-pad-x` `--sc-border-w` | SC 条内距与边宽 | `8px` / `10px` / `1px` | ✓ |
| `--sc-shade` | 压在平台档位色上的遮罩：深色压暗、浅色 `transparent` | `rgba(0,0,0,.42)` | ✓ |
| `--sc-chat-fg` | 聊天区 SC 条文字色 | `var(--on-sc-strong)` / `var(--on-sc)` | ✓ |

### 7.11 封面、头像与固定白底

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--cover-bg-a` `--cover-bg-b` | 封面占位渐变两端 | `#24242d` / `#17171d` | ✓ |
| `--cover-fallback-a` `--cover-fallback-b` `--cover-fallback-fg` | 封面加载失败占位 | `<color>` ×3 | ✓ |
| `--cover-scrim` | 封面上下压暗 | `<gradient>` | ✓ |
| `--cover-chip` `--cover-chip-fg` | 封面上的小胶囊（平台角标、收藏） | `rgba(10,10,14,.72)` / `#ffffff` | ✓ |
| `--avatar-fg` `--avatar-sat` `--avatar-light` | 头像文字色与生成色相的饱和度 / 亮度 | `#ffffff` / `45%` / `38%` | ✓ |
| `--logo-bg` | 品牌 logo 底；logo 是浅色图案，留在白底上 | `#ffffff` | ✓ |
| `--qr-bg` | 二维码底，不随皮肤染色 | `#ffffff` | ✓ |

### 7.12 标题栏、窗口按钮、红绿灯

`--titlebar-*` 是一组独立 token，不复用 `--bg`，可做「深色边框 + 浅色页面」。

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--titlebar-bg` `--titlebar-fg` `--titlebar-line` | 自绘 38px 标题栏 | `var(--bg)` / `var(--fg)` / `var(--line)` | ✓ |
| `--titlebar-btn` | 窗口按钮图形色 | `var(--muted)` | ✓ |
| `--titlebar-btn-hover` `--titlebar-btn-active` | 按钮 hover / 按下底 | `var(--surface-2)` / `var(--surface-3)` | ✓ |
| `--window-close-hover` `--window-close-active` `--window-close-fg` | 关闭键红（系统约定，不跟皮肤变） | `#e81123` / `#f1707a` / `#ffffff` | ✓ |
| `--traffic-size` `--traffic-gap` | 红绿灯圆点尺寸与间距 | `12px` / `8px` | ✓ |
| `--traffic-close` `--traffic-min` `--traffic-max` | 关闭 / 最小化 / 缩放三色 | `#ff5f57` / `#febc2e` / `#28c840` | ✓ |
| `--traffic-edge` | 圆点描边 | `rgba(0,0,0,.12)` | ✓ |
| `--traffic-glyph` `--traffic-glyph-size` `--traffic-glyph-stroke` | 圆点里的符号（hover 时浮出） | `rgba(0,0,0,.55)` / `8px` / `1.35` | ✓ |

### 7.13 字体、图标质感、缓动

| 变量 | 作用 | 类型 / 示例 | 必填 |
| --- | --- | --- | --- |
| `--font` | 正文与控件的整条 font-family 栈 | `<font>` `"Microsoft YaHei UI", …, system-ui, sans-serif` | ✓ |
| `--font-display` | 标题与数字；接 `var(--font-user, …)` 才能响应界面字体 | `<font>` `var(--font-user, var(--font))` | 保留 |
| `--font-mono` | 等宽内容 | `<font>` `Consolas, "Cascadia Mono", monospace` | ✓ |
| `--icon-stroke` `--icon-stroke-thin` | 常规线宽 / 窗口按钮 10px 小图形线宽 | `<num>` `1.75` / `1.2` | ✓ |
| `--icon-cap` `--icon-join` | 线端 / 拐角 | `<keyword>` `round` / `square` / `miter` / `butt` | ✓ |
| `--ease` | 统一缓动 | `<timing>` `cubic-bezier(.22,.61,.36,1)` | ✓ |

### 7.14 不在皮肤里的变量

这些由 JS / 布局写入，皮肤里不要定义：

`--accent` `--accent-soft` `--accent-on`（运行时覆盖，skin.css 里留首帧值）、
`--font-user` `--dm-font`、`--sc-bg` `--sc-bg-strong`、`--avatar-hue`、
`--big-emoji-lines`、`--chat-width`、`--card-delay`、
`--rail-width` `--topbar-height` `--titlebar-height` `--safe-top` `--safe-bottom`
`--safe-left` `--safe-right` `--sys-safe-top` `--sys-safe-bottom` `--sys-safe-left`
`--sys-safe-right` `--ime-bottom` `--tab-underline-inset` `--mask-solid` `--stage-h`。

### 7.15 成对联动的变量

改一个就要一起改另一半，单独翻一半会读不清：

| 一组 | 约定 |
| --- | --- |
| `--media-surface*` ↔ `--media-fg*` | 底色翻浅，字色翻深 |
| `--media-surface*` ↔ `--media-text-shadow` | 浅底上把文字阴影设 `none` |
| `--media-*` ↔ `--media-accent` | 底色换了，画面高亮要换成能读的颜色；要跟随主题色就写 `var(--accent)` |
| `--card-bg` ↔ `--card-border` ↔ `--card-radius` ↔ `--card-shadow` | 卡片四件套一起决定「卡片还是列表」 |
| `--chip-line` ↔ `--chip-on-line` | 描边宽度一致，选中不跳尺寸 |
| `--on-sc*` ↔ `--sc-shade` ↔ `--sc-chat-fg` | SC 底色是平台给的，文字与遮罩按明暗配套 |
| `--bg` ↔ `--fg*` | 标题栏 meta、系统栏、canvas 弹幕字体都从这里取 |

---

## 8. 派生阶梯与动效

`web/skins/base.css` 在 `:root` 上把 8 档圆角、3 档时长、4 档阴影展开成 `calc()`：
皮肤只写系数，不重列阶梯。

| 系数 | 派生变量 | 公式 |
| --- | --- | --- |
| `--radius-scale` | `--radius-2xs` `--radius-xs` `--radius-sm` `--radius-md` `--radius` `--radius-lg` `--radius-xl` `--radius-pill` | `4 / 6 / 8 / 10 / 12 / 16 / 20 / 999px × scale` |
| `--dur-scale` | `--dur-fast` `--dur-base` `--dur-slow` | `0.14 / 0.2 / 0.28s × dur-scale × motion-scale` |
| `--shadow-scale` `--shadow-rgb` `--shadow-a1/-a2/-a3/-a-line` | `--shadow-1` `--shadow-2` `--shadow-3` `--shadow-line` | `rgba(var(--shadow-rgb), a*)` + 按 scale 缩放的偏移与模糊 |
| `--motion-scale` | 同上三档时长 | `motion.css` 按 `<html data-motion>` 写入 |

- 单档要精确取值时直接覆盖派生变量（苹果把 `--radius` 写回 `12px`）。
- 皮肤包 `vars` 里写 `"--radius-scale": "0.25"` 即可整体收圆角。
- `calc()` 里的 `var()` 在使用处展开，`html[data-skin=...]` 上的系数参与求值。
  设置页滑杆用探针元素读取浏览器算出的长度 / 时长。

动效三档由 `appearance.motion` 决定，首次启动按 `prefers-reduced-motion` 推导：

| 档位 | `--motion-scale` | 行为 |
| --- | --- | --- |
| `full` | `1` | 保留过渡、入场、错峰与加载动画 |
| `reduced` | `0.5` | 入场只留淡入，去掉错峰与装饰性无限循环 |
| `off` | `0` | 全局 `0.01ms !important` 兜底；JS 同步加 show、直接移除浮层、不加入场 class |

皮肤里不写裸时长、裸缓动；较长的循环写 `calc(var(--dur-base) * N)`，缓动走 `--ease`。
`web/js/motion.js` 是档位唯一取值来源，触屏左右滑页与首页卡片错峰都按档位处理。
弹幕画布、播放重连、SC 到期、控制栏空闲等待、轮询与窗口保存是功能性计时，不归动效档。

---

## 9. 主题色与字体链路

**主题色**

```
accents[0].color ──> skin.css 的静态 --accent（首帧）
accents[] ─────────> 设置页色板（allowAccent 为 false 时不出现）
appearance.accents[皮肤 id] ──> resolveAccentValue() ──> accentForMode() ──> applyTheme()
   ├─ --accent        强调色
   ├─ --accent-soft   color-mix(强调色 16% / 18%, transparent)
   └─ --accent-on     按亮度取 #15151b 或 #ffffff
```

- 主题色**按皮肤各存一份**（`appearance.accents`，键为皮肤 id）：切走再切回来还是原来那份，
  没有键表示跟随该皮肤的默认色。设置页皮肤卡片的色点也按各自的键取值。
- `allowAccent: false` 时 `resolveAccentValue()` 直接返回 `accents[0].color`，用户存着的选色不生效。
- `accentForMode(skinId, color, mode)` 只在**当前皮肤自己**的 `accents` 里查 `light`；
  设置里存的始终是 `color` 原值。
- 组件读 `var(--accent)`；`--tab-underline-bg`、`--switch-on`、`--radio-dot-fill`、
  `--chip-on-*` 等都用引用接上主题色，不抄 hex。
- `--media-accent` 单独一档：写 `var(--accent)` 就跟随主题色；写死色值则画面高亮固定。
  OLED 影院用前者，蓝色主题下加载转圈与进度条一起变蓝。

**字体**

`--font` 是整条 font-family 栈，应用不附带字体文件，只排各平台自带的中文字体 +
`system-ui, sans-serif` 兜底。`body` 用 `var(--font-user, var(--font))`：

- `allowUserFont: true` 且用户选了字体：`applyTheme()` 写
  `--font-user: "<字体>", var(--font)`，标题的 `--font-display` 也接 `var(--font-user, …)`；
- `allowUserFont: false` 或选「跟随皮肤」：不写 `--font-user`，整条链落到皮肤 `--font`。
- 皮肤里**不定义** `--font-user`。`--dm-font` 是弹幕设置写到聊天列表上的，和皮肤无关。
- 弹幕走 canvas，拿不到 CSS 变量，`danmaku.js` 读 `getComputedStyle(document.body).fontFamily`；
  没单独设弹幕字体时，改 `--font` 就等于改弹幕字体。

---

## 10. 媒体层

顶栏、控制条、音量浮层、小窗、加载提示、SC 浮卡背后是未知亮度的画面。
默认是「白字 + 半透明黑底」，这一组整组归皮肤，翻成白底黑字不需要改组件样式。

| 要改的东西 | 变量 |
| --- | --- |
| 底色 | `--media-bg` `--media-surface` `--media-surface-strong` `--media-surface-hover` `--media-chip*` |
| 文字 | `--media-fg` `--media-fg-muted` `--media-fg-dim` `--media-fg-faint` |
| 描边 | `--media-line` `--media-line-strong` `--media-bar-line` |
| 条状背景 | `--media-topbar-bg` `--media-fade-top` `--media-fade-bottom` `--media-fade-side` |
| 主题色 | `--media-accent` `--media-on-accent` |
| 质感 | `--media-blur` `--media-text-shadow` `--media-halo` `--media-track` `--media-shadow` `--stage-backdrop` |

三条约定：翻底色就翻字色；浅底上把 `--media-text-shadow` 设 `none`；
`--media-accent` 跟着底一起换，为深色配的浅色主题色压在白底上读不出来。

`cinema/skin.css` 是深色档的另一套取法：胶囊底压到 `rgba(12, 9, 6, 0.28)`、
`--media-blur: none`、上下渐隐各只留一小段、字色换暖白；
`--media-accent: var(--accent)`、`--media-on-accent: var(--accent-on)`，切主题色时画面高亮同步变化。

白色不透明浮层的整组配方见 [组件清单 · 附 7](skin-components.md)。

---

## 11. 图标

图标质感归皮肤变量，图形轮廓可选覆盖。

| 变量 | 作用 |
| --- | --- |
| `--icon-stroke` | 线宽（默认 `1.75`） |
| `--icon-cap` / `--icon-join` | 端点 / 拐角；「机械感」用 `square` / `miter` |
| `--icon-stroke-thin` | 窗口按钮那三个 10px 图形的细线档 |

想连图形一起换：内置皮肤在 `skins/<id>/icons.js` 导出 `ICON_PATHS`（只写要覆盖的名字）
并在注册表标 `icons: true`；皮肤包在 `icons` 里写同名对象。切皮肤时会就地重画已渲染的图标。

可覆盖的名字（以 `web/js/icons.js` 的 `PATHS` 为全集，当前 66 个）：

`account` `accountFilled` `anchor` `back` `category` `categoryFilled` `check` `chevron`
`chevronDown` `chevronUp` `close` `contrast` `copy` `danmaku` `danmakuOff` `delay`
`download` `dual` `filter` `flame` `follow` `followFilled` `fullscreen` `fullscreenExit`
`github` `gridView` `history` `home` `homeFilled` `info` `link` `list`
`live` `minus` `moon` `more` `mute` `other` `parse` `pause`
`play` `player` `plus` `quality` `refresh` `route` `screen` `search`
`send` `settings` `share` `shield` `signal` `spark` `star` `stats`
`sun` `sync` `tag` `text` `timer` `upload` `userMinus` `users`
`volume` `wifi`

图形里不写 `stroke-width` / `linecap` / `linejoin`，线宽与端点归 `--icon-*`；
实心图形显式写 `fill="currentColor" stroke="none"`。写错图标名会静默退回基础图形，
`check-skin` 会核对每个键。窗口按钮（最小化 / 最大化 / 关闭）不进覆盖表，保持系统通用符号。

合并顺序：**基础 `PATHS` → 皮肤 / 皮肤包 `icons` → 用户**。`store.js::loadSkinIcons()`
在首屏之前与切皮肤时加载，侧栏、标题栏这些不随页面重渲染的外壳靠就地重画跟上。

---

## 12. 标题栏与窗口按钮

Windows 没有系统标题栏（`decorations: false`），顶部那条自己画；变量见 §7.12。
`titlebar: 'windows'`（缺省）是右侧三个方框，`traffic` 是左侧 macOS 红绿灯：
`titlebar.js` 据此写 `<html data-titlebar>`，组件靠 `order` 把三颗圆点排成
关闭 / 最小化 / 缩放，DOM 顺序不变。颜色与尺寸仍归 `--traffic-*`。

`--titlebar-*` 是独立 token，默认皮肤用 `var(--bg)` / `var(--fg)` / `var(--line)` 引用而非抄 hex。

---

## 13. 用户覆盖层与密度

`web/skins/overrides.js` 的 `OVERRIDE_GROUPS` 是唯一白名单，设置页「外观 → 高级外观」
按它生成滑杆。值存在 `appearance.overrides`，只记改过的项。

「高级外观」顶部的总开关是 `appearance.overridesEnabled`（缺省 `true`）。关闭后覆盖项保留在
存储里但不写入 inline style，界面回到皮肤自带值；重新打开即恢复，不用重新调。
皮肤写 `allowOverrides: false` 时开关与滑杆都不出现，覆盖项一律不生效。

| 分组 | 可覆盖变量 | 范围 / 单位 |
| --- | --- | --- |
| 形状 | `--radius-sm` `--radius` `--radius-lg` `--card-radius` | 0–20 / 0–28 / 0–36 / 0–36 px |
| 间距 | `--group-gap` `--row-pad-y` `--row-min-h` | 8–40 / 4–24 / 40–88 px |
| 动效 | `--dur-base` `--icon-stroke` | 0–0.8 s / 1–2.6 |

密度三档写 `--row-min-h` `--row-pad-y` `--item-min-h` 的预设值，与用户覆盖共用同一组变量。
密度是独立设置项，不受总开关影响；但 `allowOverrides: false` 的皮肤连密度预设也不应用，
设置页那一行改成只读说明。成对变量（`--media-*` 的底色与字色、`--on-sc*`）不列入白名单。
`sanitizeOverrides()` 只接受表内变量与「数值 + 本项单位」，备份与同步包导入时也过这一层。

设计者要知道：上面 9 项与密度预设的 3 项默认会被用户拖走，皮肤自带值只是默认值；
不想要这种自由度的皮肤把 `allowOverrides` 写成 `false`。

---

## 14. 内置皮肤

```
web/
  skins/
    registry.js          内置皮肤清单 + 运行时注册表
    overrides.js         用户变量覆盖层白名单
    pack.js              皮肤包格式、清洗与 CSS 生成
    base.css             圆角 / 时长 / 阴影的阶梯派生层
    motion.css           动效档位覆盖层
    default/
      skin.css           星幕：深色 + 浅色
    apple/
      skin.css           苹果：只有浅色，两个作用域写在一起
      icons.js           苹果图标表
    cinema/
      skin.css           OLED 影院：只有深色，两个作用域写在一起
      icons.js           OLED 影院图标表
  styles.css / pages.css / room.css / mobile.css   组件样式（只消费变量）
  js/motion.js          动效档位数据与 JS helper
```

新增一套内置皮肤：

1. 建 `web/skins/<id>/skin.css`（`<id>` 只允许小写字母、数字、短横线）；
2. 复制 `default/skin.css` 的两块作用域，把 `<id>` 换掉，按 §7 改值；
   组件用到的 213 项必须在深色块里有定义（浅色块可以只覆盖差异项）；
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
     icons: true,          // 自带 icons.js 才写
     titlebar: 'windows',  // 或 'traffic'
     // 缺省开放主题色、界面字体与高级外观；要锁定才写下面三行
     // allowAccent: false,
     // allowUserFont: false,
     // allowOverrides: false,
   }
   ```

4. 把 `skin.css` 的静态 `--accent` 写成第 3 步 `accents[0].color`；
5. 跑 `node tools/check-skin.mjs`；
6. 需要随包发布的图标表按 §11 放 `skins/<id>/icons.js`。

设置页不需要改：它读运行时 `SKINS`（内置 + 已注册的皮肤包）与 `skinAccents()`，
多一套自动多一张卡片；主题色与字体的可操作性由 §5 的两个能力字段决定。

`skinHref(id)` 与 `index.html` 首帧脚本共用 `skins/<base>/skin.css` 这条路径约定，
改目录名要两边一致。「设置 → 外观 → 皮肤包 → 导出当前皮肤」也能把内置皮肤导出成空白模板。

---

## 15. 校验

```
node tools/check-skin.mjs            # 静默通过 / 列出问题
node tools/check-skin.mjs --verbose  # 附带皮肤数、变量数、组件消费数
```

拦这几类问题：

1. 组件 CSS 里出现颜色字面量（`#xxx` / `rgb()` / `hsl()`）、非零写死圆角、写死
   `font-family`、写死 `stroke-width`、裸动效时长 / 缓动、`[data-skin=]` / `[data-theme=]` 选择器；
2. `web/index.html` 里出现内联 `<svg>` 或 `stroke-width=`；
3. 开关 / 单选 / 色板 / 色点的宽高、内距、描边写死；
4. 卡片三件套（`var(--surface)` 底 + `1px solid var(--line)` + `var(--radius)`）写死；
5. 皮肤文件缺失、缺少两块作用域、出现变量声明以外的规则、
   `--accent` 与 `accents[0]` 不一致、`skin.css` 里写死动效时长；
6. `allowAccent` / `allowUserFont` / `allowOverrides` 不是布尔值，或与
   `skinAllowsAccent()` / `skinAllowsFont()` / `skinAllowsOverrides()` 不一致；
7. 皮肤包缺省没开放三项能力、显式锁定没生效；
8. 注册表缺 `accents`、标了 `icons: true` 却没有 `icons.js`、
   `icons.js` 写了基础表不存在的图标名；
9. `js/icons.js` 的 `icon()` 把线宽写回标签或丢了 `data-icon`；
10. 组件里 `var(--x)` 用到但 `base.css` + 皮肤合并后仍没有定义；
11. `base.css` 缺失或写了非变量规则、皮肤 `titlebar` 不在 `TITLEBAR_MODES`、
    `--dur-*` 没乘 `--motion-scale`；
12. 皮肤包契约：合法包被拒、非法 id / base / format / version 被放过、
    CSS 注入与外链变量值、带事件属性或非白名单标签的图标没被清洗掉。

确实需要保留字面量的行，行尾加 `/* skin:allow 原因 */` 放行，并在 PR 里说明。

---

## 16. 常见错误速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动先闪一下别的颜色 / 别的皮肤 | `skin.css` 的 `--accent` 与 `accents[0].color` 不一致；首帧缓存没带上皮肤包 CSS | 对齐两处色值；`check-skin` 会报 |
| 换主题色后加载转圈、进度条不变色 | 皮肤的 `--media-accent` 写死成某个 hex | 改成 `var(--accent)` |
| 白底浮层上的字看不清 | 只翻了 `--media-surface*`，没翻 `--media-fg*`；文字阴影没关 | 成对改，浅底设 `--media-text-shadow: none` |
| 设置页选不了主题色 / 字体 / 高级外观 | 皮肤或包写了 `allowAccent: false` / `allowUserFont: false` / `allowOverrides: false` | 需要开放就删掉对应那行；苹果与 OLED 影院保留 |
| 选了浅色仍是深色 | `modes` 只列了 `["dark"]` | 补 `light` 并写浅色作用域 |
| 皮肤包安装失败 | `id` 撞内置 id / 含大写或下划线；`base` 不是内置 id；`format` 不是 `starveil-skin`；值里含 `;` `{}` `<>` `url()` | 按 §4 修正 |
| 换了图标但界面没变 | 图标名不在 §11 全集里 | 核对名字，`check-skin` 会报 |
| 改了 `--radius` 没效果 | 用户在「高级外观」里拖过圆角，inline style 优先 | 点「恢复皮肤默认值」，或关掉高级外观总开关 |
| 高级外观没有滑杆 | 皮肤写了 `allowOverrides: false`，两项都只给只读说明 | 需要调整就换开放的皮肤；设计上就固定则保留 |
| `check-skin` 报 `var(--x) 没有定义` | 拼错变量名，或某块作用域漏了这一项 | 按 §7 补齐 213 项 |
| 卡片选中时尺寸跳一下 | `--chip-line` 与 `--chip-on-line` 描边宽度不同 | 写成同一宽度 |
| 切皮肤后侧栏图标还是旧图形 | 图标没走 `data-icon` 就地重画 | 检查 `icon()` 输出与 `icons.js` |

---

## 17. 不要做的事

- 不要在组件 CSS 里按 `html[data-theme="light"]` 逐条覆盖颜色；浅色差异写在皮肤的浅色块。
- 不要在 JS 里写死颜色（`#fff`、`#101014` 这类）。需要颜色时读计算值：
  `getComputedStyle(document.documentElement).getPropertyValue('--bg')`。
- 不要把主题色当成「皮肤的唯一身份」。要换色就在 `accents` 里加一项。
- 不要在 `index.html` 里画 `<svg>`，图形与线宽都归 `js/icons.js` 与 `--icon-*`。
- 不要用同一个变量表达两种语义（把「画面上压的字」和「页面正文色」都塞进 `--fg`）。
  画面上的文字走 `--media-fg*`，并与 `--media-surface*` 成对改。
- 不要在新容器上重复「`--surface` 底 + `1px solid var(--line)` + `--radius`」三件套，
  套 `--card-*`；图卡用 `--tile-*`。
- 不要给开关、单选点、色板写死宽高，走 `--switch-*` / `--radio-*` / `--swatch-*` / `--skin-dot-*`。
- 不要在皮肤里重列 8 档圆角、3 档时长或 4 档阴影，改 scale 系数；单档微调才覆盖派生变量。
- 不要写 `::-webkit-scrollbar*`。滚动条是悬浮式的，配色只走 `--scrollbar-thumb` / `scrollbar-color`。
- 不要在皮肤里定义 `--font-user` / `--dm-font` / `--sc-bg` 等运行时变量（§7.14）。
- 不要在 `skin.css` 或 `vars` 里写选择器、规则或外链值，清洗器会整条丢弃。
