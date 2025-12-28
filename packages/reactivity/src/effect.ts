import { endTrack, startTrack, type Link } from './system'

/** 当前的订阅者 */
export let activeSub: ReactiveEffect

export class ReactiveEffect {
  /** 依赖项链表头节点 */
  deps: Link | undefined
  /** 依赖项链表尾节点 */
  depsTail: Link | undefined

  constructor(public fn) {}

  run() {
    // 当 effect 里面嵌套 effect 的时候，需要保存当前的 effect（解决effect嵌套effect问题）
    const prevSub = activeSub
    activeSub = this
    /**
     * 解决 sub 复用问题
     * 每次 dep 更新通知 sub 执行的时候，先把 sub 的 depsTail 设置为 undefined
     * 这样收集依赖的时候可以通过判断 sub 的 depsTail 是否等于 undefined 来决定复用
     */
    startTrack(this)
    try {
      return this.fn()
    } finally {
      // 结束收集依赖，清理多余的依赖项
      // 约定：新增节点的时候会把 nextDep 指向没有被复用的节点，每次 effect 执行完毕后，depsTail 之后的 nextDep 都是多余的，需要清理掉
      endTrack(this)

      // 执行完成当前的 effect 将 activeSub 设置为上一次保存的 effect（解决effect嵌套effect问题）
      activeSub = prevSub
    }
  }

  /**
   * 通知更新的方法
   * 当依赖的数据发生了变化，会调用这个函数
   */
  notify() {
    this.scheduler()
  }

  /**
   * 调度器方法
   * 如果传了 scheduler 就覆盖掉，否则默认调用 run 方法
   */
  scheduler() {
    this.run()
  }
}

export function effect(fn, options) {
  const reactive = new ReactiveEffect(fn)
  // 将传递的 options 合并到 ReactiveEffect 实例对象上
  Object.assign(reactive, options)

  reactive.run()

  // 创建一个“runner”函数：把 ReactiveEffect 实例的 run 方法绑定到当前实例上
  const runner = reactive.run.bind(reactive)

  // 在 runner 函数上挂一个 effect 属性，指回对应的 ReactiveEffect 实例
  runner.effect = reactive

  return runner
}
