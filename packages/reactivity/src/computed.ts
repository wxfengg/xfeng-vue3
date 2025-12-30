import { hasChanged, isFunction } from '@vue/shared'
import { ReactivityFlags } from './ref'
import { Dependency, endTrack, link, Link, startTrack, Sub } from './system'
import { activeSub, setActiveSub } from './effect'

export class ComputedRefImpl implements Dependency, Sub {
  // computed 也是一个 ref，通过 isRef 也返回 true. 标记为 Ref
  [ReactivityFlags.IS_REF] = true
  // 保存 getter 的值
  _value: unknown

  /** 订阅者链表的头节点 */
  subs: Link | undefined
  /** 订阅者链表的尾节点 */
  subsTail: Link | undefined
  /** 依赖项链表头节点 */
  deps: Link | undefined
  /** 依赖项链表尾节点 */
  depsTail: Link | undefined
  /** 是否正在收集依赖 */
  tracking = false
  /**
   * 计算属性是否脏值，默认值为 true
   *
   * 当计算属性依赖的响应式数据发生变化时，会将 dirty 设置为 true
   *
   * 下次访问计算属性的 value 时，会重新计算值
   */
  dirty = true

  constructor(
    public fn: () => unknown,
    private setter?: (value: unknown) => void,
  ) {}

  get value() {
    if (this.dirty) {
      this.update()
    }

    // 作为 Dep 的时候，需要收集依赖，建立和 sub 之间的链表关系
    if (activeSub) link(this, activeSub)

    return this._value
  }

  set value(newValue) {
    if (this.setter) {
      // 如果有 setter 调用用户自定义的 setter 方法
      this.setter(newValue)
    } else {
      console.warn('Write operation failed: computed value is readonly')
    }
  }

  update(): boolean {
    // 作为 Sub 的时候，需要触发更新，建立和 dep 之间的链表关系
    // 当 effect 里面嵌套 effect 的时候，需要保存当前的 effect（解决effect嵌套effect问题）
    const prevSub = activeSub
    setActiveSub(this)
    /**
     * 解决 sub 复用问题
     * 每次 dep 更新通知 sub 执行的时候，先把 sub 的 depsTail 设置为 undefined
     * 这样收集依赖的时候可以通过判断 sub 的 depsTail 是否等于 undefined 来决定复用
     */
    startTrack(this)
    const oldValue = this._value
    try {
      this._value = this.fn()
    } finally {
      // 结束收集依赖，清理多余的依赖项
      // 约定：新增节点的时候会把 nextDep 指向没有被复用的节点，每次 effect 执行完毕后，depsTail 之后的 nextDep 都是多余的，需要清理掉
      endTrack(this)

      // 执行完成当前的 effect 将 activeSub 设置为上一次保存的 effect（解决effect嵌套effect问题）
      setActiveSub(prevSub)
    }

    // 返回值表示值是否发生变化 true 表示发生变化 false 表示没有变化
    return hasChanged(this._value, oldValue)
  }
}

/**
 * computed 计算属性
 * @param getterOrOptions 有可能是一个 函数 也有可能是一个 对象(对象里面有 get 和 set 属性)
 * @returns
 */
export function computed(getterOrOptions) {
  let getter, setter
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  return new ComputedRefImpl(getter, setter)
}
