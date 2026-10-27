# fly-barrage 本地改造清单

`web/vendor/fly-barrage.js` 不是上游原版，是**本地改造后重新构建**的产物。
源码在仓库外的 `../fly-barrage-master/lib/`（该目录与 `node_modules` 都不入库，
只有构建产物进仓库），所以这份清单是唯一的改造记录——换机器或从上游重新拉源码时，
照这里补回去。

上游版本：**fly-barrage 2.5.0**（MIT）。产物全局名仍是 `FlyBarrage`，不要改。

## 改造项

### 1. 固定时长模式（速度模型）

- **`lib/index.ts`**
  - `RenderConfig` 新增 `scrollDuration: number`（毫秒）。`> 0` 表示每条弹幕按
    `(画布宽 + 自身宽) / scrollDuration` 单独算速度；`0` 表示退回老的「全局固定像素速度」。
  - `defaultRenderConfig.scrollDuration = 0`。
  - `setRenderConfigInternal` 的速度变更检测里加上 `scrollDuration`：
    ```ts
    const isSpeedChange =
      (renderConfigKeys.includes('speed') && renderConfig.speed !== this.renderConfig.speed) ||
      (renderConfigKeys.includes('scrollDuration') && renderConfig.scrollDuration !== this.renderConfig.scrollDuration);
    ```
- **`lib/barrage/scroll-barrage.ts`**
  - 新增 `refreshSpeed()`：按 `scrollDuration` 或 `addition.speed`（`pinnedSpeed`）重算 `speed`，
    并把结果记到 `naturalSpeed`（防追尾的下限用它算）。
  - 构造函数改为先 `refreshSpeed()` 再 `calcOriginal()`。
- **`lib/core/index.ts`**
  - `renderConfigChange(isSpeedChange)` 里改为 `barrage.refreshSpeed(); barrage.calcOriginal();`
    ——速度与弹幕自身宽度有关，不能只重算位置。

### 2. 位置比较改成「同一时刻」

- **`lib/barrage/scroll-barrage.ts`**：新增 `leftAt(atMs)` / `rightAt(atMs)`。
- **`lib/core/virtual-track-algorithm.ts`**：`avoidOverlapLayout` / `avoidOverlapInsert` 里所有
  跨弹幕的位置比较，从 `originalLeft` / `originalRight` 改为 `leftAt(refTime)` / `rightAt(refTime)`，
  `refTime` 取「本条弹幕出现的时刻」。

> 原因：`originalLeft` 是「播放时间为 0 时的虚拟位置」，把 `time × speed` 折进了坐标系。
> 全局统一速度时自洽，逐条变速后两条弹幕处在不同速度空间，直接比大小会排错前后关系。

### 3. 防追尾判据重写

- **`lib/core/virtual-track-algorithm.ts` 的 `applyCatchUpSpeedLimit`**

  判据从「后车不早于前车离开画面」改成「后车在前车离开前不能越过前车右边缘」，即
  `v ≤ (canvasWidth - minSpace) / (prevEnd - newStart)`；后车不比前车快时直接返回。
  下限仍保留自身 `naturalSpeed` 的 60%。删掉了原来的 `minSpeed` getter。

> 原因：固定时长下长弹幕更快，只保证「晚离开」挡不住超车——前车 8 秒走完、后车 6 秒走完，
> 中途就会从右侧追上去，视觉上就是两条叠在一起。

### 4. 满轨标记

- **`lib/barrage/scroll-barrage.ts`**：新增 `fallbackTrack = false`。
- **`lib/core/virtual-track-algorithm.ts`**：`avoidOverlapInsert` 里没有虚拟轨道能放下、
  退回 `randomTrackBarrage()` 时置 `true`。

> 播放器侧（`web/js/danmaku.js`）据此把这条撤下不显示，避免「满轨 = 叠字」。

### 5. 预渲染失败的兜底（单字 / emoji 弹幕）

- **`lib/core/pre-render-optimizer.ts`**
  - 裁剪尺寸兜底：`Math.max(1, Math.round(width * dpr))`（0 宽会让 `createImageBitmap` reject）。
  - `createImageBitmap(...).catch(...)`：失败的 id 记进 `skipped`，之后直接走常规 `fillText`，
    不再每帧重试（原来既没有 catch，也不记状态）。
  - `clear()` 同时清空 `skipped`。
- **`lib/barrage/base-barrage.ts`**：`totalWidth <= 0` / `maxHeight <= 0` 时给最小尺寸
  （0 宽还会把轨道高度和速度算成 0）。

## 重新构建

```bash
cd fly-barrage-master
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
npm install --registry=https://registry.npmmirror.com
npx vite build
cp dist/fly-barrage.iife.js ../tauri_simple_live/web/vendor/fly-barrage.js
rm -rf node_modules
```

`danmaku.js` 通过 `window.FlyBarrage.BarrageRenderer` 取渲染器，产物挂载名不要改。
