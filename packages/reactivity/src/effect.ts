export let activeSub

export class ReactiveEffect {
  constructor(public fn) {}

  run() {
    // 当 effect 里面嵌套 effect 的时候，需要保存当前的 effect
    const prevSub = activeSub
    activeSub = this
    try {
      return this.fn()
    } finally {
      // 执行完成当前的 effect 将 activeSub 设置为上一次保存的 effect
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
