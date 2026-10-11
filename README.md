# as-charts

面向**超大数据量科研绘图**与**工业实时监控**的 WebGL2 图表引擎。

零运行时依赖 · 仅 WebGL2 · 数据保真优先于帧率 · 结构性性能门禁进 CI

> **状态：M0（内核骨架）。** 帧管线、资源账本、着色器组装与四条结构性门禁已完整可测，几何侧只有一个三角实例化管线。折线、坐标轴、拾取在 [M1/M2](docs/roadmap.md) 里。版本号停在 `0.0.0` 表示**尚未发布**。
>
> **仓库** <https://github.com/Quxiaobaia/as-charts> · npm 发布名 `as-charts` 已确认可用（尚未发布）。

---

## 定位

**垂直场景的完整方案**，对标 LightningChart JS 的 `ChartXY`：保留"开箱有轴、有刻度、有标签"的完整度，但把全部实现成本集中在两个场景上。

它**不是**通用可视化库，也**不是**换皮版的 WebGL 绘图基元集合。

### 相对 `webgl-plot` v2

`webgl-plot` 证明了"用 WebGL 画折线"的最小实现，但有几处默认行为不适合工业场景：

|              | `webgl-plot` v2                           | as-charts                                      |
| ------------ | ----------------------------------------- | ---------------------------------------------- |
| 自动量程取舍 | `autoScale()` 静默跳过贡献不足 10% 的序列 | 每次取舍都经 `Diagnostics` 上报                |
| 尖峰保真     | 无显式保证                                | 降级阶梯**不得触碰数据层**——可以掉帧，不能丢点 |
| 坐标轴       | 不含                                      | 属于核心范围                                   |
| 资源生命周期 | 无账本                                    | `destroy()` 后 `assertEmpty()` 硬断言归零      |

### 相对 LCJS 9.0

抄机制，不抄负担：

| 机制       | LCJS 9.0                                                 | as-charts                                                 |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------- |
| 帧调度     | rAF 合并 + fps 闸门 + dt 钳制 + 可见性闸门               | 四个机制全部照搬                                          |
| 着色器变体 | 运行时 GLSL 字符串手术，25 个 feature 按固定顺序改写源码 | 模板声明位置 + 槽位声明目标 + `requires` 拓扑排序         |
| WebGL1     | 完整回退（GLSL ES 1.0 转译到 3.00 等）                   | 只支持 WebGL2，按扩展**逐项**探测降级                     |
| 多图表布局 | 单共享画布 + 每图表离屏 framebuffer + 合成               | 一 canvas 一 renderer，多图用 `viewport` + `scissor` 分区 |
| VAO 释放   | 从不释放                                                 | 账本释放，`mock.deleted.vertexArray > 0` 是一条断言       |

## 设计承诺

1. **能不画就不画。** 脏标记贯穿每个阶段。收益最大的性能杠杆是让不该发生的帧不发生，而不是把每帧画得更快。
2. **数据保真优先于帧率。** 降级阶梯只在视觉开销上退让。告警看板里丢掉一个尖峰，比丢掉一帧严重得多。
3. **不做静默决策。** 一切取舍经 `Diagnostics` 上报；结构性错误在构造时抛出。一个能编译的错误着色器，严格劣于启动时的崩溃。
4. **结构性门禁可断言。** drawCall 数、`destroy()` 零泄漏、每帧零分配、着色器输出确定性——四项都不依赖 GPU，因此是硬断言而非相对基线。

## 安装与使用

```bash
npm install as-charts
```

```ts
import { Renderer, Dirty } from 'as-charts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('canvas missing');

const renderer = new Renderer({ canvas });
const layer = renderer.addTriangleLayer({ initialCapacity: 4096, label: 'spikes' });

layer.setInstance(0, 32, 48, 6, 1, 0, 0);
renderer.request(Dirty.Data); // 只声明"什么变了"

// ...
renderer.destroy(); // assertClean 默认为 true，泄漏即抛错
```

`Renderer` 自己拥有 rAF 循环。**不要**在每帧里无条件调用 `request()`——那会把脏标记模型的收益全部抹掉。

```ts
const stats = renderer.stats();

stats.drawCalls; // 上一帧真实发出的 GL 绘制次数
stats.scheduler.pending; // 当前是否有帧已排期
stats.scheduler.skippedByFpsCap; // 被帧率闸门拦下的次数
stats.scheduler.skippedInvisible; // 被可见性闸门拦下的次数
stats.scheduler.skippedClean; // 因为不脏而省掉的次数
stats.resources.live; // 存活 GPU 对象数
```

## 在线演练场

```bash
npm install
npm run dev   # http://localhost:5178
```

页面把每条性能主张做成了实时读数：

- **单次 draw call** —— 标记数从 500 拉到 60 000，`drawCalls` 恒为 1
- **脏标记模型** —— 点"停止写入数据"后 `framesRequested` 不再增长（不是 `drawCalls` 归零，而是连帧都不再排期）
- **帧率闸门** —— 切到 10 fps，`skippedByFpsCap` 开始增长，而标记仍在移动（工作被推迟，不是被丢弃）
- **可见性闸门** —— 把画布滚出视野，`skippedInvisible` 增长，滚回来一次性补齐

## 已验证的门禁

| 门禁               | 断言                                       | 实测                                         |
| ------------------ | ------------------------------------------ | -------------------------------------------- |
| drawCall 预算      | 单图层恒为 1；空图层为 0；16 图表看板 ≤ 32 | ✅                                           |
| `destroy()` 零泄漏 | `resources.live === 0`，含上下文丢失后     | ✅                                           |
| 每帧零分配         | < 8 B/帧（差分测量 + 灵敏度自检）          | 渲染帧 −0.1 B，写实例 1.2 B                  |
| 着色器确定性       | 相同选项产出逐字节相同源码                 | ✅                                           |
| 真实 GPU 像素      | SwiftShader 上渲染并读回帧缓冲             | 512/512 像素、质心 15.5/47.5、y 翻转恰好一次 |

真实 GPU 冒烟测试会实际验证：组装出的 GLSL 能编译链接、VAO capture 了实例属性、投影把像素放在调用方要求的位置——这些是 mock 无法回答的问题。

```bash
npm run e2e
```

## 技术栈

Vite 8 · TypeScript · Vitest · ESLint · Prettier · commitlint · lint-staged · husky · VitePress

## 脚本

| 命令                              | 说明                                    |
| --------------------------------- | --------------------------------------- |
| `npm run dev`                     | 演练场（5178）                          |
| `npm run build`                   | 库产物（ESM + CJS + `.d.ts`）           |
| `npm run check`                   | typecheck + lint + format:check + test  |
| `npm run test`                    | 单元与结构性门禁                        |
| `npm run test:coverage`           | 覆盖率（阈值 75%）                      |
| `npm run e2e`                     | 真实 WebGL2 像素冒烟（自带 dev server） |
| `npm run docs:dev` / `docs:build` | 文档站点                                |

提交走 Conventional Commits，`commit-msg` 由 commitlint 校验，`pre-commit` 跑 typecheck 与 lint-staged。

## 文档

```bash
npm run docs:dev
```

- [API 稳定性契约](docs/api-stability.md) —— 三条不可破坏契约，动手前先读这个
- [快速上手](docs/guide/quick-start.md)
- [定位与取舍](docs/guide/positioning.md)
- [渲染模型：脏标记与帧调度](docs/architecture/rendering-model.md)
- [着色器槽位组装](docs/architecture/shader-composition.md)
- [GPU 资源账本](docs/architecture/resource-ledger.md)
- [性能门禁](docs/performance/gates.md)
- [测试基础设施](docs/engineering/test-harness.md)
- [里程碑](docs/roadmap.md)
- [变更日志](CHANGELOG.md)

## 工程约束

- **零运行时依赖。** 打包进产物的每一行都是刻意写下的。
- **`minify: false`。** 由调用方自行打包；产物保留可读性，让栈追踪与着色器诊断有意义。
- **响应式**在 `devDependencies` 里，不进 `dependencies`。
- **`node >= 22.22.1`**（构建期要求，由 `lint-staged 17` 与 `vitest 5` 决定，见 `.nvmrc`）。运行时只要求浏览器支持 WebGL2。

## 包名

发布名定为 **`as-charts`**。单数形式 `as-chart` 已被他人占用（v1.0.1），故不使用；
`as-charts` 在写这份文档时**未被占用**（`npm view as-charts` 返回 404）。

```bash
npm view as-charts version   # 期望 404
```

`package.json` 的 `name` 已同步为 `as-charts`，版本保持 `0.0.0`（明确表示未发布）。
发布前请再确认一次名字仍然可用——npm 上的名字随时可能被人抢注。

## License

[MIT](LICENSE)
