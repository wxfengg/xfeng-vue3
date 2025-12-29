import { hasChanged, isObject } from '@vue/shared'
import { activeSub } from './effect'
import { link, propagate, type Dependency, type Link } from './system'
import { reactive } from './reactive'

enum ReactivityFlags {
  IS_REF = '__v_isRef',
}

class RefImpl {
  // ref的值
  _value: unknown;
  // 是否为Ref的标记
  [ReactivityFlags.IS_REF] = true
  // 订阅者链表的头节点
  subs: Link | undefined
  // 订阅者链表的尾节点
  subsTail: Link | undefined

  constructor(value: any) {
    // 如果传入的是对象则转换为响应式对象，否则正常取值
    this._value = isObject(value) ? reactive(value) : value
  }

  get value() {
    // 访问 ref 的时候收集依赖
    if (activeSub) trackRef(this)

    return this._value
  }

  set value(newValue) {
    // 如果新值和旧值相等，不触发更新
    if (!hasChanged(newValue, this._value)) return

    this._value = isObject(newValue) ? reactive(newValue) : newValue

    // 如果 ref 更新，重新触发 effect 执行函数
    triggerRef(this)
  }
}

export function ref(value) {
  return new RefImpl(value)
}

/** 判断是否为Ref */
export function isRef(value) {
  return !!(value && value[ReactivityFlags.IS_REF])
}

/**
 * 收集依赖，建立 ref 和 effect 之间的链表关系
 * @param dep
 */
export function trackRef(dep: Dependency) {
  if (activeSub) link(dep, activeSub)
}

/**
 * 触发 依赖项 关联的 订阅者 重新执行
 * @param dep 依赖项
 */
export function triggerRef(dep: Dependency) {
  if (dep.subs) propagate(dep.subs)
}
