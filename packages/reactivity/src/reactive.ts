import { isObject } from '@vue/shared'
import { mutableHandlers } from './baseHandlers'

export function reactive(target) {
  return createReactiveObject(target)
}

/** 缓存 源对象 和 响应式代理对象 之间的映射关系 避免重复创建 */
const reactiveMap = new WeakMap()
/** 缓存 响应式代理对象 避免重复创建 */
const reactiveSet = new WeakSet()

/**
 * 创建响应式代理对象
 * @param target 用于创建代理对象的源对象
 * @returns
 */
function createReactiveObject(target) {
  // reactive 只接受对象 如果 target 不是对象，原路返回
  if (!isObject(target)) return target

  // 如果 target 已经有对应的响应式代理对象，直接返回缓存的代理对象
  const existingProxy = reactiveMap.get(target)
  if (existingProxy) return existingProxy

  // 如果 target 已经是响应式代理对象，直接返回
  if (isReactive(target)) return target

  // 创建响应式代理对象并返回
  const proxyObj = new Proxy(target, mutableHandlers)

  // 把 源对象 和 响应式代理对象 的映射关系 存到 reactiveMap 里面
  reactiveMap.set(target, proxyObj)
  // 把 响应式代理对象 存到 reactiveSet 里面
  reactiveSet.add(proxyObj)

  return proxyObj
}

/** 判断是否为Reactive */
export function isReactive(value: unknown): boolean {
  return reactiveSet.has(value as object)
}
