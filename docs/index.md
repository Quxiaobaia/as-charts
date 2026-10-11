---
layout: home

hero:
  name: as-charts
  text: WebGL2 图表引擎
  tagline: 超大数据量科研绘图 · 工业实时监控。数据保真优先于帧率。
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/quick-start
    - theme: alt
      text: 渲染模型
      link: /architecture/rendering-model

features:
  - title: 能不画就不画
    details: 脏标记贯穿每个阶段，帧率闸门、可见性闸门与 rAF 合并让"不该发生的帧"真的不发生。这是收益最大的性能杠杆，而不是把每帧画得更快。
  - title: 宁可掉帧也不丢尖峰
    details: 降级阶梯只在视觉开销上退让，绝不触碰数据层。告警看板里丢掉一个尖峰，比丢掉一帧严重得多。
  - title: 声明式着色器组装
    details: 模板声明位置，槽位声明写入目标，顺序由 requires 加拓扑排序决定 —— 而不是在运行时对着字符串做手术。
  - title: 结构性门禁进 CI
    details: drawCall 数、destroy() 零泄漏、每帧零分配、着色器输出确定性，四项都不依赖 GPU，因此在 CI 里是硬断言而非相对基线。
---
