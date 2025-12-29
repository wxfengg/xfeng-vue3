import { activeSub } from './effect'
import { link, Link, propagate } from './system'

class Dep {
  /** 订阅者链表头节点 */
  subs: Link | undefined
  /** 订阅者链表尾节点 */
  subsTail: Link | undefined
}

/**
 * 依赖项对象的Map
 *
 * 使用 WeakMap 来存储 target 对象到它的 depsMap 的映射
 *
 * 示例：
 * ```ts
 * const state = reactive({ a: 1, b: 2 })
 * targetMap = WeakMap { obj state => Map { 'a' => Dep depA, 'b' => Dep depB } }
 * ```
 */
const targetMap: WeakMap<WeakKey, Map<string | symbol, Dep>> = new WeakMap()

/**
 * 收集依赖
 * @param target 收集依赖的对象
 * @param key 收集依赖的对象的key
 */
export function track(target: Record<string, unknown>, key: string | symbol) {
  if (!activeSub) return

  // 找 depsMap 也就是 targetMap 里面没有关联到 target 的 Map
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    // 没有 depsMap 就初始化一个 depsMap 把他加到 targetMap 里面
    depsMap = new Map()
    targetMap.set(target, depsMap)
  }

  // 找 Dep 也就是 depsMap 里面没有关联到 key 的 Dep
  let dep = depsMap.get(key)
  if (!dep) {
    // 没有 dep 就初始化一个 dep 把他加到 depsMap 里面
    dep = new Dep()
    depsMap.set(key, dep)
  }

  // 建立 dep 和 sub 之间的链表关系
  link(dep, activeSub)
}

/**
 * 触发更新
 * @param target 触发更新的对象
 * @param key 触发更新的对象的key
 */
export function trigger(target: Record<string, unknown>, key: string | symbol) {
  let depsMap = targetMap.get(target)
  // 触发更新的时候发现没有 depsMap 说明 target 没有被 sub 访问过
  if (!depsMap) return

  let dep = depsMap.get(key)
  // 触发更新的时候发现没有 dep 说明 target.key 没有被 sub 访问过
  if (!dep) return

  // 如果找到 dep 的 subs 再通知它们重新执行
  if (!dep.subs) return
  propagate(dep.subs)
}
