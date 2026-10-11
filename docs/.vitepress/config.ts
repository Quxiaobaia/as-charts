import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'as-charts',
  description: '面向超大数据量科研绘图与工业实时监控的 WebGL2 图表引擎',
  lang: 'zh-CN',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: '指南', link: '/guide/quick-start' },
      { text: '架构', link: '/architecture/rendering-model' },
      { text: '性能门禁', link: '/performance/gates' },
      { text: '里程碑', link: '/roadmap' },
    ],
    sidebar: [
      {
        text: '指南',
        items: [
          { text: '快速上手', link: '/guide/quick-start' },
          { text: '定位与取舍', link: '/guide/positioning' },
        ],
      },
      {
        text: '架构',
        items: [
          { text: '渲染模型：脏标记与帧调度', link: '/architecture/rendering-model' },
          { text: '着色器槽位组装', link: '/architecture/shader-composition' },
          { text: 'GPU 资源账本', link: '/architecture/resource-ledger' },
        ],
      },
      {
        text: '工程',
        items: [
          { text: '性能门禁', link: '/performance/gates' },
          { text: '测试基础设施', link: '/engineering/test-harness' },
          { text: '里程碑', link: '/roadmap' },
        ],
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    search: { provider: 'local' },
    lastUpdated: { text: '最后更新' },
  },
});
