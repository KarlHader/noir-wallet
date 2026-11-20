/** Storage may reorder object keys; every JSON key, value and array position must still match. */
export function storageJsonEquals(left: unknown, right: unknown): boolean {
  if (left === null || typeof left !== 'object')
    return (
      (left === null ||
        typeof left === 'string' ||
        typeof left === 'boolean' ||
        (typeof left === 'number' && Number.isFinite(left))) &&
      left === right
    )
  if (right === null || typeof right !== 'object') return false
  if (Array.isArray(left)) {
    if (
      !Array.isArray(right) ||
      left.length !== right.length ||
      Object.keys(left).length !== left.length ||
      Object.keys(right).length !== right.length
    )
      return false
    for (let index = 0; index < left.length; index++) {
      if (
        !Object.prototype.hasOwnProperty.call(left, index) ||
        !Object.prototype.hasOwnProperty.call(right, index) ||
        !storageJsonEquals(left[index], right[index])
      )
        return false
    }
    return true
  }
  if (Array.isArray(right)) return false
  for (const value of [left, right]) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) return false
  }
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      key =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        storageJsonEquals(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key]
        )
    )
  )
}
