import { wordlist } from '@scure/bip39/wordlists/english'

const MAX_DEPTH = 4
const recoveryWords = new Set(wordlist)
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get

export const DIAGNOSTIC_LOG_MAX_ENTRIES = 500
export const DIAGNOSTIC_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const DIAGNOSTIC_LOG_MAX_ENTRY_BYTES = 2 * 1024
export const DIAGNOSTIC_LOG_MAX_TOTAL_BYTES = 512 * 1024

export function isDiagnosticContextId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|context-\d+)$/.test(value)
  )
}

export function getDiagnosticErrorDetails(error: unknown): unknown {
  return projectError(error, new WeakSet(), 0)
}

function projectError(error: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (error === null || error === undefined) return error
  if (typeof error !== 'object') {
    return typeof error === 'string' || typeof error === 'number' || typeof error === 'boolean'
      ? error
      : '[Non-standard error]'
  }
  if (seen.has(error)) return '[Circular error]'
  if (depth >= MAX_DEPTH) return '[Error cause truncated]'
  seen.add(error)

  try {
    const fields: Record<string, unknown> = {}
    for (const key of [
      'name',
      'message',
      'code',
      'status',
      'statusCode',
      'type',
      'retryable',
      'details',
      'stack',
      'cause'
    ]) {
      let owner: object | null = error
      let descriptor: PropertyDescriptor | undefined
      for (let level = 0; owner && level < MAX_DEPTH; level += 1) {
        descriptor = Object.getOwnPropertyDescriptor(owner, key)
        if (descriptor) break
        owner = Object.getPrototypeOf(owner)
      }
      if (!descriptor) continue
      let value: unknown
      if ('value' in descriptor) {
        value = descriptor.value
      } else if (
        key === 'stack' &&
        error instanceof Error &&
        nativeStackGetter &&
        descriptor.get === nativeStackGetter
      ) {
        // V8 exposes its lazy native stack through a shared accessor. Custom
        // accessors stay excluded, just like other error payload properties.
        value = nativeStackGetter.call(error)
      } else {
        continue
      }
      if (key === 'cause') {
        fields.cause = projectError(value, seen, depth + 1)
      } else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        fields[key] = value
      }
    }
    return Object.keys(fields).length ? fields : '[Non-standard error without diagnostic fields]'
  } catch {
    return '[Unserializable error]'
  } finally {
    seen.delete(error)
  }
}

function redactRecoveryPhrases(value: string): string {
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  let end = 0
  let count = 0
  const finish = () => {
    if (count >= 12) ranges.push({ start, end })
    count = 0
  }
  for (const match of value.matchAll(/\b[a-z]+\b/gi)) {
    const index = match.index ?? 0
    if (!recoveryWords.has(match[0].toLowerCase())) {
      finish()
      continue
    }
    if (count && !/^\s+$/.test(value.slice(end, index))) finish()
    if (!count) start = index
    end = index + match[0].length
    count += 1
  }
  finish()
  let result = ''
  let cursor = 0
  for (const range of ranges) {
    result += value.slice(cursor, range.start) + '[Recovery phrase redacted]'
    cursor = range.end
  }
  return result + value.slice(cursor)
}

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type DiagnosticLogSource = 'background' | 'popup' | 'offscreen' | 'worker'

export interface DiagnosticLogDraft {
  source: DiagnosticLogSource
  level: DiagnosticLogLevel
  message: string
  timestamp: number
  sequence: number
  contextId?: string
}

export interface DiagnosticLogEntry extends DiagnosticLogDraft {
  id?: number
  byteSize: number
}

const encoder = new TextEncoder()
const SECRET_KEY =
  /mnemonic|seed|password|passphrase|private.?key|spending.?key|viewing.?key|ufvk|ciphertext|key.?material|secret|credential|signature|memo|token|auth/i
const PRIVATE_KEY = /amount|balance|value|fee|price|usd/i
const IDENTIFIER_KEY =
  /address|wallet.?id|account.?id|transaction.?id|tx.?hash|txid|request.?id|origin|domain|hostname|endpoint/i

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength
}

export function truncateDiagnosticText(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value
  const suffix = '...[Truncated]'
  const bytes = encoder.encode(value)
  let end = Math.max(0, maxBytes - utf8Length(suffix))
  let prefix = new TextDecoder().decode(bytes.slice(0, end))
  while (utf8Length(prefix) > maxBytes - utf8Length(suffix)) {
    end -= 1
    prefix = new TextDecoder().decode(bytes.slice(0, end))
  }
  return `${prefix}${suffix}`
}

function redactText(input: string): string {
  input = redactRecoveryPhrases(input)
  const redacted = input
    .replace(
      /["']?\b(seed(?:\s*phrase)?|mnemonic)\b["']?\s*[:=]\s*["']?((?:[a-z]{2,}\s+){11,23}[a-z]{2,})["']?/gi,
      '$1=[Recovery phrase redacted]'
    )
    .replace(
      /["']?\b(seed(?:\s*phrase)?|mnemonic|password|passphrase|private[\s_-]*key|spending[\s_-]*key|viewing[\s_-]*key|ufvk|ciphertext|key[\s_-]*material|credential|signature|memo|auth(?:orization)?[\s_-]*token|access[\s_-]*token|refresh[\s_-]*token)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      '$1=[Redacted]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [Redacted]')
    .replace(/\buview1[a-z0-9]+\b/gi, '[Viewing key redacted]')
    .replace(
      /["']?\b(amount|balance|fee|price|value|usd(?:\s*value)?|transparent|shielded|sapling|orchard|ironwood|unshielded|spendable|available|pending|total)(?:\s+balance)?\b["']?\s*[:=]\s*["']?-?\d+(?:\.\d+)?/gi,
      '$1=[Redacted]'
    )
    .replace(
      /["']?\b(address|walletId|accountId|transactionId|txHash|txid|requestId|origin|domain|hostname|endpoint)\b["']?\s*[:=]\s*(?:\[Redacted identifier\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      '$1=[Redacted identifier]'
    )
    .replace(/-?\d+(?:\.\d+)?\s*(?:ZEC|zatoshis?|USD)\b/gi, '[Redacted amount]')
    .replace(/\b(?:https?|wss?):\/\/[^\s)\]}>,]+/gi, '[URL]')
    .replace(
      /\b(?:u1|utest1|zs1|ztestsapling1|t1|t2|t3|tm)[a-zA-Z0-9]{28,}\b/g,
      '[Redacted address]'
    )
    .replace(/\b(?:bc1|tb1|bcrt1)[a-z0-9]{25,90}\b/gi, '[Redacted address]')
    .replace(/\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, '[Redacted address]')
    .replace(/\b0x[0-9a-fA-F]{40,}\b/g, '[Redacted identifier]')
    .replace(/\b[a-z0-9_-]{2,64}\.(?:near|testnet)\b/gi, '[Redacted address]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '[Redacted address]')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[Redacted identifier]')
    .replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      '[Redacted identifier]'
    )
  return /^(?:[a-z]{2,}\s+){11,23}[a-z]{2,}$/i.test(redacted.trim())
    ? '[Recovery phrase redacted]'
    : redacted
}

function serialize(value: unknown, depth = 0, key = ''): unknown {
  if (SECRET_KEY.test(key) || PRIVATE_KEY.test(key)) return '[Redacted]'
  if (IDENTIFIER_KEY.test(key)) return '[Redacted identifier]'
  if (depth >= 4) return '[MaxDepth]'
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number') return PRIVATE_KEY.test(key) ? '[Redacted]' : value
  if (typeof value === 'bigint') return '[Redacted]'
  if (typeof value === 'boolean' || value === null) return value
  if (value instanceof Error) return serialize(getDiagnosticErrorDetails(value), depth, key)
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
  if (typeof URL !== 'undefined' && value instanceof URL) return '[Redacted URL]'
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
    return `[ArrayBuffer:${value.byteLength} bytes]`
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))
    return `[${Object.prototype.toString.call(value).slice(8, -1)}:${value.byteLength} bytes]`
  if (typeof Blob !== 'undefined' && value instanceof Blob) return `[Blob:${value.size} bytes]`
  if (Array.isArray(value)) return value.slice(0, 50).map(item => serialize(item, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    let descriptors: PropertyDescriptorMap
    try {
      descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
      return '[Unserializable]'
    }
    for (const property of Object.keys(descriptors).sort().slice(0, 30)) {
      const descriptor = descriptors[property]
      if (!descriptor?.enumerable) continue
      result[property] =
        'value' in descriptor
          ? serialize(descriptor.value, depth + 1, property)
          : '[Unserializable]'
    }
    return result
  }
  return value === undefined ? '[Undefined]' : String(value)
}

export function serializeDiagnosticArgs(args: unknown[]): string {
  const message = args
    .map(value => {
      const safe = serialize(value)
      return typeof safe === 'string' ? safe : JSON.stringify(safe)
    })
    .join(' ')
  return truncateDiagnosticText(message, DIAGNOSTIC_LOG_MAX_ENTRY_BYTES)
}

export function sanitizeDiagnosticMessage(message: string): string {
  return truncateDiagnosticText(redactText(message), DIAGNOSTIC_LOG_MAX_ENTRY_BYTES)
}

export function getDiagnosticEntryByteSize(entry: Pick<DiagnosticLogEntry, 'message'>): number {
  return utf8Length(entry.message) + 64
}

export function retainDiagnosticEntries<T extends DiagnosticLogEntry>(
  entries: T[],
  now = Date.now()
): T[] {
  const cutoff = now - DIAGNOSTIC_LOG_MAX_AGE_MS
  const eligible = entries
    .filter(entry => entry.timestamp >= cutoff && entry.timestamp <= now + 300_000)
    .sort((left, right) => left.timestamp - right.timestamp || (left.id ?? 0) - (right.id ?? 0))
  const retained: T[] = []
  let totalBytes = 0
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const entry = eligible[index]
    const bytes = entry.byteSize || getDiagnosticEntryByteSize(entry)
    if (
      retained.length >= DIAGNOSTIC_LOG_MAX_ENTRIES ||
      totalBytes + bytes > DIAGNOSTIC_LOG_MAX_TOTAL_BYTES
    )
      break
    retained.push(entry)
    totalBytes += bytes
  }
  return retained.reverse()
}

export function parseDiagnosticLogDraft(value: unknown): DiagnosticLogDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Partial<DiagnosticLogDraft>
  if (
    !['background', 'popup', 'offscreen', 'worker'].includes(draft.source ?? '') ||
    !['debug', 'info', 'warn', 'error'].includes(draft.level ?? '') ||
    typeof draft.message !== 'string' ||
    !Number.isFinite(draft.timestamp) ||
    (draft.contextId !== undefined && !isDiagnosticContextId(draft.contextId)) ||
    !Number.isSafeInteger(draft.sequence) ||
    (draft.sequence ?? -1) < 0
  )
    return null
  return {
    source: draft.source as DiagnosticLogSource,
    level: draft.level as DiagnosticLogLevel,
    message: truncateDiagnosticText(draft.message, DIAGNOSTIC_LOG_MAX_ENTRY_BYTES),
    timestamp: draft.timestamp as number,
    sequence: draft.sequence as number,
    ...(draft.contextId ? { contextId: draft.contextId } : {})
  }
}
