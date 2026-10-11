# GPU 资源账本

## 为什么需要

WebGL 对象泄漏在开发机上通常看不出来。它表现为"跑二十分钟后开始变慢"，而那时根因已经离症状很远了。

`ResourcePool` 是一个统一的 GPU 资源账本：每一次 `create*` 都登记，每一次 `delete*` 都核销，`destroy()` 之后 `assertEmpty()` 硬断言归零。

```ts
renderer.destroy(); // assertClean 默认为 true
// 若还有任何对象存活：
// DiagnosticError [resource/leak] Renderer.destroy: 3 GPU object(s) still alive after destroy()
```

错误信息里带**每个泄漏对象的种类与标签**：

```
buffer:markers.instances
vertexArray:markers.vao
program:as-charts/triangle.vertex
```

标签是必填的工程习惯，不是装饰。没有标签的泄漏报告只能告诉你"漏了三个 buffer"。

## 七种受管资源

`shader`、`program`、`buffer`、`texture`、`framebuffer`、`renderbuffer`、`vertexArray`。

每种都统计创建数、销毁数与**字节数**（能算的才算，算不出来的记 0 而不是猜一个数）：

```ts
const snapshot = renderer.stats().resources;
snapshot.live; // 当前存活对象数
snapshot.bytes; // 显存占用估算
snapshot.created; // 累计创建
snapshot.destroyed; // 累计销毁
snapshot.counts; // 按种类细分
snapshot.labels; // 存活对象的 kind:label 清单
```

`created - destroyed === live` 是一条可以在测试里断言的不变量。

## 上下文丢失

`webglcontextlost` 时，所有 GL 句柄一次性失效。此时**不能**再对它们调用 `delete*`——那是无效调用，而且会让账本假装自己还持有有效句柄。

所以 `ResourcePool` 提供了 `abandon()`：清空账本，但不发任何 GL 调用。

```ts
#onContextLost = (event: Event): void => {
  event.preventDefault(); // 必须调用，否则不会触发 restored
  this.#contextLost = true;
  this.#pool.abandon();
};
```

恢复时图层必须重建：既有图层持有的是失效句柄。

```ts
webglcontextlost     → 渲染挂起，账本清空，diagnostics 报告 context/lost
webglcontextrestored → 清除标志，diagnostics 报告 context/restored
```

丢失后调用 `destroy()` 仍然必须是干净的——账本是被清空，而不是半填充。这条也有测试。

## VAO 陷阱

这不是资源账本的问题，但它和资源重建紧挨着，所以放在这里。

**VAO 会捕获缓冲绑定与属性指针。** 因此实例缓冲一旦因为扩容而重建，VAO 里的实例属性就指向了一个已被删除的缓冲——绘图会在数据长到某个点之后突然变白，而在此之前一切正常。

```ts
// 缓冲重建之后必须重新捕获
this.#pool.release(this.#instanceBuffer);
this.#instanceBuffer = this.#createInstanceBuffer();
gl.bindVertexArray(this.#vao);
this.#bindInstanceAttributes(); // ← 漏掉这行就开始白屏
gl.bindVertexArray(null);
```

测试直接断言这件事发生过：

```ts
const before = mock.counts['vertexAttribPointer'];
for (let i = 0; i < 40; i += 1) layer.setInstance(i, i, i, 1, 1, 1, 1);
expect(mock.counts['vertexAttribPointer']).toBeGreaterThan(before);
```

顺带一提：LCJS 9.0 **从不释放 VAO**。我们的账本会释放，`mock.deleted.vertexArray > 0` 是一条断言。

## 扩容策略

实例缓冲按 1.5 倍增长，而不是每次翻倍或按需精确分配。1.5 倍在"重分配次数"与"浪费的显存"之间取得平衡；翻倍更省重分配但可能浪费一倍显存，精确分配则会导致每次 append 都重传。

增长时旧数据被复制到新缓冲，因此已经写入的实例不会丢失——这一点也有断言。

## 增量上传

上传走 `bufferSubData`，只推送**活跃区间**：

```ts
gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#data, 0, this.#count * INSTANCE_STRIDE_FLOATS);
```

注意这里是**五参数**重载。看起来更自然的写法是：

```ts
// ✗ 每帧一次分配
gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#data.subarray(0, n));
```

`subarray` 返回的不是切片，而是**一个新的 TypedArray 视图对象**——每帧一次分配。这正是每帧零分配门禁要抓的那类成本。五参数形式让一个 `Float32Array` 存活到图层结束。

上传字节数是可断言的：

```ts
// 6 floats/实例 × 4 bytes × 2 实例
expect(mock.uploads).toEqual([48]);
```

## 相关测试

```
tests/resource-pool.test.ts   账本不变量、按种类统计、abandon 语义
tests/renderer.test.ts        泄漏断言、上下文丢失与恢复、扩容后 VAO 重捕获
tests/allocation.test.ts      每帧零分配（含差分测量与灵敏度自检）
```
