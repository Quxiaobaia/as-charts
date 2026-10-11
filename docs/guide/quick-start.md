# 快速上手

## 安装

```bash
npm install as-charts
```

零运行时依赖，同时提供 ESM 与 CJS：

```ts
import { Renderer, Dirty } from 'as-charts';
```

要求 `node >= 22.22.1`（构建期，由 `lint-staged 17` 与 `vitest 5` 的引擎约束决定，见 `.nvmrc`）。运行时只要求浏览器支持 WebGL2——**不提供 WebGL1 回退**，理由见[定位与取舍](/guide/positioning)。

## 最小可用示例

```ts
import { Renderer, Dirty } from 'as-charts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('canvas missing');

const renderer = new Renderer({ canvas });
const layer = renderer.addTriangleLayer({ initialCapacity: 4096, label: 'spikes' });

layer.setInstance(0, 32, 48, 6, 1, 0, 0);
renderer.request(Dirty.Data);
```

`Renderer` 自己拥有 rAF 循环，你只负责声明"什么变了"。**不要**在每帧里无条件调用 `request()`——那会把脏标记模型的收益全部抹掉。

## 尺寸与 devicePixelRatio

CSS 尺寸始终由你控制，引擎只改 `canvas.width/height`，因此永远不会和布局打架：

```ts
const renderer = new Renderer({
  canvas,
  // 默认跟随平台，但受 maxPixels（默认 800 万）钳制
  devicePixelRatio: true,
  maxPixels: 4_000_000,
});

// 从元素当前 CSS 盒子同步。会触发 layout，务必防抖。
let timer = 0;
const scheduleResize = (): void => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => renderer.resize(), 12);
};
new ResizeObserver(scheduleResize).observe(canvas);
```

4K 面板的环境 DPR 是 3，意味着九倍的光栅化开销换取无人能分辨的细节。像素预算把这层保护变成默认行为，而不是留给调用方去踩。

## 可见性

`IntersectionObserver` 是调用方的职责——引擎不知道你的布局：

```ts
new IntersectionObserver(
  (entries) => {
    for (const entry of entries) renderer.setVisible(entry.isIntersecting);
  },
  { threshold: 0 },
).observe(canvas);
```

不可见时**不会**丢弃脏标记，重新可见时也不会用隐藏期间累积的时间差去污染动画。这两件事是"切回标签页后图表卡死"的根因。

## 读取运行状态

```ts
const stats = renderer.stats();

stats.drawCalls; // 上一帧真实发出的 GL 绘制次数
stats.frameCount; // 累计渲染帧数
stats.scheduler.pending; // 当前是否有帧已排期
stats.scheduler.framesRequested; // 请求次数
stats.scheduler.framesRendered; // 实际渲染次数
stats.scheduler.skippedByFpsCap; // 被帧率闸门拦下
stats.scheduler.skippedInvisible; // 被可见性闸门拦下
stats.scheduler.skippedClean; // 因为不脏而省掉的
stats.scheduler.lastDelta; // 上一帧的间隔（已做 50ms 钳制）
stats.resources.live; // 存活 GPU 对象数
stats.resources.bytes; // 显存占用估算
```

四个 `skipped*` 计数器的和越大，说明调度器省掉的活越多。

## 销毁

```ts
renderer.destroy(); // assertClean 默认为 true，泄漏即抛错
```

不要省略这一步。`assertClean` 默认开启是刻意的：安静地泄漏显存正是整套资源账本要防的失效模式。

## 在线演练场

仓库自带一个演练场，把上面每个数字都做成实时读数：

```bash
npm run dev   # http://localhost:5178
```

![演练场](/playground.png)

上图是 8,000 个标记的默认状态：右下角 `drawCalls` 恒为 **1**，`live 对象` 为 **4**（两个 buffer + 一个 VAO + 一个 program）。

- **单个 draw call**：标记数从 500 拉到 60 000，`drawCalls` 恒为 1。网格按数量自动推导，所以数量增长读起来是"同一幅图采样更细"，而不是重叠成摩尔纹。
- **脏标记模型**：点"停止写入数据"后，`framesRequested` 不再增长——不是 `drawCalls` 归零，而是连帧都不再排期。`pending` 转为"否"，动画循环彻底空转停止。
- **帧率闸门**：切到 10 fps，`skippedByFpsCap` 开始增长，而标记仍在移动（工作被推迟，而不是被丢弃）。
- **可见性闸门**：把画布滚出视野，`skippedInvisible` 增长；滚回来时工作一次性补齐。
