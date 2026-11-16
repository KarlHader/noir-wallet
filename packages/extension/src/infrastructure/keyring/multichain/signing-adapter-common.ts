import type { ChainId } from '@/core/chains/domain'
import type { CanonicalContent } from '@/core/keyring/domain/signing-summary'
import type { PreparedSigningCommand, SigningCommandId } from '@/core/keyring/ports/signing'

export const MAX_SIGNING_ACCOUNT_INDEX = 0x7fffffff

const textEncoder = new TextEncoder()
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })

export function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value)
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}

export async function canonicalContent(
  bytes: Uint8Array,
  preferred: 'utf8' | 'base64'
): Promise<CanonicalContent> {
  let encoding: CanonicalContent['encoding'] = preferred
  let value: string
  if (preferred === 'utf8') {
    try {
      value = strictTextDecoder.decode(bytes)
      if (textEncoder.encode(value).byteLength !== bytes.byteLength) {
        throw new Error('invalid UTF-8')
      }
    } catch {
      encoding = 'hex'
      value = `0x${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
    }
  } else {
    value = btoa(String.fromCharCode(...bytes))
  }
  return Object.freeze({
    encoding,
    value,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes)
  })
}

export function preparedCommand(
  commandId: SigningCommandId,
  chainId: ChainId,
  operation: 'transaction' | 'message',
  summary: PreparedSigningCommand['summary'],
  digestHex: string,
  expiresAt: number
): PreparedSigningCommand {
  return Object.freeze({
    commandId,
    chainId,
    operation,
    summary,
    payloadFingerprint: Object.freeze({ algorithm: 'sha256', digestHex }),
    execution: Object.freeze({ kind: 'internal' }),
    expiresAt
  })
}
