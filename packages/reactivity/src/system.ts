import { ComputedRefImpl } from './computed'

/** 依赖项链表节点 */
export interface Dependency {
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
  /** 是否正在收集依赖 */
  tracking: boolean
  /** 是否脏值 */
  dirty: boolean
}

export interface Link {
  /** 订阅者链表节点 */
  sub: Sub | undefined
  /** 下一个订阅者节点 */
  nextSub: Link | undefined
  /** 上一个订阅者节点 */
  prevSub: Link | undefined
  /** 依赖项链表节点 */
  dep: Dependency | undefined
  /** 下一个依赖项节点 */
  nextDep: Link | undefined
}

/** 链表节点对象池，用于复用 link 节点 */
let linkPool: Link | undefined = undefined

/**
 * 建立依赖项、订阅者和链表之间的关联关系
 * @param dep 依赖项
 * @param sub 订阅者
 */
export function link(dep: Dependency, sub: Sub) {
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
  // - 如果 currentDep 是 undefined：从 sub.deps（头节点）开始，如果头节点也没有则说明链表为空，走新增节点流程
  // - 否则：从 currentDep.nextDep（下一个依赖项节点）开始
  const nextDep = currentDep === undefined ? sub.deps : currentDep.nextDep

  // 3) 如果可复用的依赖项节点存在且它的 dep 正好等于当前正在收集的 dep：说明可直接复用
  if (nextDep && nextDep.dep === dep) {
    // 推进尾指针并提前返回：不创建新节点，也不改动双向链表关系
    sub.depsTail = nextDep
    return
  }

  // 新增节点的时候判断链表中是否有相同的 sub ，有的话不新增（源码写法，时间换空间）
  // let currentSub = dep.subs
  // while (currentSub) {
  //   if (currentSub.sub === sub) return
  //   currentSub = currentSub.nextSub
  // }

  // 新增节点流程
  // 1.构建一个link节点
  let newLink: Link | undefined = undefined
  if (linkPool) {
    // 如果对象池有可用的节点，则从对象池中取出一个节点进行复用
    newLink = linkPool
    linkPool = linkPool.nextDep

    newLink.sub = sub
    newLink.dep = dep
    newLink.nextDep = nextDep
  } else {
    // 如果对象池没有可用的节点，则新建一个
    newLink = {
      sub,
      nextSub: undefined,
      prevSub: undefined,
      dep,
      nextDep,
    }
  }

  // 2.建立 dep 和 链表 之间的关联关系
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

  // 3.建立 sub 和 链表 之间的关联关系
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
 * 处理计算属性的更新逻辑
 * @param dep 计算属性此时作为依赖项的身份
 */
function processComputedUpdate(dep: ComputedRefImpl) {
  // 触发计算属性的更新
  // - 要重新访问计算属性的值才会重新计算.
  // - 计算属性的值发生变化后，继续触发它的订阅者更新

  // 1. 调用计算属性的 update 方法，重新计算值并收集依赖，update 内部会返回一个boolean表示值是否变化
  if (dep.subs && dep.update()) {
    // 2. 触发计算属性的订阅者更新
    propagate(dep.subs)
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
    const sub = currentLink.sub
    // 如果正在追踪依赖不触发更新，避免循环触发
    if (!sub.tracking && !sub.dirty) {
      // 更新的时候标记为脏值，说明 sub 已经执行，下次不需要再执行
      // 对应 link 方法里面的判断是否有相同的 sub 逻辑（时间换空间写法）
      sub.dirty = true
      if ('update' in sub) {
        // 如果有 update 方法，说明是计算属性
        processComputedUpdate(sub as ComputedRefImpl)
      } else {
        queuedEffect.push(sub)
      }
    }
    currentLink = currentLink.nextSub
  }

  queuedEffect.forEach(effect => effect.notify())
}

/**
 * 开始追踪依赖，重置 depsTail
 * @param sub 订阅者
 */
export function startTrack(sub: Sub) {
  sub.tracking = true
  sub.depsTail = undefined
}

/**
 * 结束追踪依赖，清理多余的依赖项
 * @param sub 订阅者
 * @returns
 */
export function endTrack(sub: Sub) {
  sub.tracking = false
  sub.dirty = false

  // 1. 拿到当前 sub 的 depsTail
  const depsTail = sub.depsTail

  // 2. 清除依赖
  //  - 如果 depsTail 和它的 nextDep 都有，删除它的所有依赖关系
  //  - 如果 depsTail 没有，但是有 sub 的 deps，说明收集不到依赖，清理掉全部没用的依赖
  if (depsTail && depsTail.nextDep) {
    clearTracking(depsTail.nextDep)
    depsTail.nextDep = undefined
  }

  if (!depsTail && sub.deps) {
    clearTracking(sub.deps)
    sub.deps = undefined
  }
}

/**
 * 清理依赖关系
 * @param link 要清理的节点
 */
function clearTracking(link: Link) {
  while (link) {
    const { prevSub, nextSub, dep, nextDep } = link
    if (prevSub) {
      // 如果有上一个节点
      prevSub.nextSub = nextSub
      link.nextSub = undefined
    } else {
      // 如果没有，说明是头节点
      dep.subs = nextSub
    }

    if (nextSub) {
      // 如果有下一个节点
      nextSub.prevSub = prevSub
      link.prevSub = undefined
    } else {
      // 如果没有，说明是尾节点
      dep.subsTail = prevSub
    }

    link.dep = link.sub = undefined

    // 把不要的节点给 linkPool 复用，节省内存
    link.nextDep = linkPool
    linkPool = link

    link = nextDep
  }
}
