# 性能门禁

## 一条分界线

把性能断言分成两类，因为它们的可信度根本不同：

| 类别           | 例子                                                | CI 里的处理                                     |
| -------------- | --------------------------------------------------- | ----------------------------------------------- |
| **A · 结构性** | drawCall 数、存活资源数、上传字节数、着色器输出哈希 | **硬断言**。与 GPU 无关，任何机器上都应完全相同 |
| **B · 时间类** | 帧时间、CPU 每帧耗时                                | 只做**相对基线**回归，容差 ±15%                 |
| **C · 绝对值** | 真实 GPU 上的吞吐                                   | 不进 CI，单独在指定硬件上跑                     |

SwiftShader 与真实 GPU 的墙钟时间能差几个数量级，但它们对"`drawArraysInstanced` 被调用了几次"完全一致。这就是为什么 A 类可以是硬断言，而 B 类永远只能是相对回归。

## 四个结构性门禁

### 1. drawCall 预算

```ts
renderer.stats().drawCalls; // 上一帧真实发出的 GL 绘制次数
```

这个计数器的语义很重要：它统计的是**真实的 GL 调用**，而不是"遍历了几个图层"。空图层必须产生 0 次调用，否则预算就没有意义了。

```ts
const layer = renderer.addTriangleLayer();
renderer.renderNow();
expect(renderer.stats().drawCalls).toBe(0); // 没有数据就不画
```

16 图表的看板断言不超过 **32** 次调用（每图一至两次）。

### 2. `destroy()` 零泄漏

```ts
expect(() => renderer.destroy()).not.toThrow(); // assertClean 默认为 true
expect(renderer.stats().resources.live).toBe(0);
```

以及：上下文丢失后 `destroy()` 同样干净（账本被清空而非半填充）；链接失败时必须先释放程序再抛错，使账本重新为空。

### 3. 每帧零分配

单次 8 ms 的 GC 停顿就足以打爆 16.7 ms 帧的 p99 预算，所以这条是断言出来的，不是靠代码审查保证的。

两个设计决定让这个测试可信：

**差分测量。** 渲染循环与空循环用同样的方式测量，只判断差值。这抵消了测量框架自身的开销——它通常比被测效应还大。

```ts
const baseline = growthOver(ITERATIONS, () => undefined);
const rendered = growthOver(ITERATIONS, () => renderer.renderNow());
const perFrame = (rendered - baseline) / ITERATIONS;
expect(perFrame).toBeLessThan(8); // 字节/帧
```

**测量本身也要被测。** 一个刻意分配的循环必须超过阈值，否则门禁一旦悄悄失效就会永远通过。

```ts
it('detects allocation when it exists', () => {
  // 守卫守卫者
  expect(perFrame).toBeGreaterThan(BUDGET_BYTES_PER_FRAME);
});
```

实测值：渲染帧 **−0.1 B/帧**，写实例 **1.2 B/帧**（预算 8）。

#### 这条门禁抓到过的真实问题

第一次跑就失败了，报 73.5 B/帧与 379 B/帧。三个来源，全部是真实的：

1. `subarray()` 每帧创建一个 TypedArray 视图对象。
2. `for (const x of array)` 每帧为每个循环创建一个迭代器对象（渲染帧里有两个这样的循环）。
3. 记录式 WebGL mock 为**每次** GL 调用构造参数数组——在 `record: false` 时也构造。

第三点是测量框架自身的问题，但它的量级比被测对象还大，因此必须修：热路径上的 mock 方法改为只递增计数器，仅在录制开启时才构造 `MockCall`。`draws` / `uploads` 遵守同一条规则——一个每帧增长一个元素的数组，本身就是每帧成本。

### 4. 着色器输出确定性

组装是纯函数，所以同样的选项必须产出逐字节相同的源码与哈希。这既是快照测试的对象，也是程序缓存键的基础。

```ts
composer.compose({ enabled: ['base', 'tint'] });
composer.compose({ enabled: ['tint', 'base'] }); // 相同输出
```

## 真实的 GPU 冒烟测试

结构性门禁跑在 mock 上，因此它们**无法**告诉你组装出的 GLSL 是否真的能编译、VAO 是否真的捕获了实例属性、投影是否把像素放在了调用方要求的位置。

所以我们另外在真实 WebGL2 上（CI 里是 SwiftShader）跑一次完整链路，并把帧缓冲读回来：

```bash
npm run e2e    # 自行启动 dev server，跑完后关闭
```

它同步执行，没有动画循环——`requestAnimationFrame` 循环叠加 `--virtual-time-budget` 是把 headless 渲染进程搞崩的方式。

`e2e` **不在** `npm run check` 里：它需要一个浏览器，而浏览器是个活动的部件。`check` 绝不能依赖浏览器。

断言的是像素，不是内部状态：

| 检查        | 实测        | 说明                                             |
| ----------- | ----------- | ------------------------------------------------ |
| 红/蓝像素数 | 512 / 512   | 32×32÷2，与三角形面积精确一致                    |
| 红/蓝质心 X | 15.5 / 47.5 | 与 offset 16/48 一致（含半像素采样）             |
| 红质心 topY | 26.16       | 32 − 16/3 = 26.67 → **y 翻转恰好做了一次**       |
| drawCalls   | 1           | 真实驱动上的单次实例化调用                       |
| 资源账本    | 4 → 0       | program×1 + buffer×2 + VAO×1，`destroy()` 后归零 |

最后一行里的 y 翻转检查尤其值得留：画布约定是 y 向下（与鼠标事件一致），GL 是 y 向上，而 `readPixels` 从底部数行。翻转漏做或做了两次，都会把色块挪到 offset 下方，这是纯内部状态断言抓不到的。

## 相关命令

```bash
npm run check        # typecheck + lint + format:check + test
npm run test         # 单元与结构性门禁
npm run test:coverage
npm run e2e          # 真实 WebGL2 像素冒烟（自带 dev server）
```

B 类（时间基准）目前尚未接入：它需要一段足够长的采样窗口和一台稳定的参照机，在 [M1](/roadmap) 里连同折线管线一起落地。
