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
```

两处刻意保持严格：

- `getUniformLocation` 对未声明为 active 的 uniform 返回 `null`，让"uniform 被优化掉了"这条路径真的被走到。
- 每个 create/delete 都按种类计数。

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

`tests/allocation.test.ts` 把渲染循环与空循环用同样的方式测量，只判断差值：

```ts
const baseline = growthOver(ITERATIONS, () => undefined);
const rendered = growthOver(ITERATIONS, () => renderer.renderNow());
const perFrame = (rendered - baseline) / ITERATIONS;
```

这抵消了测量框架自身的记账开销——它通常比被测效应还大。

同时这个测量本身也被测：一个刻意分配的循环必须超过阈值，否则门禁一旦悄悄失效就会永远通过。

运行时可暴露 `global.gc`（`node --expose-gc`）时会主动触发；没有时数字更噪，因此阈值写成"每帧多少字节"而不是绝对量，灵敏度自检依然有效。

## 测试布局

```
tests/dirty.test.ts            传播链与位运算
tests/frame-scheduler.test.ts  四个调度机制 + 两处具名回归守卫
tests/shader-composer.test.ts  每条错误路径
tests/shader-snapshot.test.ts  输出字节的确定性
tests/resource-pool.test.ts    账本不变量
tests/renderer.test.ts         结构性门禁接到真实 renderer 上
tests/allocation.test.ts       每帧零分配
tests/capabilities.test.ts     能力探测与 DPR 预算
tests/diagnostics.test.ts      级别语义与去重
tests/e2e/pipeline.{html,ts}   真实 GPU 像素冒烟（npm run e2e）
tests/utils/                   mock、假时钟、测试 setup
```

`tests/setup.ts` 为 Node 装一个**永不触发**的 `requestAnimationFrame` 垫片：注入自己时钟的测试不需要它，其余测试只需要"有一个"以免构造 renderer 时崩在缺失的全局上。它刻意不触发回调——否则"这一帧发生了吗"就不再是一个明确的问题，一类漏帧 bug 会被掩盖。
