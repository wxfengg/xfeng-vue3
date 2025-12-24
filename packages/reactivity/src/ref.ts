import { activeSub } from './effect'

enum ReactivityFlags {
  IS_REF = '__v_isRef',
}

class RefImpl {
  // ref的值
  _value: any
  // 收集到的sub
  subs = new Set<Function>();
  // 是否为Ref的标记
  [ReactivityFlags.IS_REF] = true
  constructor(value: any) {
    this._value = value
  }

  get value() {
    console.log('我被访问了,count => ', this._value)
    if (typeof activeSub === 'function') {
      this.subs.add(activeSub)
    }
    return this._value
  }

  set value(value) {
    this._value = value
    console.log('我被修改了,count => ', value)
    if (!this.subs.size) return
    this.subs.forEach(sub => sub())
  }
}

export function ref(value) {
  return new RefImpl(value)
}

/** 判断是否为Ref */
export function isRef(value) {
  return !!(value && value[ReactivityFlags.IS_REF])
}
