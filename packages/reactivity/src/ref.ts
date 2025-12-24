import { activeSub } from './effect'

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
    if (activeSub) {
      // 1.如果有sub 根据sub构建一个link节点
      const newLink: Link = {
        sub: activeSub,
        next: undefined,
        prev: undefined,
      }

      // 2.判断是否有尾节点
      if (this.subsTail) {
        // 如果有则在尾节点后面加入新点
        this.subsTail.next = newLink
        newLink.prev = this.subs
        this.subsTail = newLink
      } else {
        // 如果没有说明链表是空的，直接加入即可
        this.subs = newLink
        this.subsTail = newLink
      }
    }

    return this._value
  }

  set value(value) {
    this._value = value

    // 如果 ref 更新，重新触发 effect 执行函数
    let currentLink = this.subs
    while (currentLink) {
      currentLink.sub?.()
      currentLink = currentLink.next
    }
  }
}

export function ref(value) {
  return new RefImpl(value)
}

/** 判断是否为Ref */
export function isRef(value) {
  return !!(value && value[ReactivityFlags.IS_REF])
}
