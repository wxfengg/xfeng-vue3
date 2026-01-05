# @vue/reactivity 复习笔记（基于当前实现）

> 目标：用最少时间回忆起整个响应式系统的“数据结构 + 调用链 + 边界行为”。
> 范围：仅整理你当前仓库实现，不引入额外 API/实现。

## 0. 文件/模块地图（从入口到核心）

- 入口导出： [packages/reactivity/src/index.ts](packages/reactivity/src/index.ts)
  - 统一 re-export：`ref` / `effect` / `reactive` / `computed` / `watch`

- 运行时核心模块
  - [packages/reactivity/src/effect.ts](packages/reactivity/src/effect.ts)：`ReactiveEffect`、`activeSub`、`effect(fn, options)`
  - [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)：依赖链表结构（`Link/Dependency/Sub`）、`link`、`propagate`、`startTrack/endTrack`（依赖复用 + 清理）
  - [packages/reactivity/src/dep.ts](packages/reactivity/src/dep.ts)：`targetMap`、`track/trigger`（按 target.key 建 dep，并触发 subs）

- 响应式数据类型
  - [packages/reactivity/src/reactive.ts](packages/reactivity/src/reactive.ts)：`reactive`、缓存/判定 `isReactive`
  - [packages/reactivity/src/baseHandlers.ts](packages/reactivity/src/baseHandlers.ts)：Proxy `get/set`（track/trigger、ref 自动解包、对象递归 reactive、数组 length 特殊处理）
  - [packages/reactivity/src/ref.ts](packages/reactivity/src/ref.ts)：`RefImpl`、`trackRef/triggerRef`、`toRef/toRefs/proxyRefs`
  - [packages/reactivity/src/computed.ts](packages/reactivity/src/computed.ts)：`ComputedRefImpl`（同时是 Dependency + Sub）、惰性计算 + 订阅传播
  - [packages/reactivity/src/watch.ts](packages/reactivity/src/watch.ts)：`watch`、`traverse`（deep）、`onCleanup`、`once/immediate`

- 工具依赖（workspace 包）
  - [packages/shared/src/index.ts](packages/shared/src/index.ts)：`isObject/hasChanged/isFunction`

---

## 1. 贯穿全局的核心概念：`dep` / `sub` / `link` / `activeSub`

### 1.1 两种“身份”

- **Dependency（依赖项）**：能被别人订阅的东西
  - 典型：
    - `Dep`（`target.key` 对应的依赖桶）
    - `RefImpl`（ref 本身也是一个 dependency）
    - `ComputedRefImpl`（computed 的 value 同样可被订阅）
  - 结构特征：都有 `subs/subsTail`（订阅它的 Sub 链表）

- **Sub（订阅者）**：会去读 dependency，从而被依赖项反向触发更新
  - 典型：
    - `ReactiveEffect`
    - `ComputedRefImpl`（computed 在“作为订阅者”时会订阅它内部 getter 读取到的 deps）
  - 结构特征：都有 `deps/depsTail`（它订阅过的 Dependency 链表），并且有 `tracking/dirty`

### 1.2 全局当前订阅者：`activeSub`

- 在 [packages/reactivity/src/effect.ts](packages/reactivity/src/effect.ts) 里：
  - `activeSub` 表示“当前正在执行、需要收集依赖的订阅者”（effect 或 computed）
  - `setActiveSub` 用于切换当前订阅者（解决嵌套 effect/computed）

**记忆法**：

- 只有当 `activeSub` 存在时，`track(...) / trackRef(...) / computed.value` 才会真正建立订阅关系。

### 1.3 个人思考（为什么这样设计）

- 用“Dependency / Sub 两种身份”来拆分职责，本质是在建一个通用的发布-订阅内核：谁都可以当依赖项、谁都可以当订阅者（computed 甚至可以两者兼任），这样后续扩展类型（比如不同风格的 ref）不需要重写依赖系统。
- `activeSub` 是一种“隐式上下文”（类似动态作用域）：读取发生时不用显式把订阅者往下传，API 更自然（用户只写读取逻辑），代价是要非常小心嵌套与恢复（所以必须保存/还原 `prevSub`）。
- 把“是否收集依赖”的开关放在运行时（`activeSub` 是否存在），可以避免无订阅者时的额外 Map/链表操作，让读属性的成本在非 effect 场景尽量接近普通对象读取。

---

## 2. system.ts：双向关联 + 链表复用（本实现最关键）

文件： [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)

### 2.1 数据结构（强烈建议背下来）

- `Dependency`：
  - `subs`：订阅者链表头
  - `subsTail`：订阅者链表尾

- `Sub`：
  - `deps`：依赖项链表头
  - `depsTail`：依赖项链表尾（同时也承担“本轮复用推进指针”的语义）
  - `tracking`：是否正在收集依赖
  - `dirty`：用于避免重复调度/循环触发

- `Link`（连接 dep 与 sub 的节点）：同时属于两条链表
  - sub 方向：`sub / nextSub / prevSub`
  - dep 方向：`dep / nextDep`

**核心点**：一个 `Link` 节点把 “dep ↔ sub” 双向串起来：

- `dep.subs` 链表：枚举“订阅了 dep 的所有 sub”
- `sub.deps` 链表：枚举“sub 订阅过的所有 dep”

### 2.2 `link(dep, sub)`：建立关联 + 复用节点

目标：把 `dep` 与 `sub` 建立订阅关系，并做到：

- 多次运行 effect/computed 时尽量复用原有 Link，减少增删开销
- 分支切换时能清理掉“本轮没有用到的旧依赖”

#### 复用策略（本实现的约定）

- 每次 sub 开始重新收集依赖前都会调用 `startTrack(sub)`：
  - `sub.tracking = true`
  - **关键：`sub.depsTail = undefined`**（表示“本轮复用从头开始”）

- `link` 内部逻辑：
  - `currentDep = sub.depsTail`
  - `nextDep = currentDep === undefined ? sub.deps : currentDep.nextDep`
  - 如果 `nextDep && nextDep.dep === dep`：说明顺序对齐，直接复用
    - `sub.depsTail = nextDep`
    - return

> 直觉：本轮收集依赖时，按访问顺序“对齐”上一轮的依赖链表；顺序一致就复用，不一致就新增。

#### 新增节点流程

- 先从 `linkPool`（对象池）尝试复用 Link 节点，否则 new 一个
- 把新节点挂到：
  - `dep.subs` 的尾部（维护 `subsTail`、以及 `prevSub/nextSub`）
  - `sub.deps` 的尾部（维护 `depsTail`、以及 `nextDep`）

> 你代码里注释掉了“遍历查重”的逻辑：本实现通过 `dirty` 与复用/清理策略来避免重复插入带来的问题。

### 2.3 `endTrack(sub)`：结束收集 + 清理多余依赖

- `sub.tracking = false`
- `sub.dirty = false`

清理规则：

- 若 `depsTail && depsTail.nextDep`：说明尾部之后的依赖都没被复用到 → 清掉 `depsTail.nextDep` 开始的所有 Link
- 若 `!depsTail && sub.deps`：说明本轮一个依赖都没收集到 → 清掉全部旧依赖

清理实现：`clearTracking(link)`

- 从 `dep.subs` 双向链表中摘除节点（维护头尾、prev/next）
- 将节点字段置空，并放入 `linkPool`（通过 `nextDep` 串对象池）

**复习重点**：

- `depsTail` 在本实现里有两层含义：
  1. “sub 的依赖链表尾”
  2. “本轮复用推进到哪里了”

### 2.4 `propagate(subs)`：触发更新（并区分 computed/effect）

- 遍历 `dep.subs` 链表
- 对每个 `sub`：如果 `!sub.tracking && !sub.dirty` 才会处理
  - 先 `sub.dirty = true`（避免重复入队）
  - 如果 `'update' in sub` → 当作 computed：
    - `processComputedUpdate(depAsComputed)`
      - 如果 computed 有订阅者并且 `update()` 使值发生变化 → 继续 `propagate(computed.subs)`
  - 否则当作 effect：先收集到 `queuedEffect`，最后 `notify()`

**这里的语义**：

- computed 的更新是“先重新计算 → 值变了才继续通知它的订阅者”
- effect 则是“直接调度执行”

### 2.5 个人思考（为什么这样设计）

- 选择“Link 节点同时挂在两条链表上”，是典型的双向索引设计：
  - 从 dep 触发时可以 O(n) 枚举订阅者；
  - 从 sub 停止/分支切换时也能 O(k) 精准找到并解除它曾经订阅过的 dep；
  - 不需要全局扫描或额外的反向 Map。
- `depsTail` 被复用成“本轮对齐指针”，是一种非常省分配的增量算法：effect 每次运行都尽量复用原节点，只有依赖集合/顺序变化时才补差异。
- `clearTracking` 把 Link 放进对象池 `linkPool`，是为了把“频繁的依赖变动”从 GC 压力转移为复用成本（更接近稳定的吞吐）。
- `tracking` + `dirty` 组合是一个轻量级的“防重入/防重复调度”机制：
  - `tracking` 避免执行过程中又触发自己造成循环；
  - `dirty` 类似去重标记，避免同一轮 propagate 多次入队。
- computed 走“先 update，再决定是否向下传播”，是为了保证：只有当 computed 的派生值真的变化时，才会牵连它的订阅者（避免无意义的级联更新）。

---

## 3. dep.ts：从 target.key 到 Dep（依赖桶）

文件： [packages/reactivity/src/dep.ts](packages/reactivity/src/dep.ts)

### 3.1 `targetMap` 结构

- `targetMap: WeakMap<target, Map<key, Dep>>`
- `Dep` 类本质是一个 Dependency：仅包含 `subs/subsTail`

示意：

```ts
WeakMap targetMap
  target(object/array) -> Map depsMap
    key -> Dep(subscribers...)
```

### 3.2 `track(target, key)`

触发点：Proxy `get` 中、读取属性时。

流程：

1. 没有 `activeSub` 直接 return（没人订阅就不建关系）
2. 取/建 `depsMap`
3. 取/建 `dep`
4. `link(dep, activeSub)` 建立订阅

### 3.3 `trigger(target, key)`

触发点：Proxy `set` 中、写入属性时。

- 如果 `depsMap` 不存在 → 从未被追踪过 → return

数组特殊处理：

- 若 `Array.isArray(target)` 且 `key === 'length'`：
  - 遍历 depsMap：
    - `depKey >= target.length` 或 `depKey === 'length'` 的 dep 都需要触发
  - 目的：缩短 length 会影响“被截断索引”的读取结果

普通情况：

- 找 `dep = depsMap.get(key)`，若存在且 `dep.subs` 存在 → `propagate(dep.subs)`

### 3.4 个人思考（为什么这样设计）

- `WeakMap(target -> depsMap)` 的设计天然避免内存泄漏：当外部不再持有 target 时，依赖表可被回收，不需要手动清理全局结构。
- “按 key 分桶”的粒度让依赖尽量精确：读 `a` 只订阅 `a` 的桶；写 `b` 只触发 `b` 的桶，避免全对象粗粒度触发。
- 数组 `length` 的分支是响应式系统里最容易忽略的正确性点：缩短 length 会影响多个索引的读取结果，所以必须按规则触发受影响的索引依赖，而不只是触发 `length` 自己。

---

## 4. effect.ts：ReactiveEffect 运行与停止

文件： [packages/reactivity/src/effect.ts](packages/reactivity/src/effect.ts)

### 4.1 `ReactiveEffect` 核心字段

- `deps/depsTail`：它订阅过哪些 dep（通过 Link 串）
- `tracking`：是否正在收集依赖（与 system.ts 配合）
- `dirty`：用于 propagate 去重/防循环
- `active`：stop 后不再收集依赖
- `fn`：用户传入的副作用函数

### 4.2 `run()`：依赖收集的入口

关键步骤：

1. 如果 `!active`：直接执行 `fn()`，**不收集依赖**
2. 保存 `prevSub = activeSub`（处理嵌套）
3. `setActiveSub(this)`
4. `startTrack(this)`（重置 depsTail）
5. `try { return fn() } finally { endTrack(this); setActiveSub(prevSub) }`

> 记忆：`startTrack/endTrack` 是为了“复用 + 分支清理”。

### 4.3 调度与通知

- `notify()` → `scheduler()`
- 默认 `scheduler()` 直接 `run()`
- `effect(fn, options)` 会 `Object.assign(reactive, options)`
  - 你可以通过 options 传入自定义 `scheduler` 覆盖默认行为

### 4.4 `stop()`

- 只有在 `active` 时才执行
- 通过 `startTrack(this); endTrack(this)` 来清掉所有依赖关系
- 设置 `active = false`

### 4.5 个人思考（为什么这样设计）

- `run()` 中保存并恢复 `prevSub`，本质是在维护一个“订阅者栈”，用来正确支持嵌套 effect/computed：内层运行时不会把外层的收集上下文弄丢。
- `stop()` 通过 `startTrack + endTrack` 来清依赖很巧：复用同一套“清理链表”的逻辑，不需要额外写一套 delete/遍历代码，降低出错面。
- `active=false` 后 `run()` 直接执行 `fn()` 而不收集依赖，是为了防止用户把 runner 当普通函数调用时意外重新建立依赖（停止语义更强、更可预期）。

---

## 5. reactive.ts + baseHandlers.ts：Proxy 响应式对象

### 5.1 `reactive(target)`（reactive.ts）

文件： [packages/reactivity/src/reactive.ts](packages/reactivity/src/reactive.ts)

策略：

- 只接受对象：非对象原样返回
- 两层缓存/判定：
  - `reactiveMap: WeakMap<raw, proxy>`：同一个 raw 只创建一个 proxy
  - `reactiveSet: WeakSet<proxy>`：用来判断某值是不是 reactive proxy

流程：

1. `!isObject(target)` → return target
2. `existingProxy = reactiveMap.get(target)` → 有则复用
3. `isReactive(target)` → 已经是 proxy，直接返回
4. `new Proxy(target, mutableHandlers)`
5. 写入 `reactiveMap/reactiveSet`

### 5.2 `mutableHandlers.get`（baseHandlers.ts）

文件： [packages/reactivity/src/baseHandlers.ts](packages/reactivity/src/baseHandlers.ts)

- `track(target, key)`：读取即收集
- `result = Reflect.get(...)`
- 返回值规则：
  1. 若 `result` 是 ref：返回 `result.value`（自动解包）
  2. 若 `result` 是对象：返回 `reactive(result)`（深层响应式，按需代理）
  3. 否则：返回原值

**记忆**：你的实现是“访问到对象才递归 reactive”，不是一次性深拷贝。

### 5.3 `mutableHandlers.set`（baseHandlers.ts）

写入规则分三段：

1. ref 赋值语义（类似 Vue3）：

- 若旧值是 ref 且新值不是 ref：
  - `oldValue.value = newValue`
  - return true
  - （后续不再触发 `target.key`，因为 ref 内部会 trigger 自己的 subs）

1. 普通写入：

- `Reflect.set(...)`
- 若 `hasChanged(newValue, oldValue)`：`trigger(target, key)`

1. 数组 length 隐式更新：

- 记录 `oldLength`，写入后拿 `newLength`
- 若 target 是数组，`newLength !== oldLength` 且 `key !== 'length'`：
  - `trigger(target, 'length')`

### 5.4 个人思考（为什么这样设计）

- `reactiveMap`（raw->proxy）+ `reactiveSet`（识别 proxy）是“既要缓存，又要防重复代理”的组合：
  - 只用 Map 不够：proxy 作为入参时要能快速识别并直接返回；
  - 只用 Set 也不够：raw 需要对应唯一 proxy，避免多个代理导致依赖分裂。
- `get` 时才把嵌套对象转为 reactive（惰性代理）能显著降低初始化成本：大对象未访问的分支不创建代理。
- 自动解包 ref（`get` 返回 `ref.value`）和 `set` 的“写入 ref.value”语义，是为了把模板/用户心智简化成“像普通属性一样读写”，把 ref 的存在尽量隐藏在实现层。
- 数组 `length` 的“隐式更新”处理（写索引导致 length 变）是为了对齐 JS 行为：用户没有显式写 length，但语义上 length 的依赖确实该被触发。

---

## 6. ref.ts：RefImpl 与工具方法

文件： [packages/reactivity/src/ref.ts](packages/reactivity/src/ref.ts)

### 6.1 Ref 是什么（在本实现中）

- `RefImpl` 实现了 `Dependency`
  - 自己维护 `subs/subsTail`
- 用 `ReactiveFlags.IS_REF = '__v_isRef'` 标记

### 6.2 `RefImpl.value` 的 get/set

get：

- 若存在 `activeSub` → `trackRef(this)`（内部 `link(dep, activeSub)`）
- 返回 `_value`

set：

- 若 `!hasChanged(newValue, this._value)` return
- 新值是对象 → 转 reactive
- `triggerRef(this)`（内部 `propagate(dep.subs)`）

### 6.3 `ref/isRef/unref`

- `ref(value)` → `new RefImpl(value)`
- `isRef(x)` → 看 `x && x[IS_REF]`
- `unref(x)` → ref 解包，否则原样返回

### 6.4 `toRef/toRefs`

- `toRef(obj, key)` 返回 `ObjectRefImpl`：
  - 读写都直接代理到 `obj[key]`
  - 同样打了 `__v_isRef` 标记

> 注意：这里返回的是“属性引用”，不是把属性变成真正的独立 ref。

### 6.5 `proxyRefs(target)`

- get：`unref(Reflect.get(...))` → 自动解包
- set：
  - 若旧值是 ref 且新值不是 ref → 写 `oldValue.value = newValue`
  - 否则正常 `Reflect.set`

### 6.6 个人思考（为什么这样设计）

- ref 选择自己维护 `subs`（而不是复用 `targetMap` 那套）是为了把“单值依赖”做成更轻的依赖项：ref 本身就是一个 dep，不需要 target/key 两级索引。
- `RefImpl` 在 set 时把对象转 reactive，是为了保证“ref 包对象”也能深层响应；否则 `ref({a:1}).value.a++` 就不会触发。
- `toRef/toRefs` 的价值在于“保持引用关系”：做解构时不丢响应式连接，这是 composition API 里非常常用的需求。
- `proxyRefs` 属于语法糖：把“读时 unref、写时智能写入旧 ref.value”集中处理，减少业务层显式 `.value` 的噪音。

---

## 7. computed.ts：ComputedRefImpl（既是 dep 也是 sub）

文件： [packages/reactivity/src/computed.ts](packages/reactivity/src/computed.ts)

### 7.1 computed 的双重身份

- 作为 **ref/dependency**：
  - 有 `subs/subsTail`
  - 访问 `computed.value` 时，会 `link(this, activeSub)` 让外部 effect/watch 订阅它

- 作为 **sub**：
  - 有 `deps/depsTail/tracking/dirty`
  - `update()` 时会执行 getter 并收集它内部依赖

### 7.2 惰性计算与脏标记

- `dirty = true` 初始为脏
- `get value()`：
  1. 若 `dirty` → 调 `update()`（重新计算）
  2. 若存在 `activeSub` → `link(this, activeSub)`（让外部订阅 computed）
  3. 返回 `_value`

> 你这里的 `update()` 并没有显式把 `dirty` 设回 false；实际“是否重复更新”的控制主要在 system.ts 的 `propagate` 里通过 `dirty` 字段和调度流程来做。

### 7.3 `update(): boolean`

流程基本复用 `ReactiveEffect.run()` 的模式：

1. 保存 `prevSub`
2. `setActiveSub(this)`
3. `startTrack(this)`
4. 记录 `oldValue`
5. 执行 `this._value = this.fn()`
6. `endTrack(this)` + `setActiveSub(prevSub)`
7. 返回 `hasChanged(this._value, oldValue)`

### 7.4 写入 computed

- 若提供 setter：调用 setter
- 否则 `console.warn('computed value is readonly')`

### 7.5 个人思考（为什么这样设计）

- computed 之所以要“既是 Sub 又是 Dependency”，是因为它在依赖图里处于中间层：
  - 向上读底层响应式数据（需要订阅它们）；
  - 向下被外部 effect/watch 订阅（需要被订阅）。
- 惰性计算的核心收益是：不被读取就不计算，且读取时才会把 getter 的依赖建立起来；这能避免大量“只是声明但没用到”的派生值带来运行时成本。
- `update()` 返回“值是否变化”是为了让传播更精确：派生值没变就不通知下游，整体更新链路更短。

---

## 8. watch.ts：侦听器的实现方式（基于 effect.scheduler）

文件： [packages/reactivity/src/watch.ts](packages/reactivity/src/watch.ts)

### 8.1 source 类型支持

- ref（含 computed）：getter = `() => source.value`
- reactive：getter = `() => source`，并且默认 `deep = true`
- function：getter = source（用户 getter）

> 本实现未覆盖数组 sources 的分支（注释里提到了“多个数据源组成的数组”，但代码没有实现对应处理）。

### 8.2 once

- 若 `once`：把 cb 包一层，cb 执行后 `stop()`

### 8.3 deep

- deep 开启后：
  - `baseGetter = getter`
  - `depth = deep === true ? Infinity : deep`
  - 新 getter = `() => traverse(baseGetter(), depth)`

`traverse` 会递归读取对象每个 key，触发 Proxy get，从而把依赖收集起来。

- `seen` Set 防止循环引用死循环
- `depth` 递减控制最大深度

### 8.4 onCleanup

- watch 内部维护 `cleanup` 变量
- `onCleanup(fn)` 只是把 `cleanup = fn`
- `job()` 执行时：
  1. 若有 cleanup：先执行并置空
  2. `newValue = effect.run()`
  3. `cb(newValue, oldValue, onCleanup)`
  4. `oldValue = newValue`

### 8.5 immediate

- immediate：直接 `job()`（因此会调用 cb）
- 否则：先 `oldValue = effect.run()`，仅建立依赖与初值

### 8.6 stop

- 返回 `stop()` 调用 `effect.stop()` 解除依赖

### 8.7 个人思考（为什么这样设计）

- watch 复用 effect 的机制（`effect.scheduler = job`）非常“经济”：依赖收集、分支清理、stop 都直接沿用 effect 的能力，watch 只需要关心“何时执行回调、如何拿新旧值”。
- `onCleanup` 的语义是为了解决竞态/过期：当下一次 job 触发时先清理上一次副作用（例如取消请求/清 timer），避免旧任务污染新结果。
- deep 通过 `traverse` 强制读取每个属性来建立依赖，是一种“把依赖收集当成副作用”的技巧：不需要专门的递归订阅逻辑，只要触发 getter，就自然会走 track。
- `seen` 防循环引用是深度遍历的必要安全阀，否则响应式对象里出现自引用会直接递归爆栈。

---

## 9. 典型调用链速记（背这几条就够用）

### 9.1 effect 依赖收集

1. `effect(fn)` → new `ReactiveEffect(fn)` → `run()`
2. `run()`：`setActiveSub(effect)` + `startTrack(effect)`
3. fn 内部读取 reactive/ref/computed：
   - reactive get → `track(target, key)` → `link(dep, activeSub)`
   - ref get → `trackRef(ref)` → `link(ref, activeSub)`
   - computed get → 若 dirty 则 `update()`（computed 作为 sub 收集 deps）→ `link(computed, activeSub)`
4. fn 完成：`endTrack(effect)` 清理分支依赖

### 9.2 trigger 触发更新

- reactive set → `trigger(target, key)` → `propagate(dep.subs)`
- ref set → `triggerRef(ref)` → `propagate(ref.subs)`

`propagate` 内：

- computed：`update()`，值变了才继续 `propagate(computed.subs)`
- effect：`notify()` → `scheduler()`（默认 run）

### 9.3 分支切换的依赖清理（最常考）

- 第 1 次 run：依赖链表记录为 `sub.deps = [a, b, c]`
- 第 2 次 run：如果分支变了只访问 `[a, c]`
  - `startTrack` 重置 `depsTail = undefined`
  - 访问 a：复用 head
  - 访问 c：复用后续匹配节点
  - `endTrack` 会把 `depsTail.nextDep` 之后的旧节点（比如 b）清掉

---

## 10. 快速自测清单（复习用）

### 10.1 我能说清楚 `Dependency/Sub/Link` 三者字段分别是什么吗？

答案：

- `Dependency`（可被订阅的依赖项）
  - `subs: Link | undefined`：订阅者链表头
  - `subsTail: Link | undefined`：订阅者链表尾
  - 典型实现：`Dep`（target.key 的桶）、`RefImpl`、`ComputedRefImpl`
- `Sub`（订阅者，会读取依赖并在依赖变更时被通知）
  - `deps: Link | undefined`：该 sub 订阅过的依赖链表头
  - `depsTail: Link | undefined`：依赖链表尾，同时也是“本轮复用对齐指针”
  - `tracking: boolean`：是否正处于依赖收集期（防重入/循环触发）
  - `dirty: boolean`：调度去重标记（本轮 propagate 是否已经排过队）
  - 典型实现：`ReactiveEffect`、`ComputedRefImpl`
- `Link`（dep 与 sub 的连接节点，同时属于两条链）
  - 指向双方：`dep` / `sub`
  - 在 dep.subs 链表中的指针：`nextSub` / `prevSub`
  - 在 sub.deps 链表中的指针：`nextDep`

### 10.2 我能从 `effect.run()` 推导出“为什么 startTrack/endTrack 可以清理分支依赖”吗？

答案：

- `run()` 每次执行前会 `startTrack(this)`，把 `depsTail = undefined`，表示“本轮复用从头开始”。
- 依赖收集时，每次读到一个 dep 会调用 `link(dep, sub)`：
  - 先尝试复用 `sub.deps` 链表中“当前位置”的节点（按访问顺序对齐）。
  - 能对齐就推进 `depsTail`；对齐不了就创建新 Link，并把 `nextDep` 指向“旧链表里还没复用到的部分”。
- `run()` 结束 `finally` 里调用 `endTrack(this)`：
  - 如果 `depsTail && depsTail.nextDep`：说明尾部之后的旧依赖本轮没复用到 → `clearTracking(depsTail.nextDep)` 精准清掉多余依赖。
  - 如果 `!depsTail && sub.deps`：说明本轮一个依赖都没收集到 → 清空全部旧依赖。
- 结论：分支切换时，“未走到的分支依赖”自然落在 `depsTail.nextDep` 后面，所以能被自动清理。

### 10.3 我能解释 `propagate` 为什么要 `queuedEffect`，以及为什么 computed 要先 update 再通知吗？

答案：

- `propagate(subs)` 遍历 dep 的订阅者链表（`dep.subs`）。
- 对每个 sub，会先判断 `!sub.tracking && !sub.dirty`：
  - `tracking`：避免执行过程中再次触发导致循环。
  - `dirty`：同一轮传播里去重（防止多次 notify）。
- 一旦决定调度，会先 `sub.dirty = true`。
- computed 先处理、effect 后处理（`queuedEffect`）：
  - computed：通过 `processComputedUpdate` 调 `computed.update()`，只有当值真的变化（`update()` 返回 true）才继续 `propagate(computed.subs)`。
  - effect：先放入 `queuedEffect`，等遍历结束后再统一 `notify()`。
- 这样做的主要好处：
  - 保持遍历稳定：避免在遍历 dep.subs 的过程中直接执行 effect（effect.run 可能增删 Link）导致链表结构变化。
  - 保证派生值一致：computed 若会变化，优先算出新值再执行依赖它的 effect，下游更容易读到更新后的 computed.value。

### 10.4 我能写出 reactive.get/reactive.set/ref.get/ref.set 的依赖收集/触发点吗？

答案：

- reactive.get（Proxy `get`）
  - 入口：[packages/reactivity/src/baseHandlers.ts](packages/reactivity/src/baseHandlers.ts)
  - `track(target, key)`：把 `activeSub` 与 `target.key` 对应 dep 连接起来
  - 返回值：ref 自动解包；对象按需递归 `reactive`；否则原值
- reactive.set（Proxy `set`）
  - 若旧值是 ref 且新值不是 ref：写 `oldValue.value = newValue`，由 ref 自己触发，不再 trigger target.key
  - 否则 `Reflect.set`，若 `hasChanged` 则 `trigger(target, key)`
  - 若数组且 length 隐式变化：额外 `trigger(target, 'length')`
- ref.get（`RefImpl.value` getter）
  - 若 `activeSub` 存在：`trackRef(this)` → `link(this, activeSub)`
- ref.set（`RefImpl.value` setter）
  - `hasChanged` 才更新 `_value`（对象会转 `reactive`）
  - `triggerRef(this)` → `propagate(this.subs)`

### 10.5 我能说明数组 length 两种触发路径：显式写 length / 隐式改索引导致 length 变化吗？

答案：

- 显式写 `arr.length = newLen`
  - 触发 `trigger(target, 'length')` 的专门分支
  - 遍历 `depsMap`：触发所有 `depKey >= newLen` 的索引依赖以及 `length` 依赖（因为截断索引会变为 `undefined`）
- 隐式写索引导致 length 变化（如 `arr[0]=...` 或 `arr[100]=...`）
  - `set` 里先按该索引 key 触发一次
  - 检测到 length 变化且 `key !== 'length'`，再补触发 `trigger(target, 'length')` 通知 length 的订阅者

### 10.6 我能说明 watch 的实现核心就是 `effect.scheduler = job` 吗？

答案：

- `watch(source, cb, options)` 会把 source 归一成 `getter`（ref/reactive/function 三类）。
- 创建 `const effect = new ReactiveEffect(getter)`，并把 `effect.scheduler = job`。
- 之后依赖变化时：
  - 走 `propagate` → `effect.notify()` → `scheduler()` → `job()`。
- `job()` 做的事：
  - 先执行上一次注册的 `cleanup`（如果有），再 `newValue = effect.run()` 得到新值
  - 调用 `cb(newValue, oldValue, onCleanup)` 并更新 `oldValue`
- `stop()` 直接复用 `effect.stop()` 解除依赖。

---

## 11. 面试题（常考 & 高质量）

### 11.1 解释 `Dependency` / `Sub` / `Link` 的关系；为什么 Link 要同时挂在两条链表上？

参考答案：

- `Dependency` 表示“被订阅的东西”，通过 `subs/subsTail` 维护订阅者列表。
- `Sub` 表示“订阅者”，通过 `deps/depsTail` 维护它订阅过哪些依赖。
- `Link` 是连接节点，同时属于两条链：
  - 在 `dep.subs` 链中用于从依赖出发枚举所有订阅者；
  - 在 `sub.deps` 链中用于从订阅者出发快速解绑/清理旧依赖。
- 这样设计的核心好处是“双向可达”：触发更新时从 dep 找 sub 很快，stop/分支切换时从 sub 精准解除订阅也很快，不需要全局扫描。

追问点与答案：

- 追问：为什么 Link 在 dep.subs 方向还要有 `prevSub`（双向）？
  答：清理订阅时需要 O(1) 从 dep 的订阅者链表摘除节点并维护头尾；如果只有单向链表就需要从头遍历找到前驱，stop/分支切换会退化。
- 追问：为什么 sub.deps 方向只用 `nextDep`（单向）也够？
  答：sub 侧主要用途是“按访问顺序遍历/对齐复用”与“从某个节点开始清理尾巴”；不需要在 sub 链表里做 O(1) 反向删除（删除发生在 dep.subs 双向链表上）。

### 11.2 `activeSub` 为什么是全局可变？嵌套 effect/computed 不保存 `prevSub` 会怎样？

参考答案：

- `activeSub` 是依赖收集的“隐式上下文”，读取发生时（track/link）不需要把订阅者作为参数层层传递。
- 嵌套场景必须保存/恢复 `prevSub`：
  - 否则内层 effect/computed 执行完后，外层的收集上下文会丢失或被污染；
  - 结果是外层读取到的依赖可能错误地记在内层 sub 上，或压根没被记录，导致更新不触发/触发错对象。

追问点与答案：

- 追问：这相当于“栈”吗？为什么代码里只用一个 `prevSub`？
  答：是的，本质是调用栈。每次 `run/update` 进入时保存当前 `activeSub` 到局部变量，退出时还原；嵌套多层会形成多层局部变量链条，等价于栈。
- 追问：`activeSub` 与 `tracking` 有什么区别？
  答：`activeSub` 表示“当前谁在收集依赖（上下文是谁）”；`tracking` 表示“这个 sub 是否处于收集阶段（状态开关）”，用于 propagate 时跳过正在收集的 sub，避免循环触发。

### 11.3 `link(dep, sub)` 的复用策略如何工作？访问顺序变了会怎样？

参考答案：

- 每轮收集前 `startTrack(sub)` 把 `depsTail` 置为 `undefined`，表示“复用对齐从头开始”。
- `link` 会拿到“下一次可复用节点”`nextDep`：
  - 若 `depsTail` 为 `undefined`，从 `sub.deps` 头开始；否则从 `depsTail.nextDep` 开始。
- 如果 `nextDep.dep === dep`，直接复用该节点并推进 `depsTail`。
- 若访问顺序变了（或依赖集合变了），对齐失败就会走“新增节点”流程，并把新节点的 `nextDep` 指向旧链表里尚未复用的部分。
- 收集结束后 `endTrack` 会把 `depsTail.nextDep` 之后的旧节点清掉（即：顺序改变/分支改变导致未复用的旧依赖）。

追问点与答案：

- 追问：为什么复用需要“访问顺序”对齐？如果顺序变了会怎样？
  答：这是用时间换空间/简单性的策略：按顺序对齐可以 O(n) 复用；顺序变了就会新增 Link，并在 `endTrack` 清掉未复用的尾部旧节点（正确但会有更多增删/复用开销）。
- 追问：`link` 里为什么不遍历 dep.subs 查重，避免重复订阅？
  答：查重需要每次 track 都线性扫描订阅者链表（热路径更慢）。本实现用“复用对齐 + endTrack 清理 + dirty 去重”来保持行为正确，并用对象池减少增删成本。

### 11.4 分支切换如何自动清理？给 if/else 例子说明。

参考答案：

- 分支切换本质是“本轮读取到的 key 集合”和上一轮不同。
- 由于复用按读取顺序对齐，本轮没读到的旧依赖会落在 `depsTail.nextDep` 之后；`endTrack` 会统一清理这些多余节点。
- 例子：
  - 第一次 `ok=true` 读取 `a`，deps=[a]
  - 切换 `ok=false` 读取 `b`，复用对齐失败→新增 b，并在 `endTrack` 时把旧的 a 清掉，最终 deps=[b]

追问点与答案：

- 追问：如果两条分支都读取了同一个 key（比如都读 `a`），会不会被清掉？
  答：不会。两条分支共同依赖的部分在每轮都会被访问到，复用对齐会推进 `depsTail`，因此不会落入“未复用尾巴”被清理。
- 追问：为什么清理发生在 `finally` 的 `endTrack`，而不是每次 if/else 判断时？
  答：依赖集合只有在 fn 执行完才能确定；统一在 `endTrack` 收尾清理能保证正确性与实现简洁，并且与复用策略天然契合。

### 11.5 `endTrack` 为何要处理两种情况？分别对应什么场景？

参考答案：

- `depsTail && depsTail.nextDep`：本轮复用了“部分旧依赖”，但尾部之后还有“本轮没用到”的旧节点 → 精准清尾巴。
- `!depsTail && sub.deps`：本轮一个依赖都没收集到（例如 effect 的 fn 没读任何响应式值，或 stop 时人为制造“本轮未复用任何依赖”）→ 清空全部旧依赖。

追问点与答案：

- 追问：什么时候会出现“本轮一个依赖都没收集到”，但上一轮有依赖？
  答：常见是分支/早返回：例如上轮读了 `state.a`，这轮因为条件不成立直接 return；还有 `stop()` 主动让本轮复用指针为空，从而触发清空。
- 追问：为什么要把清理的 Link 放进 `linkPool`？
  答：减少频繁分配/回收带来的 GC 压力，尤其在分支切换或大量 effect 的场景中，复用能稳定吞吐。

### 11.6 `propagate` 中 `tracking` 与 `dirty` 各解决什么问题？去掉会怎样？

参考答案：

- `tracking`：表示 sub 正在收集依赖。
  - propagate 时跳过 `tracking` 的 sub，可以避免“执行中触发自身”造成递归/死循环（典型：effect 里写了自己依赖的值）。
- `dirty`：调度去重。
  - 一轮 propagate 中同一个 sub 可能被多次遇到（例如多个 key 触发、或链路中重复触发），`dirty` 让它最多只被调度一次。
- 去掉 `tracking`：更容易出现循环触发、栈溢出。
- 去掉 `dirty`：更容易出现重复执行、性能抖动，甚至在复杂链路下出现非预期的多次回调。

追问点与答案：

- 追问：`dirty` 什么时候被清回 false？
  答：在 `endTrack(sub)` 里统一 `sub.dirty = false`，代表这一轮执行/更新完成，允许下一轮再次被调度。
- 追问：`tracking` 什么时候置为 true/false？
  答：`startTrack(sub)` 置 true，`endTrack(sub)` 置 false；effect.run 与 computed.update 都会包裹这对调用。

### 11.7 为什么 effect 要 queued 再统一 notify？遍历时直接执行有什么风险？

参考答案：

- effect.run 会进行依赖收集与清理（会改动 link/链表结构）。
- 如果在遍历 `dep.subs` 的过程中立刻执行 effect：
  - 可能导致当前遍历的链表被修改，出现跳节点、重复节点、甚至指针错误的风险。
- 统一 notify 让“遍历阶段”和“执行阶段”分离，遍历更稳定；同时 computed 可以先更新，保证下游 effect 更可能读到一致的新派生值。

追问点与答案：

- 追问：这是不是“异步队列/微任务队列”？
  答：不是。这里的 `queuedEffect` 只是同一轮 propagate 内的临时数组，最终仍同步 `forEach(notify)` 执行；它解决的是遍历稳定性与执行顺序问题。
- 追问：如果 effect 的 scheduler 自己做异步（比如 setTimeout），这套机制还成立吗？
  答：成立。propagate 只负责调用 `notify()`；真正何时执行由 scheduler 决定。同步/异步差异不会破坏依赖关系，但会影响更新时序。

### 11.8 computed 为什么既是 Dependency 又是 Sub？它在依赖图里处于什么位置？

参考答案：

- computed 向上依赖响应式数据（它的 getter 会读 reactive/ref），所以它必须作为 `Sub` 去订阅上游 deps。
- computed 向下被 effect/watch 读取（读取 `computed.value`），所以它必须作为 `Dependency` 让下游订阅它。
- 因此 computed 是依赖图中的“中间节点/派生节点”：上游变→它可能更新→再通知下游。

追问点与答案：

- 追问：代码里怎么区分“这是 computed 还是 effect”？
  答：在 `propagate` 里通过 `'update' in sub` 判断；computed 实现了 `update()`，effect 没有。
- 追问：为什么 computed 也会被 `isRef` 识别成 ref？
  答：`ComputedRefImpl` 也设置了 `ReactiveFlags.IS_REF`，这样 computed.value 的使用体验与 ref 一致，并可被 watch 的“ref 分支”统一处理。

### 11.9 computed 的更新链路：从底层变更到触发下游，完整路径是什么？

参考答案：

1. 底层 reactive/ref 被写入：进入 `trigger(...)` 或 `triggerRef(...)`。
2. 找到对应 `dep.subs`，调用 `propagate`。
3. propagate 遇到 computed（通过 `'update' in sub` 判断）：
   - 调 `computed.update()` 重新计算；
   - 若值变化且 computed 有订阅者（`computed.subs` 存在）→ 继续 `propagate(computed.subs)`。
4. 下游若是 effect：被放入 `queuedEffect`，最后 `notify()` → `scheduler()` → `run()`。
5. 下游若是 watch：本质也是 effect（`ReactiveEffect`），只是 `scheduler` 被改成 `job()`。

追问点与答案：

- 追问：为什么要等 `computed.update()` 返回“值变了”才继续通知下游？
  答：避免无意义的级联更新。派生值没变时，下游 effect/watch 重新执行只会浪费性能，且可能造成多余副作用。
- 追问：computed 没人订阅时，依赖变更会发生什么？
  答：通常不会主动向下传播；computed 维持惰性，等下一次有人读取 `computed.value` 才重新计算。

### 11.10 computed 的 `dirty` 与 effect 的 `dirty` 何时 true/false？为何初始值不同？

参考答案：

- 在本实现里，`dirty` 首要是“调度去重标记”：propagate 调度前设为 true，`endTrack` 结束追踪时清回 false。
- computed 另外还承担“缓存可能过期”的心智：初始为 true 是为了第一次读取必须计算。
- effect 初始为 false 是因为 `effect(fn)` 创建后立刻 `run()` 了一次，“第一次执行”已经发生，不需要表达“待执行”。
- 更细节可参见第 12.1 节。

追问点与答案：

- 追问：computed 的 `dirty` 初始为 true，会不会导致“永远不更新”（propagate 跳过 dirty=true）？
  答：不会。computed 第一次被读取时会调用 `update()`，而 `update()` 内部会 `startTrack/endTrack`，其中 `endTrack` 会把 `dirty` 置回 false；之后上游依赖触发 propagate 才能正常调度 computed。
- 追问：为什么 effect 初始不是 true（让它“等触发再跑”）？
  答：你这份实现的 `effect(fn)` 语义是“创建后立即执行一次以建立依赖并产出副作用”；因此初始不需要表示待执行。

### 11.11 `targetMap` 为何用 `WeakMap`？改成 `Map` 会出现什么问题？给例子。

参考答案：

- `targetMap` 的 key 是原始 target 对象；用 `WeakMap` 不会阻止 GC 回收 target。
- 若改成 `Map`：即使业务侧已经丢弃对象引用，依赖表仍强引用 target，导致依赖数据常驻内存（典型泄漏）。
- 例子：组件卸载后，state/raw 对象不再被引用，但 Map 仍以它为 key 存着 depsMap，长期累积会增长。

追问点与答案：

- 追问：WeakMap 的 key 被 GC 后，对应的 value（depsMap）会怎样？
  答：会一并变为不可达并被 GC 回收；这正是用 WeakMap 的意义（不会人为延长 target 生命周期）。
- 追问：为什么 reactive 的缓存（raw->proxy）也常用 WeakMap？
  答：同样是生命周期问题：缓存不应该阻止 raw 被回收，否则会把临时对象的代理永久留在内存。

### 11.12 `depsMap` 为何必须是 `Map` 而不是 `WeakMap`？

参考答案：

- `depsMap` 的 key 是属性 key（string/symbol/number），WeakMap 的 key 必须是对象，不满足类型约束。
- 另外数组 `length` 的触发需要遍历 `depsMap.forEach(...)`，Map 天然支持遍历。

追问点与答案：

- 追问：能不能用普通对象 `{}` 当 depsMap？
  答：不理想。key 可能是 symbol/number（数组索引），对象 key 会被字符串化且不便处理 symbol；同时遍历/增删语义也不如 Map 清晰。
- 追问：为什么数组 length 分支需要遍历 depsMap，而不是只触发 length？
  答：因为缩短 length 会影响多个索引读取结果，必须触发被截断的索引依赖才能保证正确性。

### 11.13 数组 length 两类处理分别触发什么依赖，为什么？

参考答案：

- 显式写 `arr.length = newLen`（尤其缩短）：
  - 触发 `length` 依赖本身；
  - 还要触发所有 `index >= newLen` 的索引依赖，因为这些索引读取会从“有值”变为 `undefined`。
- 写索引导致 length 变长（隐式）：
  - 先触发该索引 key 的依赖（因为它确实被写了）；
  - 再额外触发 `length` 依赖（长度变化影响依赖 length 的逻辑）。

追问点与答案：

- 追问：`arr.push(x)` 在这套实现里会触发哪些依赖？
  答：本质是对某个新索引的 set（触发该索引 key），并导致 length 变化（set 里额外触发 `length`）。
- 追问：为什么缩短 length 要触发 `depKey >= newLen`，而不是 `>`？
  答：新 length 为 newLen 时，合法索引范围是 `[0, newLen-1]`，因此 `depKey >= newLen` 的读取都会从“可能有值”变为 `undefined`。

### 11.14 reactive.get 为什么要“ref 自动解包 + 对象按需递归 reactive”？影响是什么？

参考答案：

- ref 自动解包：读取 `state.count` 直接得到数值而不是 `RefImpl`，减少 `.value` 噪音，使用体验更接近普通对象。
- 对象按需递归 reactive：只在真正访问嵌套对象时才创建 proxy，避免一次性深度代理带来的初始化开销。
- 代价/注意：自动解包会引入“写入时特殊处理”（set 时 oldValue 是 ref 的分支），以及需要明确什么时候你拿到的是 ref 本身（例如放在非 reactive 容器里）。

追问点与答案：

- 追问：如果我就是想拿到 ref 本身而不是解包后的值怎么办？
  答：在你的实现里，放在 reactive 对象上读取会自动解包；要拿到 ref 本身通常要避免走 reactive.get（例如把 ref 存在非 reactive 容器、或单独持有该 ref 引用），或者用 `toRef/toRefs` 直接拿“引用对象”。
- 追问：按需递归 reactive 会不会导致“每次访问都创建新 proxy”？
  答：不会。`reactiveMap` 会缓存 raw->proxy，同一个对象只会创建一次代理。

### 11.15 watch 为何能用 `effect.scheduler = job` 复用能力？`onCleanup` 解决什么问题？

参考答案：

- watch 的本质是“对某个 getter 的依赖变化做回调”，依赖收集/清理/stop 都与 effect 完全一致。
- 所以 watch 用 `ReactiveEffect(getter)` 收集依赖，把调度入口改为 `job()` 即可：变化时不直接 run，而是 job 里去 run 并调用 cb。
- `onCleanup` 解决竞态/过期：下一次变化到来先清理上一次副作用（如取消请求/清定时器），避免旧任务回写覆盖新结果。

追问点与答案：

- 追问：`immediate` 与非 immediate 在实现上差异是什么？
  答：`immediate` 直接调用 `job()`，因此会立刻执行 cb；否则先 `oldValue = effect.run()` 只建立依赖并记录初值，等后续变更再由 scheduler 触发 job。
- 追问：`once` 是怎么做到“只触发一次”的？
  答：把用户 cb 包装一层：cb 执行后调用 `stop()`；下一次依赖变更不会再调度该 effect。

### 11.16 stop 为什么能复用 `startTrack + endTrack`？stop 后手动 runner 会怎样？

参考答案：

- stop 的目标是“解除该 effect 与所有依赖的订阅关系”。
- 你的 stop 通过让 `endTrack` 走到“清空全部旧依赖”的分支来完成解绑，从而复用 `system.ts` 的链表清理实现。
- stop 后 `active=false`：
  - 依赖变化不会再触发它（因为已经解绑）；
  - 手动 `runner()` 仍会执行 fn，但 `run()` 会走 `!active` 分支，不会重新收集依赖，因此后续变化依旧不会触发。

追问点与答案：

- 追问：stop 和 watch 的 cleanup（onCleanup）有什么关系？
  答：stop 是“解绑依赖关系，不再响应变化”；cleanup 是“在下一次 job 执行前清理上一次副作用”。stop 不会自动调用 cleanup（你的实现里 cleanup 只在 job 内触发）。
- 追问：为什么 runner 上要挂 `runner.effect = reactive`？
  答：方便从 runner 访问到底层 `ReactiveEffect` 实例（例如调用 `runner.effect.stop()`），同时保持 runner 仍是可调用函数。

---

## 12. 重点易混淆点（为什么这样做 + 例子）

这一节专门回答“为什么这么设计/这么写”，并给最小例子帮助你形成运行时直觉。

### 12.1 `dirty`：computed 和 effect 为什么初始值不同？

相关实现：

- effect： [packages/reactivity/src/effect.ts](packages/reactivity/src/effect.ts)
- computed： [packages/reactivity/src/computed.ts](packages/reactivity/src/computed.ts)
- 触发与去重： [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)

在你的实现里，`dirty` 实际承担了两类含义（这是最容易混的点）：

1. **调度去重标记**（通用 Sub 语义，system.ts 用它避免重复触发）

- `propagate` 中：只有当 `!sub.tracking && !sub.dirty` 才会调度
- 一旦决定调度：会先 `sub.dirty = true`，表示“本轮已经排过队了”
- 在 `endTrack(sub)` 结束追踪时：会 `sub.dirty = false`，为下一轮更新做准备

2. **缓存是否失效**（更贴近 computed 心智：值是否需要重新计算）

- 对 computed 来说，“依赖变了”意味着缓存失效；对 effect 来说没有“缓存值”，所以它只需要去重，不需要表达“值是否过期”。

因此初始值不同是合理的：

- `ComputedRefImpl.dirty = true`：**第一次访问 `computed.value` 必须计算一次**，否则 `_value` 没意义。
- `ReactiveEffect.dirty = false`：effect 在 `effect(fn)` 创建时会立刻 `run()` 一次，**第一次已经执行过**，此时不需要表达“有待执行”。

最小例子（感受“第一次访问/是否立刻执行”）：

```ts
const state = reactive({ n: 1 })

const c = computed(() => {
  console.log('computed getter run')
  return state.n + 1
})

// 这里不会打印 getter：因为 computed 还没被读取（惰性）

effect(() => {
  console.log('effect run', state.n)
})
// 这里会立刻打印一次：effect 创建时立刻 run()

console.log('read computed', c.value)
// 这里第一次读取才会打印 'computed getter run'
```

再补一个“dirty 去重”的直觉例子：

```ts
const state = reactive({ a: 1, b: 2 })

effect(() => {
  // 同一个 effect 依赖 a 和 b
  console.log(state.a + state.b)
})

// 如果某次更新链路里 a、b 都被触发到了（或同一个 key 多次触发），
// dirty 能让该 effect 在同一轮 propagate 中最多只被调度一次。
```

### 12.2 computed 为什么“有订阅者时会更积极更新”，没订阅者则保持惰性？

相关实现： [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)

`processComputedUpdate` 的关键判断是：

- 只有当 `computed.subs` 存在（有人订阅 computed）时才 `computed.update()`，并在值变化时继续向下 `propagate(computed.subs)`。

这背后的动机：

- **没人用 computed 的结果时，不值得做任何额外工作**；依赖变了就把它标记为“可能过期”（dirty），等下次有人读再算。
- **有人订阅时要尽量保持依赖图的及时性**：否则下游 effect/watch 可能拿到旧值。

例子（没人订阅 vs 有人订阅）：

```ts
const state = reactive({ n: 1 })
const c = computed(() => state.n + 1)

state.n++
// 如果没有任何 effect/watch 读取过 c.value，通常不会发生 computed.update 的传播工作。

effect(() => {
  console.log('use computed', c.value)
})
// 一旦有人订阅 computed，后续 state.n 变化会通过 computed 把更新继续向下传。
```

### 12.3 为什么 `targetMap` 用 `WeakMap`，而 `depsMap` 用 `Map`？

相关实现： [packages/reactivity/src/dep.ts](packages/reactivity/src/dep.ts)

结论先行：这是“内存生命周期 + key 类型约束”共同决定的。

- `targetMap: WeakMap<target, depsMap>`
  - **好处：不阻止 GC 回收 target**。
  - 响应式系统里 target 往往是短生命周期对象（组件卸载、临时对象等）。如果用 `Map`，哪怕外部不再引用 target，依赖表仍然把它强引用住 → 易泄漏。

- `depsMap: Map<key, Dep>`
  - `key` 可能是 string / symbol / number（数组索引、`length` 等），**WeakMap 的 key 必须是对象**，不适用。
  - 你的实现里还需要在数组 `length` 分支中 `depsMap.forEach(...)` 遍历所有 key 来决定触发哪些索引依赖；`Map` 迭代非常直接。

例子（为什么 WeakMap 能避免“卸载后还留着依赖”）：

```ts
let obj = { a: 1 }
const state = reactive(obj)
effect(() => state.a)

// 业务里：组件卸载/引用断开
obj = null
// 若 targetMap 是 WeakMap：当没有其它强引用指向原始 target 时，依赖表可被 GC 回收
// 若 targetMap 是 Map：Map 会一直强引用 key，容易导致依赖表常驻内存
```

### 12.4 为什么要“把 effects 先收集到 queuedEffect，再统一 notify”？

相关实现： [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)

你的 `propagate` 做了两件事：

- computed：在遍历过程中就优先处理（可能继续触发它的订阅者）
- effect：先塞到 `queuedEffect`，遍历结束后再统一 `notify()`

这样做的常见收益：

- **避免遍历过程中直接执行 effect 导致链表结构被改写**（effect.run 会触发 track/endTrack，可能增删 Link），从而让当前这轮遍历更稳定。
- **让 computed 的“值变化”先被计算出来**，再触发依赖 computed 的 effect，有助于下游拿到更新后的派生值。

直觉例子（effect 里读取 computed）：

```ts
const state = reactive({ n: 1 })
const c = computed(() => state.n + 1)

effect(() => {
  // effect 依赖 computed
  console.log('effect sees', c.value)
})

state.n++
// propagate 时如果先让 computed 更新，再执行 effect，effect 更容易拿到一致的新值。
```

### 12.6 为什么 `ReactiveEffect.stop()` 用 `startTrack + endTrack` 来清理？

相关实现：

- stop： [packages/reactivity/src/effect.ts](packages/reactivity/src/effect.ts)
- 清理逻辑： [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)

你的 `stop()` 逻辑是：先 `startTrack(this)` 把本轮复用指针重置为“一个都没复用”，再 `endTrack(this)` 走到 `!depsTail && sub.deps` 分支，从而把旧依赖全部解绑。

为什么要这么写：

- **复用同一套链表解绑逻辑**：解绑 dep↔sub 的细节（双向链表摘除、维护头尾、回收到 `linkPool`）集中在 `system.ts`，stop 不需要重复实现，正确性更容易保证。
- **语义统一**：`endTrack` 的职责本来就是“清理本轮没用到的依赖”；stop 等价于“本轮一个都不想要”→ 自然清空全部。
- **实现更短也更不容易漏边界**：比如 dep 链表头/尾、prev/next 修复这种细节，放在一个地方处理更稳。

最小例子（stop 后不再响应；手动 runner 也不会重新收集依赖）：

```ts
const state = reactive({ n: 1 })

const runner = effect(() => {
  console.log('run', state.n)
})

state.n++ // 触发 effect
runner.effect.stop()
state.n++ // 不再触发

runner() // 仍会执行 fn，但不会重新建立依赖（active=false）
state.n++ // 依然不触发
```

### 12.7 数组 `length`：缩短 length vs 写索引导致变长，有什么不同？

相关实现：

- `trigger` 的 length 分支： [packages/reactivity/src/dep.ts](packages/reactivity/src/dep.ts)
- `set` 的隐式 length 触发： [packages/reactivity/src/baseHandlers.ts](packages/reactivity/src/baseHandlers.ts)

你的实现把数组长度变化拆成两种语义：

1. **显式写 `arr.length = newLen`（尤其是缩短）**

- 进入 `trigger(target, 'length')` 的特殊分支。
- 遍历 `depsMap`：触发 `depKey >= newLen` 的索引依赖，以及 `length` 自身依赖。

为什么要触发“被截断索引”的依赖：因为 `arr[2]` 这种读取的结果会从“有值”变成 `undefined`。

例子（缩短 length 影响索引读取）：

```ts
const arr = reactive([10, 20, 30])

effect(() => {
  console.log('arr[2]=', arr[2])
})

arr.length = 2
// arr[2] 从 30 变为 undefined，所以必须触发依赖 arr[2] 的 effect
```

2. **写索引导致 `length` 变长（隐式更新）**

- 例如 `arr[0] = 'x'` 或 `arr[100] = 1`。
- `set` 会先按 key 触发一次 `trigger(target, key)`，然后检测到 length 变化，再额外 `trigger(target, 'length')`。

为什么只“额外触发 length”：因为索引 key 的依赖已经触发过了；额外变化的是 `length`，需要通知依赖 length 的订阅者（例如渲染列表长度、边界判断）。

例子（写索引触发 length 依赖）：

```ts
const arr = reactive([])

effect(() => {
  console.log('len=', arr.length)
})

arr[0] = 'x'
// 触发：length 从 0 -> 1
```

### 12.5 为什么要有 `linkPool`（Link 对象池）？用 `nextDep` 串起来有什么含义？

相关实现： [packages/reactivity/src/system.ts](packages/reactivity/src/system.ts)

动机：分支切换/条件依赖会导致 Link 节点频繁创建与销毁。

- 直接 new/GC：实现简单，但在高频更新/大依赖图下会有明显 GC 压力。
- 对象池复用：把开销从 GC 转为“复用节点 + 重置字段”，吞吐更稳定。

为什么用 `nextDep` 串对象池：

- Link 结构里 `nextDep` 本来就用于 sub.deps 单向链表；当节点被回收时，`dep/sub/prevSub/nextSub` 都会被清空。
- 此时用 `nextDep` 作为 free-list 指针最省字段，不需要额外的 `nextFree`。

例子（分支切换导致大量 Link 变动）：

```ts
const state = reactive({ ok: true, a: 1, b: 2 })

effect(() => {
  // ok 不同会走不同分支，依赖集合变化
  if (state.ok) {
    state.a
  } else {
    state.b
  }
})

state.ok = false
state.ok = true
// 频繁切换会频繁清理/新增 Link；linkPool 让这类场景更“抗抖动”。
```
