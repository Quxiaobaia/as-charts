# Changelog

本文件记录所有值得注意的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 关于 `0.x` 期的承诺范围

本项目在 `1.0` 之前**不承诺 API 稳定**：任何导出都可能在下一个小版本中改名或改签名。
这是刻意的选择 —— 与其在没被使用过之前就把接口钉死，不如让接口在被使用中定型。

但"不稳定"不等于"不记录"。每一处破坏性变更都会在下方对应版本里以 **BREAKING** 标注，
并说明使用者需要改什么。

唯一的例外是[三条不可破坏契约](./docs/api-stability.md)（拾取 id 空间、`DrawCall` 描述符、
`Axis` 归属）：它们在实现第一行代码之前就已冻结，改动需要有重大版本号推进。

## [Unreleased]

### Added

- **契约冻结（M1-0）**
  - `docs/api-stability.md`：冻结三条不可破坏契约（拾取 id 空间 / `DrawCall` 描述符 /
    `Axis` 归属），规定变更流程，并明确列出**不**在这儿冻结的部分，避免约束收得过早。
  - `CHANGELOG.md`：建立 `0.x` 期的变更记录约定。
- **数据层（M1-a，零 GL 依赖）**
  - `src/data/Scale.ts`：`linear` / `log` / `time` / `category`
  - `src/data/ticks.ts`：**移植而非自创** d3 的线性 / 对数 / 时间刻度算法，
    与 d3-array / d3-scale / d3-time 对拍（27 + 22 + 22 组）要求逐值相同。
    也因此 `d3-*` 留在 devDependencies，产物中零 d3 代码
  - `src/data/downsample.ts`：min/max 是**唯一**允许的降采样算法；每个输出点携带
    `srcIndex` —— 从降采样后的下标推 id 会在每次缩放时变，映射不回原始样本
  - `src/data/bounds.ts`：带 `SkipDiagnostic`，绝不静默跳点
  - `src/data/RingBuffer.ts`、`src/data/DataSet.ts`：环形缓冲与列式 SoA
  - B7 尖峰保真在 10⁶ 点上的六档预算（200/200）全部通过
- **折线管线（M1-b）**
  - `LineLayer`：实例化线段，每实例 4 顶点，屏幕空间法线保证**线宽与缩放无关**
  - `attribute` / `texture` **两条数据通道同时**落地，共用同一套 `DrawCall` 描述符
  - 单系列恒为 1 次 draw call；8 系列合并后仍为 1 次（真实 GPU 上 256 实例一次绘出）
  - 非有限值**丢弃而非钳制**；孤立点渲染成方块（`A == B` 的退化四边形）而不是消失
  - `src/core/shader/projection.ts`：`projectPoint` / `unprojectPoint` 互逆对，
    把"y 只翻转一次"变成**一个文件的性质**
  - `src/core/transform.ts`：正交投影矩阵，退化定义域塌陷到裁剪空间中心而非边缘
- **`DrawCall` 描述符与 `DrawList`（契约 C2 落地）**
  - `isMergeable` **逐字段比较** program / VAO / mode / 顶点数 / uniform writer / 数据通道，
    而不是相信生产者给的一个不透明 key —— key 是一个声明，声明可能是错的
  - 绘制路径收敛：`DrawList` 独占全部 GL 绘制，`stats().drawCalls` 由内核**实测**而非各图层承诺
  - `stats().drawGroups` 暴露实际发生了多少合并
  - **校验 `instanceFirst` 不变量**：WebGL2 没有 `baseInstance`，合并后的 run 只有从实例 0
    开始才可绘制；不满足时报 `draw/instance-offset-unsupported`，而不是发出一次会画出
    别人几何的绘制（丢一条线可恢复，画错像素不可恢复）
- **`IdSpace`（契约 C1 的分配半边，提前于 M2）**
  - 0 恒未命中（自由链从 1 开始，由构造保证）、存活区间不重叠、释放后区间可复用
  - 空间耗尽时**降级到系列级拾取**（`count: 1`）并报 `picking/id-space-exhausted`，
    绝不环绕；双重/部分重叠释放被拒并报 `picking/id-range-invalid`
- **真实 GPU 的折线像素检查**（`npm run e2e` 新增 `tests/e2e/line.ts`）
  - **双通道像素级一致**：631 个点亮像素，**差异像素 0、最大通道差 0**
  - **线宽是像素量且与缩放无关**：1× 与 4× 放大下均为 5 px，且等于请求值
  - y 翻转只发生一次，上下两个方向都断言
  - 两个通道、八系列一次 draw call、真实 GPU 上 `destroy()` 归零（9 → 0）
- `tests/transform.test.ts`：断言投影约定与 `unprojectPoint` 的互逆关系
  （设计文档草稿在这里差了**一倍**，而错误的统一线宽极难用肉眼发现）
- `npm run clean:coverage`：清理覆盖率产物。`vitest` 自带的清理走 `fs.rm`，
  在把删除路由到系统回收站的沙箱环境里会失败并**在跑任何测试之前**中止整个运行

### Changed

- 包名由 `as-chart` 改为 **`as-charts`**（单数形式在 npm 上已被占用，为 v1.0.1）。
  包名从未发布过，因此不构成对使用者的破坏性变更。
- `LayerBinding.draw(program, …)` 改为 `collect(list, w, h)`：图层描述**画什么**，
  `DrawList` 决定**几次调用**。原先由各图层汇报自己的调用数，等于把 draw call 预算
  变成没人能验证的承诺。
- 每帧分配门禁的**测量方法被修好，而不是被放宽**：原先同一段零分配闭包可读 0 / 33 / 63 / 74 B，
  是一个"只会漏报"的机器。现在强制 `--expose-gc`、差分测量、三次取最小，
  并新增一条守卫测试：一旦测量退化回噪声，它会**显式失败**。

## [0.0.0] - 2026-10-11

首个提交。`0.0.0` 明确表示**尚未发布到 npm** ——
它不是"还没有功能"，而是"接口还会变，不占用一个版本号"。

仓库：<https://github.com/Quxiaobaia/as-charts>

### Added

- **内核（M0）**
  - 上下文所有权、能力探测与**逐扩展**降级（缺哪个报哪个，附确切降级说明）
  - `ResourcePool`：统一 GPU 资源账本，`destroy()` 后 `assertEmpty()` 硬断言归零
  - `FrameScheduler`：rAF 合并 / 帧率闸门 / `dt` 钳制 / 可见性闸门四条机制
  - `ShaderComposer`：模板声明**位置**、槽位声明**目标**、`requires` 驱动拓扑排序 ——
    替代运行时 GLSL 字符串手术
  - `ProgramCache`：引用计数，最后一个持有者释放时才删除程序
  - `TriangleLayer`：实例化几何，单 draw call
  - `Diagnostics`：三级（`silent` / `warn` / `throw`），监听器在任何级别都触发
- **四条结构性门禁**（不依赖 GPU，因此是硬断言而非相对基线）
  - drawCall 预算：单图层恒为 1，空图层为 0
  - `destroy()` 零泄漏，含上下文丢失后
  - 每帧零分配：实测渲染帧 **−0.1 B/帧**、写实例 **1.2 B/帧**（预算 8 B/帧），
    差分测量并自带灵敏度自检
  - 着色器输出确定性：相同选项产出逐字节相同的源码
- **真实 GPU 像素冒烟**（`npm run e2e`）：在 SwiftShader 上渲染并读回帧缓冲，
  断言像素数与质心位置，含负向对照。验证 mock 无法回答的问题 ——
  组装出的 GLSL 能否编译链接、VAO 是否真的捕获了实例属性、投影是否把像素放在要求的位置。
- **在线演练场**（`npm run dev`）：把每条性能主张做成实时读数
- **工程基线**：Vite 8 / TypeScript 6 / Vitest 5 / ESLint 10 / Prettier / commitlint /
  lint-staged / husky / VitePress，**零运行时依赖**
