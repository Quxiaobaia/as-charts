# 里程碑

## M0 · 内核骨架（已完成）

M0 的目的是让四条结构性门禁**可以被断言**，而不是画出一个好看的东西。它包含一个完整的、可测的帧管线，以及最少的几何。

### 已完成

| 能力                                               | 位置                                                         |
| -------------------------------------------------- | ------------------------------------------------------------ |
| 上下文所有权与能力探测                             | `src/renderer/Renderer.ts`、`src/core/capabilities.ts`       |
| 脏标记模型与传播链                                 | `src/core/dirty.ts`                                          |
| 帧调度：rAF 合并 / 帧率闸门 / dt 钳制 / 可见性闸门 | `src/core/FrameScheduler.ts`                                 |
| GPU 资源账本与上下文丢失                           | `src/core/ResourcePool.ts`                                   |
| 着色器槽位组装（含全部错误路径）                   | `src/core/ShaderComposer.ts`                                 |
| 引用计数的程序缓存                                 | `src/renderer/Program.ts`                                    |
| 三角实例化管线                                     | `src/layers/TriangleLayer.ts`、`src/core/shader/triangle.ts` |
| 三级诊断                                           | `src/core/Diagnostics.ts`                                    |
| 结构性门禁的测试基础设施                           | `tests/utils/`                                               |
| 真实 GPU 像素冒烟                                  | `tests/e2e/`、`scripts/e2e.mjs`                              |
| 在线演练场                                         | `index.html`、`examples/m0-triangles/`                       |

### 已完成的门禁

- drawCall 预算：单图层恒为 1，空图层为 0，16 图表看板 ≤ 32
- `destroy()` 零泄漏（含上下文丢失后）
- 每帧零分配（实测渲染帧 −0.1 B/帧，写实例 1.2 B/帧）
- 着色器输出确定性（逐字节）
- 真实 WebGL2 上的像素正确性，含 y 翻转恰好一次

### 刻意未做

- 折线/散点几何管线（只有三角）
- 坐标轴、刻度、标签
- 文本渲染与字形图集
- 逐点拾取与交互
- 数据层：环形缓冲、三级 LOD、降采样
- B 类时间基准
- 面向前端的 `Chart` 门面（目前只有 `Renderer` 这一层）

## M1 · 折线管线与坐标轴

目标：让"工业实时监控"这个场景真正可用。

- `LineLayer`：三角带扩边 + 解析式边缘抗锯齿（几何落在三角管线里，所以抗锯齿走屏幕空间导数）
- 三级 LOD 与降采样：**每一级降级都不得触碰数据层**——可以掉帧，不能丢尖峰
- 数据层：环形缓冲、`appendSamples()` 的增量路径
- 轴与刻度：数值轴、时间轴、刻度标签布局
- 文本：字形图集、`Text` 脏位的实际消费者
- `Chart` 门面：把 `Renderer` + 轴 + 图层包成开箱可用的对象
- 尺寸变化的 12 ms 尾防抖接到门面上
- B 类时间基准：长采样窗口 + 相对基线回归

## M2 · 拾取与交互

- 逐点拾取：把 LCJS 9.0 的实现单独抽出后的成果落地
- 悬浮高亮：`color.highlight` 槽位已经在 M0 里预留并验证了顺序
- 缩放、平移、框选
- 十字准线与游标读数

## M3 · 分发与稳定

- 版本号从 `0.0.0` 推进，发布到 npm
- 包名已定为 `as-charts`，`npm publish` 前再确认未被抢注
- 文档站点随版本发布
- 浏览器兼容矩阵与降级说明的产品化

## 已知的未决问题

1. **包名。** 已定为 `as-charts`（单数形式 `as-chart` 被占用）。发布前 `npm view as-charts version` 应仍为 404。
2. **一个 renderer 一个 canvas 的边界。** 多图分区用 `viewport` + `scissor`，但 `scissor` 的分区管理与重叠层级尚未实现。
3. **worker 渲染。** `CanvasLike` 是结构化类型，`OffscreenCanvas` 可以满足它，但资源账本目前假设单线程。
