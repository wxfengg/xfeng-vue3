import { hasChanged, isObject } from '@vue/shared'
import { track, trigger } from './dep'
import { isRef } from './ref'
import { reactive } from './reactive'

/** 代理对象的 Handlers */
export const mutableHandlers: ProxyHandler<Record<string | symbol, unknown>> = {
  get(target, key, receiver) {
    // 访问属性收集依赖，建立 target.key 和 sub 之间的链表关系
    track(target, key)

    const result: any = Reflect.get(target, key, receiver)
    // - 如果取到的是 Ref 则返回 Ref 的 value
    // - 如果取到的是对象则转换为响应式对象
    // - 否则返回原值
    return isRef(result)
      ? result.value
      : isObject(result)
        ? reactive(result)
        : result
  },
  set(target, key, newValue, receiver) {
    // 如果新值和旧值相等，不触发更新
    const oldValue: any = target[key]
    const result = Reflect.set(target, key, newValue, receiver)

    // 如果传入的值是 ref 且 newValue 不是 ref，则把 newValue 赋值给 ref 的 value
    // 如果传入的值是 ref 且 newValue 也是 ref, 则不用管了
    if (isRef(oldValue) && !isRef(newValue)) {
      // 这里会触发 ref 的 set，从而触发 ref 的依赖更新，所以后续不需要再触发 target.key 的更新
      oldValue.value = newValue
      return result
    }

    if (hasChanged(newValue, oldValue)) {
      // 属性修改后 并且 如果新值和旧值不相等 通知更新
      trigger(target, key)
    }

    return result
  },
}
