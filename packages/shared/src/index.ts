/**
 * 判断是否为对象
 * @param value 输入的值
 * @returns 返回boolean
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
