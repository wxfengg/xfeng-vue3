import { activeSub } from './effect'
import { link, propagate } from './system'

interface Link {
  /** 链表当前节点的 effect */
  sub: Function
  /** 链表当前节点的 下一个节点 */
  next: Link
  /** 链表当前节点的 上一个节点 */
  prev: Link
}

enum ReactivityFlags {
  IS_REF = '__v_isRef',
}

class RefImpl {
  // ref的值
  _value: unknown;
  // 是否为Ref的标记
  [ReactivityFlags.IS_REF] = true
  // 订阅者链表的头节点
  subs: Link
  // 订阅者链表的尾节点
  subsTail: Link

  constructor(value: any) {
    this._value = value
  }

  get value() {
    // 访问 ref 的时候收集依赖
    if (activeSub) trackRef(this)

    return this._value
  }

  set value(value) {
    this._value = value

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
export function trackRef(dep) {
  if (activeSub) link(dep, activeSub)
}

/**
 * 触发 ref 关联的 effect 重新执行
 * @param dep
 */
export function triggerRef(dep) {
  if (dep.subs) propagate(dep.subs)
}
