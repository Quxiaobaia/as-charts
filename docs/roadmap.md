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
- 文本渲染（M1 用独立 2D canvas 文本层，**不用**字形图集）
- 逐点拾取与交互
- 数据层：环形缓冲、三级 LOD、降采样
- B 类时间基准
- 面向前端的 `Chart` 门面（目前只有 `Renderer` 这一层）

## M1 · 折线管线与坐标轴

目标：让"工业实时监控"这个场景真正可用 —— **10 万点 × 8 线 @ 60 fps**，以及
**1000 万点数据集首帧 < 1.5 s**。

M1 按五批推进，每批独立验收、独立提交。切分原则是 **接口先冻结、实现后补**：
会同时波及三个以上模块的接口（拾取 id 空间、`DrawCall` 描述符、`Axis` 归属）在 M1-0 就定死，
避免"补大数据时回头改几何"这种最贵的返工。

### M1-0 · 契约冻结（已完成）

- [API 稳定性契约](/api-stability)：三条不可破坏契约 + 变更流程 + 明确不冻结的部分
- `CHANGELOG.md`：`0.x` 期的变更记录约定
- 本页清单与《自研图表库_M0_M1实施设计》§6 对齐

### M1-a · 数据层与刻度（零 GL 依赖）

全部可在 Node 下单测 —— 这是"结构性门禁能被硬断言"的前提。

| 模块                     | 内容                                              |
| ------------------------ | ------------------------------------------------- |
| `src/data/Scale.ts`      | `linear` / `log` / `time` / `category`            |
| `src/data/ticks.ts`      | 纯函数刻度算法，与 d3-scale 对拍                  |
| `src/data/downsample.ts` | minmax（**唯一允许的算法**），必须输出 `srcIndex` |
| `src/data/bounds.ts`     | 带 `SkipDiagnostic`，绝不静默                     |
| `src/data/RingBuffer.ts` | 环形缓冲与绕回桥接                                |
| `src/data/DataSet.ts`    | 列式 SoA                                          |

**验收**：ticks 对拍（线性 / 对数 / 时间各 ≥ 20 组）全部一致；B7 尖峰保真的纯函数版本通过；
环形缓冲绕回正确。

### M1-b · 折线几何与双通道

- `src/core/chunks/geom-line.ts`：实例化线段，每实例 4 顶点，屏幕空间法线保证线宽与缩放无关
- `src/core/DrawCall.ts`：按 [契约 C2](/api-stability) 落地
- `attribute` / `texture` **两条通道同时**落地，共用同一套描述符
- 颜色与 id 偏移走 **per-instance 属性**，不走 uniform

**验收**：单系列 drawCall 恒为 1、8 系列合并后仍为 1；线宽在缩放后恒定；双通道像素级一致。

### M1-c · 轴 / 文本层 / Chart 门面

- `src/shell/Axis.ts`：`Renderer` 级独立实体，引用计数，`valueToPixel` 为纯函数
- `src/shell/TextLayer.ts`：**独立 2D canvas**，脏矩形重绘，
  **必须提供 `renderTo(ctx, scale)` 而不仅是 `paint()`**
- `src/shell/Layout.ts`：`viewport` + `scissor` 分区
- `src/shell/Chart.ts`：门面 + 12 ms resize 尾防抖

> **文本层的载体是独立 2D canvas —— 不是字形图集，也不是 DOM 叠加层。**
> 三个候选各有一条硬需求挡着：科研必须导出图片（DOM 文字进不了位图）、
> DPR 变化要能重绘（图集需要重建）、i18n 依赖原生 `fillText`（图集同样需要重建）。
> 关键是**文本层不是一个位图，而是一个能按任意 scale 重画一遍的函数**。
> 只提供 `paint()` 会导致 M3 的导出功能重写文本层。

**验收**：轴不变时零 `fillText` 调用；两个 `Chart` 挂同一 `Axis` 后各自 `destroy()` 不泄漏；
e2e 出一张带轴、刻度与标签的真图。

### M1-d · 三级 LOD / 增量上传 / Worker

- T0 / T1 / T2 分层与选层不等式（T1 固定 65536 桶，**不参与任何降级**）
- `GrowingBuffer` 增量 `bufferSubData`
- Worker 池 + `Transferable` 移交 `ArrayBuffer` 所有权

**验收**：1000 万点首帧 < 1.5 s；用调用计数断言 T1 命中区不触碰 T0；
B7 在**每个 LOD 层级 × 每个降级档位**各断言一遍（降级最容易悄悄破坏的就是它）。

### M1-e · 时间基准与 CI

- `npm run bench`：长采样窗口 + 相对基线（±15%），CI 只做相对回归、不做绝对值门禁
- CI 增加 SwiftShader e2e job 与包体积门禁（core < 40 KB gzip、全量 < 70 KB gzip）

### M1 期间不做

外壳功能一律不加（Tooltip / 图例 / 控件属于 M3），热图与注释属于 M4。
3D / 地图 / 极坐标**永不做** —— 见[定位与取舍](/guide/positioning)的非目标清单。
先把"ChartXY 这条线"做扎实，再谈别的。

## M2 · 拾取与交互

- 逐点拾取：把 LCJS 9.0 的实现单独抽出后的成果落地
- 悬浮高亮：`color.highlight` 槽位已经在 M0 里预留并验证了顺序
- 缩放、平移、框选
- 十字准线与游标读数

## M3 · 分发与稳定

- 版本号从 `0.0.0` 推进，发布到 npm
- 包名已定为 `as-charts`，`npm publish` 前再确认未被抢注
- 文档站点随版本发布
- `docs/migration.md`：首个破坏性变更发生时建立（`0.x` 期承诺见 CHANGELOG）
- 浏览器兼容矩阵与降级说明的产品化

## 已知的未决问题

1. **包名。** 已定为 `as-charts`（单数形式 `as-chart` 被占用）。发布前 `npm view as-charts version` 应仍为 404。
2. **一个 renderer 一个 canvas 的边界。** 多图分区用 `viewport` + `scissor`，但 `scissor` 的分区管理与重叠层级尚未实现。
3. **worker 渲染。** `CanvasLike` 是结构化类型，`OffscreenCanvas` 可以满足它，但资源账本目前假设单线程。
