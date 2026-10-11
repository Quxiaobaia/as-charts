# 测试基础设施

性能设计把 drawCall 数、`destroy()` 零泄漏与每帧零分配放进 CI 作为**硬断言**。这件事之所以可能，是因为它们都不需要 GPU。支撑它的有三个部件。

## 记录式 WebGL2 mock

`tests/utils/mock-gl.ts` 提供一个纯 JS 的 WebGL2 上下文替身：

```ts
const mock = createMockGL({ extensions: ALL_EXTENSIONS });
const canvas = createMockCanvas(mock, { clientWidth: 300, clientHeight: 150 });
const renderer = new Renderer({ canvas: canvas.canvas, diagnostics: 'silent', host: clock.host });

mock.created['buffer']; // 按种类统计的创建数
mock.deleted['vertexArray']; // 泄漏表现为一个数字，而不是二十分钟后的变慢
mock.draws; // 每次 drawArraysInstanced 的实例数，按调用顺序
mock.uploads; // 每次上传的字节数
mock.counts['vertexAttribPointer']; // VAO 重捕获是否真的发生了
mock.counts['vertexAttribIPointer']; // uint 属性走的是不是整数入口
mock.textures; // 每次 texImage2D 的 {width, height, texels}
mock.subImages; // 每次 texSubImage2D 的区域
```

两处刻意保持严格：

- `getUniformLocation` 对未声明为 active 的 uniform 返回 `null`，让"uniform 被优化掉了"这条路径真的被走到。
- 每个 create/delete 都按种类计数。

### 读取上传上去的**字节**，而不是只读大小

零拷贝上传走的是五参数形式 `bufferSubData(target, 0, view, srcOffset, length)`，
所以 mock 把源视图记录在 `args[3]`，而 `args[0..2]` 保持原来的含义（目标、偏移、字节数）——
已有的体积断言不受影响。测试据此断言"传上去的字节确实长这样"，例如孤立点的退化线段
必须是 `A == B`、per-instance 的颜色与 id 必须在正确的字偏移上。

`vertexAttribIPointer` 的日志同理：`vertexAttribPointer` 会把整数转成 float，
而 float32 装不下 2²⁴ 以上的 id，所以"id 用的是整数入口"这条只能靠 mock 记录来断言。

### `record: false` 是一个真正的"只计数"模式

`note()` 为每次调用构造一个参数数组。在每帧零分配门禁里，这个数组比被测效应还大——门禁会报出测量框架的数字，而不是引擎的数字。

因此热路径上的那十来个方法（`useProgram`、`uniform*`、`bindBuffer`、`bufferSubData`、`bindVertexArray`、`drawArraysInstanced`、`viewport`、`clear*`）改为递增一个数字计数器，仅在录制开启时才构造 `MockCall`。`draws` / `uploads` 遵守同一规则：一个每帧增长一个元素的数组本身就是每帧成本。

## 确定性假时钟

`FrameScheduler` 的行为全部关于"帧在什么时候发生或不发生"。用真实的 `requestAnimationFrame` 去断言这件事，会写出随机器负载通过或失败的测试。

`tests/utils/fake-clock.ts` 把每个 tick 变成一个显式的、可观察的步骤：

```ts
const clock = createFakeClock();
scheduler.request(Dirty.Data);
clock.frame(); // 前进 16.67 ms 并投递已排期的回调
clock.frame(5000); // 模拟从后台标签页切回来
expect(clock.delivered).toBe(1);
```

一个关键细节：批量投递前先快照队列。重新排期的回调落到**下一批**，与 `requestAnimationFrame` 的真实行为一致。否则"渲染回调里再请求一帧"这类逻辑会得到错误的顺序。

## 差分分配测量

`tests/utils/allocation.ts` 把渲染循环与空循环用同样的方式测量，只判断差值：

```ts
const baseline = growthOver(ITERATIONS, () => undefined);
const rendered = growthOver(ITERATIONS, () => renderer.renderNow());
const perFrame = (rendered - baseline) / ITERATIONS;
```

这抵消了测量框架自身的记账开销——它通常比被测效应还大。

同时这个测量本身也被测：一个刻意分配的循环必须超过阈值，否则门禁一旦悄悄失效就会永远通过。

### 强制 GC 不是优化，是这条门禁成立的前提

最初这里写的是"运行时可暴露 `global.gc` 时会主动触发；没有时数字更噪"。**这个说法是错的**，
而且错得危险：没有强制 GC 时，同一段**零分配**的闭包在多次运行里读出 **0 / 33 / 63 / 74 B/帧**。

它不是"灵敏度下降"，而是**灵敏度反向** —— 读到 33 的那次会让一个真正在做分配的实现通过。
所以现在 `vitest.config.ts` 里写死 `execArgv: ['--expose-gc']`，
并且 `tests/allocation.test.ts` 有一条**守卫测试**断言 `globalThis.gc` 存在。
测量方法静默退化回噪声这件事，必须是一个响亮的失败。

### 三次取最小，而不是取平均

噪声在平坦路径上是**单边**的：垃圾只会把读数抬高，不会压低。
因此最小值是远比平均值好的估计量，而且仍能发现真实泄漏 —— 泄漏在每一次试验里都会出现。
每次试验各自重新测一次基线，避免基线漂移被算进被测效应。

实测（预算 8 B/帧）：渲染帧 **0.156 B/帧**、降采样视图 **0 B/帧**、写实例 1.2 B/帧。

## 测试布局

```
tests/dirty.test.ts            传播链与位运算
tests/frame-scheduler.test.ts  四个调度机制 + 两处具名回归守卫
tests/shader-composer.test.ts  每条错误路径
tests/shader-snapshot.test.ts  输出字节的确定性
tests/resource-pool.test.ts    账本不变量
tests/renderer.test.ts         结构性门禁接到真实 renderer 上（含折线图层接线）
tests/allocation.test.ts       每帧零分配
tests/capabilities.test.ts     能力探测与 DPR 预算
tests/diagnostics.test.ts      级别语义与去重
tests/id-space.test.ts         C1 分配半边：不重叠、可复用、超限降级
tests/draw-list.test.ts        C2 合批：边界、id 区间、`instanceFirst` 不变量
tests/line-shader.test.ts      双通道结构门禁：剥掉唯一接缝后逐字节相同
tests/line-layer.test.ts       折线几何与两条通道的段枚举
tests/transform.test.ts        投影约定与 project/unproject 互逆关系
tests/data-*.test.ts           数据层六模块（刻度与 d3 对拍）
tests/e2e/pipeline.{html,ts}   真实 GPU 像素冒烟 · 三角形（npm run e2e）
tests/e2e/line.{html,ts}       真实 GPU 像素冒烟 · 折线双通道
tests/utils/                   mock、假时钟、分配测量、测试 setup
```

`tests/setup.ts` 为 Node 装一个**永不触发**的 `requestAnimationFrame` 垫片：注入自己时钟的测试不需要它，其余测试只需要"有一个"以免构造 renderer 时崩在缺失的全局上。它刻意不触发回调——否则"这一帧发生了吗"就不再是一个明确的问题，一类漏帧 bug 会被掩盖。
