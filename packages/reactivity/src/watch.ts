import { isFunction, isObject } from '@vue/shared'
import { ReactiveEffect } from './effect'
import { isRef } from './ref'
import { isReactive } from './reactive'

/**
 * 侦听器
 * @param source 数据源： 可以是一个 ref (包括计算属性)、一个响应式对象、一个 getter 函数、或多个数据源组成的数组
 * @param cb 侦听器回调函数
 * @param options 配置项
 * @returns
 */
export function watch(source, cb, options) {
  /**
   * 选项说明
   * immediate: 是否立即执行回调函数
   * once: 只执行一次回调函数
   * deep: 是否深度监听
   */
  let { immediate, once, deep } = options || {}

  // 保存 source 的 getter 函数
  let getter: () => unknown
  // 如果监听对象是 ref 返回 ref 的 value
  if (isRef(source)) getter = () => source.value
  // 如果监听对象是 reactive，返回对象本身
  if (isReactive(source)) {
    getter = () => source
    // 使用 reactive 的时候 watch 默认就是深度监听
    // 如果传了 deep 选项，就以传的为准
    if (!deep) deep = true
  }
  // 如果 source 是函数，说明用户传入的是 getter 函数
  if (isFunction(source)) getter = source

  // 如果传了 once 说明只执行一次回调函数
  if (once) {
    // 把 cb 变为 原来的cb + stop函数 即可，在job里面触发 cb 就可以触发到新的 cb(原cb + stop)
    const _cb = cb
    cb = (...args) => {
      _cb(...args)
      stop()
    }
  }

  // 开启深度监听
  if (deep) {
    const baseGetter = getter
    const depth = deep === true ? Infinity : deep
    getter = () => traverse(baseGetter(), depth)
  }

  /** 保存用户的 onCleanup 函数 */
  let cleanup = null
  /**
   * 注册用户的 onCleanup 函数
   * 当执行 job 的时候会先执行 cleanup 函数
   */
  function onCleanup(cb) {
    cleanup = cb
  }

  /** 保存旧值 */
  let oldValue

  /**
   * 负责执行回调函数的方法
   * 默认在 effect 的 scheduler调度函数 中执行
   */
  function job() {
    // 执行回调函数前先执行 cleanup 函数，再执行回调函数
    if (cleanup) {
      cleanup()
      cleanup = null
    }

    // 获取到最新 getter 的返回值，也就是 source.value 的值
    const newValue = effect.run()
    // 执行 watch 的回调函数，传递 newValue 和 oldValue
    cb(newValue, oldValue, onCleanup)
    // 下一次的 oldValue 是这一次的 newValue
    oldValue = newValue
  }

  const effect = new ReactiveEffect(getter)
  effect.scheduler = job

  if (immediate) {
    // 如果是立即执行，直接调用 job 方法执行回调函数
    job()
  } else {
    // 否则先执行一次 effect，拿到初始值赋值给 oldValue
    oldValue = effect.run()
  }

  // 返回一个函数 用来停止监听
  function stop() {
    effect.stop()
  }

  return stop
}

/**
 * 深度遍历对象的每一个属性，触发 getter 操作从而建立依赖关系
 * @param value 需要遍历的值
 * @param seen 用来记录已经遍历过的对象，防止循环引用导致死循环
 * @returns 返回传入的值
 */
function traverse(value: unknown, depth = Infinity, seen = new Set()) {
  // 如果不是对象，不用递归，原路返回
  if (!isObject(value)) return value
  // 达到最大深度，原路返回
  if (depth <= 0) return value

  // 如果已经遍历过了，直接返回，防止循环引用导致死循环
  if (seen.has(value)) return value
  // 记录已经遍历过的对象
  seen.add(value)

  // 每遍历一层，深度减一
  depth--
  for (const key in value) {
    traverse(value[key], depth, seen)
  }

  return value
}
