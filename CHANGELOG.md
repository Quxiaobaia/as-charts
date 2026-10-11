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

- `docs/api-stability.md`：冻结三条不可破坏契约（拾取 id 空间 / `DrawCall` 描述符 /
  `Axis` 归属），规定变更流程，并明确列出**不**在这儿冻结的部分，避免约束收得过早。
- `CHANGELOG.md`：建立 `0.x` 期的变更记录约定。

### Changed

- 包名由 `as-chart` 改为 **`as-charts`**（单数形式在 npm 上已被占用，为 v1.0.1）。
  包名从未发布过，因此不构成对使用者的破坏性变更。

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
