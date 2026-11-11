# 组件清单 · 按组件查变量

想改某个地方的样子，先在这里找到组件，再去 `web/skins/<id>/skin.css` 改对应变量。
变量契约、作用域与新增皮肤的流程见 [skins.md](skins.md)。

约定：

- 变量都带默认值（`var()` 第二个参数或皮肤里的声明），**不写也能跑**，只是没风格化；
- 标「布局」的量是尺寸与定位，跟容器宽度/平台/安全区有关，**不属于皮肤**；
- 标「运行时」的是 JS 写进去的（比如按用户名算的色相），皮肤只能给兜底值。

## 一、外壳

| 组件 | 选择器 | 变量 |
| --- | --- | --- |
| 标题栏 | `.titlebar` | `--titlebar-bg` `--titlebar-fg` `--titlebar-line`；高度 `--titlebar-height`（布局） |
| 窗口按钮 | `.titlebar-btn` | `--titlebar-btn` `--titlebar-btn-hover` `--titlebar-btn-active` `--icon-stroke-thin` |
| 关闭按钮 | `.titlebar-close` | `--window-close-hover` `--window-close-active` `--window-close-fg` |
| 红绿灯（macOS 形态） | `html[data-titlebar="traffic"] .titlebar-btn` | `--traffic-size` `--traffic-gap` `--traffic-close` `--traffic-min` `--traffic-max` `--traffic-edge` `--traffic-glyph` `--traffic-glyph-size` `--traffic-glyph-stroke`；形态由 registry 的 `titlebar: 'traffic'` 打开 |
| 悬停提示 | `.app-tip` | `--tip-bg` `--tip-fg` `--tip-border` `--tip-shadow` `--tip-radius` `--tip-pad-x` `--tip-pad-y` `--tip-font` `--tip-max-w` |
| 侧栏 | `.rail` `.rail-btn` | `--bg-elev` `--wash-1` `--wash-2` `--fg-muted` `--accent`（选中态）；宽度 `--rail-width`（布局） |
| 顶栏 | `.topbar` | `--bg` `--line`；高度 `--topbar-height`（布局） |
| 平台标签 | `.platform-tab` | `--tab-pad-x` `--tab-font` `--tab-gap` `--muted`（未选中）`--fg`（选中） |
| 标签下的色条 | `.tab-underline` | `--tab-underline-h` `--tab-underline-bg` `--tab-underline-radius`；内缩 `--tab-underline-inset`（布局） |
| 平台图标 | `.platform-img` | `--platform-logo-radius` `--img-placeholder` |
| 滚动条 | `::-webkit-scrollbar-thumb` | `--scrollbar-thumb` `--scrollbar-thumb-hover` |

## 二、按钮与表单控件

| 组件 | 选择器 | 变量 |
| --- | --- | --- |
| 按钮 | `.btn` | `--btn-h` `--btn-pad-x` `--btn-radius` `--btn-font` `--btn-weight`；底色 `--surface-2`，hover `--surface-3` |
| 主按钮 | `.btn.primary` | `--accent` `--accent-on` `--btn-on-weight` |
| 次按钮 / 危险 | `.btn.ghost` `.btn.danger` | `--muted` `--surface-2`；`--danger-soft` `--danger` |
| 小按钮 | `.btn.small` | `--btn-small-h` `--btn-small-pad-x` `--btn-small-font` `--btn-small-radius` |
| 图标按钮 | `.icon-btn` | `--radius-md` `--muted` `--surface-2`；选中 `--accent` `--accent-soft` |
| 胶囊按钮 | `.chip` | `--radius-pill` `--muted` `--line-strong` `--surface` `--surface-2` |
| 输入框 | `.input` `textarea` | `--bg-elev` `--line-strong` `--fg` `--radius-md`；聚焦 `--accent`；占位 `--dim` |
| **开关** | `.switch` | `--switch-w` `--switch-h` `--switch-pad` `--switch-knob-size` `--switch-travel` `--switch-radius` `--switch-knob-radius` `--switch-off` `--switch-on` `--switch-knob` `--switch-knob-off` `--switch-knob-shadow` `--switch-dur` `--switch-ease` |
| **单选点** | `.radio` | `--radio-size` `--radio-ring` `--radio-radius` `--radio-dot` `--radio-dot-radius` `--radio-line` `--radio-line-on` `--radio-dot-fill` |
| **主题色色板** | `.swatch` | `--swatch-size` `--swatch-radius` `--swatch-ring` `--swatch-check-w` `--swatch-check-h` `--swatch-check-stroke` `--swatch-check-on` |
| 分段按钮 | `.segmented` `.sc-view-nav button` | `--seg-h` `--seg-pad-x` `--seg-radius` `--seg-font` `--seg-bg` `--seg-fg` `--seg-on-bg` `--seg-on-fg` |
| 自绘下拉按钮 | `.select-btn` | `--radius-sm` `--muted` `--surface-2` |
| 下拉菜单 | `.menu` `.menu-item` | `--surface-menu` `--line-strong` `--shadow-2` `--panel-blur` `--radius` `--radius-sm`；选中 `--accent` |
| 弹窗 | `.modal` | `--surface-overlay` `--line-strong` `--radius-lg` `--shadow-3` `--panel-blur`；遮罩 `--scrim` `--blur-overlay` |
| 提示条 | `.toast` | `--toast-bg` `--toast-fg` `--toast-border` `--shadow-3` `--radius-md` |

开关和单选是**整组尺寸都归皮肤**的：方形开关、细长开关、小圆点单选都只改这几个值，不用碰组件 CSS。

## 三、容器：卡片与列表

这一组决定「一块内容被包成什么样」。同一个 `.settings-group`，可以是卡片，也可以是一条条列表。

| 组件 | 选择器 | 变量 |
| --- | --- | --- |
| 分组容器 | `.settings-group` | `--card-bg` `--card-border` `--card-radius` `--card-shadow` |
| 分组里的行 | `.setting-row` | `--row-divider` `--row-pad-x` `--row-pad-y` `--row-min-h` `--row-hover` |
| 一级设置项 | `.settings-item` | `--card-*` `--row-hover` |
| 工具卡 / 动作卡 / 统计卡 | `.tool-card` `.settings-action-card` `.stats-card` | `--card-*` `--card-gap` |
| 信息表 | `.info-table` `.info-table > div` | `--card-*` `--row-divider` |
| 列表行 | `.stats-row` `.anchor-card` `.follow-card` `.chat-follow-card` `.lan-peer` `.sc-history-item` | `--card-*` `--row-hover` |
| **图卡**（首页/分类） | `.room-card` `.category-item` `.category-icon` | `--tile-bg` `--tile-border` `--tile-radius` `--tile-shadow` |
| 皮肤卡片 | `.skin-card` | `--card-bg` `--card-radius` `--card-shadow` `--row-hover`；选中 `--accent` `--accent-soft` |
| 空状态 | `.empty-icon` | `--surface` `--dim` `--radius-xl` |
| 分组间距 | `.settings-group-label` `.settings-group + .settings-group` | `--group-gap`（组与组）/ `--group-label-bottom`（标题与卡片）|

## 四、页面内容

| 组件 | 选择器 | 变量 |
| --- | --- | --- |
| 封面 | `.cover` `.cover-img` | `--cover-bg-a` `--cover-bg-b` `--cover-scrim` `--radius-sm` |
| 封面加载失败 | `.cover-fallback` | `--cover-fallback-a` `--cover-fallback-b` `--cover-fallback-fg` `--accent-glow` |
| 封面角标 | `.cover-chip` | `--cover-chip` `--cover-chip-fg` |
| 头像 | `.avatar` `.avatar-text` | `--avatar-fg` `--avatar-sat` `--avatar-light`；色相 `--avatar-hue`（运行时） |
| 直播中圆点 | `.dot-live` `.chat-follow-dot` | `--success` `--success-soft`（尺寸固定，属几何） |
| 骨架屏 | `.skeleton` | `--surface` `--shimmer` `--radius-2xs` |
| **筛选分段**（关注页「按状态 / 按平台」）| `.follow-mode` / `.follow-mode button` | 槽 `--seg-bg` `--seg-inset` `--seg-gap` `--seg-track-radius` `--seg-track-line`；按钮 `--seg-h` `--seg-pad-x` `--seg-radius` `--seg-font` `--seg-fg` `--seg-hover-fg`；选中 `--seg-pick-bg` `--seg-pick-fg` `--seg-pick-shadow` |
| **视图分段**（观看记录「记录 / 统计」、统计的周月年）| `.segmented` / `.segmented button` | 同上一行 |
| **胶囊标签**（关注页的「全部 / 直播中」、分类与搜索的快捷标签）| `.chip` `.chip.active` `.chip.solid` | `--chip-h` `--chip-pad-x` `--chip-radius` `--chip-font` `--chip-bg` `--chip-fg` `--chip-line` `--chip-shadow`；hover `--chip-hover-bg` `--chip-hover-fg`；选中 `--chip-on-bg` `--chip-on-fg` `--chip-on-line`；实心变体 `--chip-solid-bg` |

## 五、直播间

| 组件 | 选择器 | 变量 |
| --- | --- | --- |
| 房间外壳 | `.room-page` | `--room-bg` `--stage-backdrop` |
| 顶栏（自动隐藏） | `.room-topbar` | `--media-chip` `--media-chip-hover` `--media-fg` `--media-fg-muted` `--media-text-shadow` `--media-blur` |
| 播放控制条 | `.player-controls` | `--media-fade-bottom` `--media-surface` `--media-line` `--media-track` `--media-fg` `--media-fg-muted` |
| 聊天栏 | `.room-chat` `.chat-tabs` | `--room-panel` `--room-line` `--fg` `--fg-muted`；宽度 `--chat-width`（运行时） |
| 聊天标签 | `.chat-tab` | `--fg-muted` `--fg` `--accent` `--tab-underline-*` |
| 聊天输入 | `.chat-input` | `--room-field` `--room-line` `--fg` `--accent` |
| 设置面板 | `.chat-settings` `.chat-settings-group` | `--card-*` `--room-field` `--room-line` `--radius-xs` `--accent` |
| 自绘下拉 | `.chat-setting-select` | `--room-field` `--room-line` `--radius-xs` `--fg` |
| 底部动作栏 | `.room-actions` | `--room-bar` `--room-line` `--fg-muted` |
| 音量浮层 | `.volume-pop` | `--media-surface` `--media-line` `--media-shadow` `--media-fg` |
| 同屏 | `.dual-panel` | `--room-line` `--media-surface` `--media-line`；遮罩 `--mask-solid`（布局） |
| 直播间浮层 | `.room-float` | `--room-float-bg` `--room-float-fg` `--room-float-line` `--room-float-shadow` |
| 展开聊天区 | `.chat-expand` | `--room-float-bg` `--room-float-fg` `--room-float-line`；悬停 `--room-float-hover-bg` `--room-float-hover-fg`（它压在视频画面上，不能用 `--wash-*`） |

## 六、SC（醒目留言）

| 组件 | 选择器 | 变量 |
| --- | --- | --- |
| 聊天里的 SC 条 | `.chat-line.sc` | `--sc-msg-radius` `--sc-msg-pad-y` `--sc-msg-pad-x` `--sc-border-w` `--sc-shade` `--sc-chat-fg` `--sc-line`；底色 `--sc-bg`（运行时，平台档位色） |
| SC 大卡 | `.sc-card` | `--sc-radius` `--shadow-1` `--on-sc` `--on-sc-strong` `--on-sc-weak` `--on-sc-ring` `--on-sc-hover` `--on-sc-shadow` |
| 正在显示 / 历史 | `.sc-view-nav button` | `--seg-*` |
| 历史条目 | `.sc-history-item` | `--card-*` `--fg-subtle` |

`--sc-shade` 是压在平台档位色上的遮罩：深色主题给一层黑（不然浅金浅粉在暗聊天区里像戳了个白洞），
浅色主题给 `transparent`。切换明暗时它由 CSS 直接重算，**不用重绘聊天栏**——
所以组件里不能再写 `html[data-theme="dark"] .chat-line.sc` 这种逐条覆盖。

## 七、媒体层（压在视频上的东西）

顶栏、控制条、音量浮层、小窗、加载提示、SC 浮卡都浮在画面上。默认是白字 + 半透明黑底，
亮画面暗画面都读得出来；但这一组变量全部归皮肤，浅色不透明浮层也一样做得出来，
不需要动组件样式。改的时候记住：**底色和字色必须成对翻**。

| 变量 | 用途 |
| --- | --- |
| `--media-bg` `--media-surface` `--media-surface-strong` `--media-surface-hover` | 画面上的底，以及卡片悬停时的底色 |
| `--media-chip` `--media-chip-soft` `--media-chip-hover` `--media-chip-active` | 画面上的胶囊（返回、更多、小窗） |
| `--media-fg` `--media-fg-muted` `--media-fg-dim` `--media-fg-faint` | 画面上的四级文字 |
| `--media-line` `--media-line-strong` | 画面上的描边 |
| `--media-topbar-bg` | 顶栏整条的底色（默认透明，只留胶囊） |
| `--media-bar-line` | 顶栏底边、控制条顶边的一道分隔线（inset 阴影，不占高度） |
| `--media-accent` `--media-on-accent` | 画面上的高亮色，以及实心按钮上的字色 |
| `--media-shadow` `--media-text-shadow` `--media-halo` | 投影与文字描影 |
| `--media-track` | 画面上滑条的轨道 |
| `--media-fade-top` `--media-fade-bottom` `--media-fade-side` | 上下/侧边的渐隐（填纯色即硬边条） |
| `--media-blur` | 胶囊与卡片的毛玻璃 |

SC 浮卡的文字不走 `--media-*`：卡片底色是平台档位色，字色由 `--on-sc` / `--on-sc-strong` /
`--on-sc-weak` 这一组定，同样是皮肤变量。

## 八、图标

| 变量 | 作用 |
| --- | --- |
| `--icon-stroke` | 线宽（默认 1.75） |
| `--icon-stroke-thin` | 窗口按钮那 10×10 的小图标线宽 |
| `--icon-cap` `--icon-join` | 线端与拐角（`round` / `square` / `butt`） |

图形本身也能整套换：`skins/<id>/icons.js` 导出 `ICON_PATHS`，只写要覆盖的名字，
并在 `registry.js` 里给这套皮肤标 `icons: true`。切皮肤时会就地重画已渲染的图标
（侧栏、标题栏这些外壳不会跟着页面重渲染，靠的是这个就地重画）。

会用到 `--icon-stroke` 的地方：侧栏四项（首页 / 关注 / 分类 / 设置）、页面标题的返回、
列表行与设置行的箭头、控制条的播放/音量/弹幕/小窗/全屏、画面上的更多/分享/关注、
聊天栏标签页、`settings.js` 里各分组的小图标。**换图形只改 `ICON_PATHS`，不要动这些组件。**

可以覆盖的名字以 `web/js/icons.js` 的 `PATHS` 为准（`home` `follow` `followFilled` `grid`
`settings` `search` `back` `chevron` `refresh` `play` `volume` `fullscreen` `screen`
`danmaku` `more` `share` `link` `copy` `send` `star` `tag` `close` `check` `history`
`account` `sync` `moon` `sun` `contrast` `download` `upload` `shield` `info` `live`…）。
写了不存在的名字不会生效，`check-skin` 会直接报错。

苹果皮肤的 `skins/apple/icons.js` 是一份现成例子：关注是心形而不是四角星、
返回只留一条 chevron、更多是横排三点、分享是「方块 + 上箭头」、设置齿轮改成平齿。

## 九、字体与动效

| 变量 | 作用 |
| --- | --- |
| `--font` `--font-display` `--font-mono` | 正文 / 标题与数字 / 等宽 |
| `--dur-fast` `--dur-base` `--dur-slow` | 三档时长（0.15s / 0.22s / 0.32s 量级） |
| `--ease` | 统一缓动 |

## 十、悬停提示

所有 `title` 都被 `js/tooltip.js` 接管：悬停 420ms 后在元素下方画一个 `.app-tip` 气泡，
原生那个系统白框不会再出现。气泡的配色就是上面外壳表里的 `--tip-*`，所以换皮肤时
它会跟着一起变（浅色皮肤给白底细边，深色皮肤给深色气泡）。

写新按钮时照旧写 `title="…"` 即可，不需要额外属性；纯图标按钮如果原本靠 title 当可读名字，
接管时会自动补一个 `aria-label`。

## 附：几个现成的「形态配方」

### 1. 设置页从卡片改成系统设置那样的列表

```css
--card-bg: transparent;
--card-border: none;
--card-radius: 0;
--card-shadow: none;
--card-gap: 0;
--row-divider: 1px solid var(--line);
--row-hover: var(--wash-1);
```

分组自动变成「一条分隔线接一条」，`.tool-card` / `.stats-card` / `.info-table` 一起跟着变。

### 2. 分段控件做成两种流派

```css
/* iOS 式：灰槽 + 白色滑块 + 轻投影 */
--seg-bg: rgba(118, 118, 128, 0.12);
--seg-track-line: 1px solid transparent;
--seg-track-radius: 12px;
--seg-radius: 9px;
--seg-pick-bg: #ffffff;
--seg-pick-fg: #1d1d1f;
--seg-pick-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);

/* 工具式：透明槽 + 选中用主题色填充 */
--seg-bg: transparent;
--seg-track-line: 1px solid var(--line);
--seg-track-radius: 2px;
--seg-radius: 2px;
--seg-pick-bg: var(--accent);
--seg-pick-fg: var(--accent-on);
--seg-pick-shadow: none;
```

想让标签也一样方，把 `--chip-radius` 调到同一个值、`--chip-line` 留住描边即可。

### 3. 首页/分类的图卡也做成带底框的卡片

```css
--tile-bg: var(--card-bg);
--tile-border: var(--card-border);
--tile-shadow: var(--card-shadow);
--tile-radius: var(--card-radius);
```

反过来 `--tile-radius: 0` 就是方角图卡。

### 4. 方正、密集的「工具软件」形态

```css
--radius-2xs: 1px;  --radius-xs: 2px;   --radius-sm: 2px;
--radius-md: 2px;   --radius: 3px;      --radius-lg: 4px;
--radius-xl: 6px;   --radius-pill: 4px;
--btn-h: 30px;      --btn-radius: 2px;
--switch-radius: 4px;  --switch-knob-radius: 2px;
--radio-radius: 3px;   --radio-dot-radius: 1px;
--tab-underline-radius: 0;
--icon-cap: butt;   --icon-join: miter;   --icon-stroke: 1.6;
```

### 5. 大圆角、松软的形态

```css
--radius-md: 14px;  --radius: 18px;  --radius-lg: 24px;
--btn-h: 40px;      --btn-radius: var(--radius-pill);
--switch-w: 52px;   --switch-h: 30px;   --switch-knob-size: 24px;
--radio-size: 24px; --radio-dot: 12px;
--card-gap: 18px;   --row-pad-y: 15px;  --row-min-h: 68px;
```

### 6. 触屏 / 平板（更大点击区）

```css
--btn-h: 42px;  --btn-small-h: 36px;
--row-min-h: 72px;
--seg-h: 34px;  --seg-font: 13px;
--tab-font: 16px;
```

### 7. 白色不透明浮层（瑞士风那类）

把媒体层整组翻成白底黑字：顶栏与控制条换成纯色条 + 一道实线，
胶囊去掉毛玻璃，文字阴影关掉。浅底配浅色主题色会看不清，所以 `--media-accent`
单独换成能在白底上读的颜色（这里用红），实心按钮上的字反过来给白色。

```css
--media-topbar-bg: #ffffff;
--media-fade-top: #ffffff;
--media-fade-bottom: #ffffff;
--media-bar-line: #111111;
--media-surface: #ffffff;
--media-surface-strong: #ffffff;
--media-surface-hover: #f0f0f0;
--media-chip: #f2f2f2;
--media-chip-soft: #ececec;
--media-chip-hover: #e2e2e2;
--media-chip-active: #111111;
--media-fg: #111111;
--media-fg-muted: #444444;
--media-fg-dim: #777777;
--media-fg-faint: #aaaaaa;
--media-line: #111111;
--media-line-strong: #111111;
--media-track: #d4d4d4;
--media-halo: transparent;
--media-shadow: none;
--media-text-shadow: none;
--media-blur: none;
--media-accent: #e4002b;
--media-on-accent: #ffffff;
```

改完跑一次：

```
node tools/check-skin.mjs
```
