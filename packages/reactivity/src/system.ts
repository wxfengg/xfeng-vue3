/** 依赖项链表节点 */
export interface Dep {
  /** 订阅者链表头节点 */
  subs: Link | undefined
  /** 订阅者链表尾节点 */
  subsTail: Link | undefined
}

/** 订阅者链表节点 */
export interface Sub {
  /** 依赖项链表头节点 */
  deps: Link | undefined
  /** 依赖项链表尾节点 */
  depsTail: Link | undefined
}

export interface Link {
  /** 订阅者链表节点 */
  sub: Sub
  /** 下一个订阅者节点 */
  nextSub: Link | undefined
  /** 上一个订阅者节点 */
  prevSub: Link | undefined
  /** 依赖项链表节点 */
  dep: Dep
  /** 下一个依赖项节点 */
  nextDep: Link | undefined
}

/**
 * 建立依赖项、订阅者和链表之间的关联关系
 * @param dep 依赖项
 * @param sub 订阅者
 */
export function link(dep: Dep, sub: Sub) {
  // 收集依赖
  // - 如果 dep 和 sub 之间有关联关系走 -> 复用节点流程
  // 否则走 -> 新增节点流程

  // 复用节点流程
  // 约定：每次 sub 开始重新收集依赖前，会把 sub.depsTail 重置为 undefined。
  // - depsTail === undefined：代表“本轮收集刚开始”，从 deps 头节点开始对齐复用
  // - depsTail !== undefined：代表“本轮已复用了若干节点”，继续尝试复用 depsTail.nextDep

  // 1) 拿到本轮依赖收集的“当前位置”（尾节点/尾指针）
  const currentDep = sub.depsTail

  // 2) 计算下一次可能复用的依赖项节点
  // - 如果 currentDep 是 undefined：从 sub.deps（头节点）开始
  // - 否则：从 currentDep.nextDep（下一个依赖项节点）开始
  const nextDep = currentDep === undefined ? sub.deps : currentDep.nextDep

  // 3) 如果可复用的依赖项节点存在且它的 dep 正好等于当前正在收集的 dep：说明可直接复用
  if (nextDep && nextDep.dep === dep) {
    // 推进尾指针并提前返回：不创建新节点，也不改动双向链表关系
    sub.depsTail = nextDep
    return
  }

  // 新增节点流程
  // 1.构建一个link节点
  const newLink: Link = {
    sub,
    nextSub: undefined,
    prevSub: undefined,
    dep,
    nextDep: undefined,
  }

  // 2.建立 dep 和链表之间的关联关系
  // 判断 dep 是否有尾节点
  if (dep.subsTail) {
    // 如果有则在尾节点后面加入新点
    dep.subsTail.nextSub = newLink
    newLink.prevSub = dep.subsTail
    dep.subsTail = newLink
  } else {
    // 如果没有说明链表是空的，直接加入即可
    dep.subs = newLink
    dep.subsTail = newLink
  }

  // 3.建立 sub 和链表之间的关联关系
  // 判断 sub 是否有尾节点
  if (sub.depsTail) {
    // 如果有则在尾节点后面加入新点
    sub.depsTail.nextDep = newLink
    sub.depsTail = newLink
  } else {
    // 如果没有说明链表是空的，直接加入即可
    sub.deps = newLink
    sub.depsTail = newLink
  }
}

/**
 * 触发订阅者更新
 * @param subs 订阅者头节点
 */
export function propagate(subs: Link | undefined) {
  let currentLink = subs
  let queuedEffect = []
  while (currentLink) {
    queuedEffect.push(currentLink.sub)
    currentLink = currentLink.nextSub
  }

  queuedEffect.forEach(effect => effect.notify())
}
