# 着色器槽位组装

## 问题

LCJS 9.0 用**运行时字符串手术**生成着色器变体。25 个 feature 各自携带一组"在 `main` 前插入 / 在 `main` 末尾插入 / 删除某一行"的指令，按固定顺序改写源码字符串。

这套机制里有一个真实存在的顺序依赖，但它表达得很隐晦：所有颜色 feature 都是反复 `lastIndexOf` 文本 `"colorFragment ="` 然后追加。于是**最终颜色取决于 feature 恰好被应用的顺序**——一个真实依赖被写成了字符串搜索的副产品。

只有当变体矩阵大到 `features × primitives × GL 版本 × 精度` 时，这套东西才划算。不到 20 个 feature 时它是净亏损：手术没有语法，打错一个字会**静默失败**，产出一个能编译、但什么都不画的着色器。

## 方案：声明位置，而不是搜索字符串

保留有价值的部分——用小的声明式片段组装着色器，包括往同一个"公共井"里链式写入——但把顺序变成显式的。

```ts
const composer = new ShaderComposer({
  'color.base': {
    at: 'colorFragment',
    code: '  colorFragment = vec4(vColor, 1.0);',
  },
  'color.highlight': {
    at: 'colorFragment',
    requires: ['color.base'],
    code: '  colorFragment.rgb = mix(colorFragment.rgb, vec3({{r}}, {{g}}, {{b}}), {{strength}});',
  },
});
```

三条规则：

1. **模板声明位置**，用 `/* @slot:name */` 标记注释。
2. **槽位声明它写入哪个位置**（`at`）。多个槽位可以共享同一个位置。
3. **顺序由 `requires` 加拓扑排序决定。**

于是"高亮必须在底色之后"从字符串搜索的意外产物，变成了一句可以被验证的声明。

### 确定性

拓扑排序的起始遍历顺序取**注册表的声明顺序**，而不是启用列表的顺序。因此重排 `enabled` 数组**不会**改变输出字节，着色器快照测试才有意义。

```ts
composer.compose({ name, template, enabled: ['base', 'tint'] });
composer.compose({ name, template, enabled: ['tint', 'base'] });
// 两者产出的 code 完全相同
```

## 错误路径

组装器最危险的地方是"静默地做错"。所以每条失败路径都有独立错误码，且**必定抛出**——即使 `diagnostics` 配成 `'silent'`。一个能编译的错误着色器在调试上严格劣于启动时的崩溃，因为症状（什么都不显示）指向不了原因。

| 情况                                 | 结果                                 |
| ------------------------------------ | ------------------------------------ |
| 标记指向的位置没有任何槽位写入       | `shader/template-marker-unmatched`   |
| 位置没有启用任何槽位                 | 标记被移除——这正是可选槽位的实现方式 |
| 槽位启用，但模板没有它目标位置的标记 | `shader/slot-unconsumed`             |
| 启用的槽位依赖未启用的槽位           | `shader/missing-dependency`          |
| 依赖成环                             | `shader/dependency-cycle`            |
| 槽位代码引用 `{{param}}` 却没有给值  | `shader/unresolved-param`            |

### 可选槽位是怎么成立的

"模板里每个标记都必须被消费"这条规则初看很自然，但它让可选位置**无法存在**。正确的断言是按两个方向分别做：

- 每个**标记**必须对应一个已注册的位置（否则是模板或注册表打错了）。
- 每个**已启用**的槽位，其目标位置必须在模板里有标记（否则模板漂移了）。

未启用的已注册位置，其标记被**移除**。`triangle.ts` 里的 `depth` 就是这样一个位置：对 2D 毫无意义，但一旦几何需要排序就立刻有用，而在禁用期间零成本。

### 名称允许点号

槽位名与位置名只出现在注释标记里，**从不进入 GLSL**，因此不受 GLSL 标识符规则约束。限制成标识符语法是一条背后没有任何东西的约束。允许 `.` 和 `-` 让命名空间读起来更顺：

```ts
('transform.pixel', 'transform.clip', 'antiAlias.off', 'color.base');
```

### 常量必须有限

```ts
formatGlslConstant(Number.NaN); // throws
```

非有限值在这里被拒，而不是交给驱动：一个 `NaN` 种子常量通常**仍然能编译**，然后让整个 pass 什么都不画——比启动时报错糟糕得多。

## 编译错误带行号

组装是纯函数，源码是确定的，所以编译失败时可以指出**出错变体的具体某一行**，而不是给出一份压缩过的驱动日志：

```ts
try {
  renderer.addTriangleLayer();
} catch (error) {
  // ShaderCompileError
  // error.message 包含带行号标注的源码片段
  // 12 |   colorFragment = vec4(vColor, 1.0);
}
```

这是"模板组装"相对于"运行时字符串手术"最直接的回报。

## 程序缓存

变体按键做**引用计数**缓存。编译与链接是整个引擎里最贵的操作（数十毫秒），而多个图层合法地想要同一个变体：

```ts
const a = renderer.addTriangleLayer(); // 编译
const b = renderer.addTriangleLayer(); // 复用，不编译
renderer.stats().programs; // 1
```

没有引用计数时，销毁其中一个图层会删掉另一个还在使用的程序——而这个失效只表现为"图表变空白"。

## 相关测试

```
tests/shader-composer.test.ts    每条错误路径一个断言
tests/shader-snapshot.test.ts    输出字节的确定性
tests/renderer.test.ts           程序缓存的引用计数与失败清理
```
