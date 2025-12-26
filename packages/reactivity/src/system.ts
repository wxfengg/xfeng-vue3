import { type ReactiveEffect } from './effect'

export interface Link {
  /** 链表当前节点的 effect */
  sub: ReactiveEffect
  /** 链表当前节点的 下一个节点 */
  next: Link
  /** 链表当前节点的 上一个节点 */
  prev: Link
}

/**
 * 收集依赖 收集Ref的effect
 * @param dep 当前的 ref 对象
 * @param sub effect函数
 */
export function link(dep, sub) {
  // 1.根据sub构建一个link节点
  const newLink: Link = {
    sub,
    next: undefined,
    prev: undefined,
  }

  // 2.判断是否有尾节点
  if (dep.subsTail) {
    // 如果有则在尾节点后面加入新点
    dep.subsTail.next = newLink
    newLink.prev = dep.subsTail
    dep.subsTail = newLink
  } else {
    // 如果没有说明链表是空的，直接加入即可
    dep.subs = newLink
    dep.subsTail = newLink
  }
}

/**
 * 触发effect更新
 * @param dep 当前的 ref 对象
 */
export function propagate(subs) {
  let currentLink = subs
  let queuedEffect = []
  while (currentLink) {
    queuedEffect.push(currentLink.sub)
    currentLink = currentLink.next
  }

  queuedEffect.forEach(effect => effect.run())
}
