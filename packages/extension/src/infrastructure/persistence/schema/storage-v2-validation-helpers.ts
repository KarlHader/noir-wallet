export function isStorageV2Record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertStorageV2ExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new Error('Storage V2 record has invalid keys')
  }
}

export function parseStorageV2String(value: unknown, label: string, maxLength = 4_096): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maxLength
  ) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

export function parseStorageV2Timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

export function parseStorageV2Derivation(value: unknown) {
  if (!isStorageV2Record(value)) throw new Error('Invalid derivation descriptor')
  assertStorageV2ExactKeys(value, ['scheme', 'path'])
  return Object.freeze({
    scheme: parseStorageV2String(value.scheme, 'derivation scheme', 128),
    path: parseStorageV2String(value.path, 'derivation path', 512)
  })
}
