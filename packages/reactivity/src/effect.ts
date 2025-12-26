export let activeSub

export class ReactiveEffect {
  constructor(public fn) {}

  run() {
    activeSub = this
    try {
      return this.fn()
    } finally {
      activeSub = undefined
    }
  }
}

export function effect(fn) {
  const reactive = new ReactiveEffect(fn)
  reactive.run()
}
