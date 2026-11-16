import { hashTypedData, type Hex } from 'viem'
import type { ChainId } from '@/core/chains/domain'
import {
  parseSigningSummary,
  type EvmTypedDataValue,
  type SigningSummary
} from '@/core/keyring/domain'

export async function digestLedgerPayload(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function canonicalContent(bytes: Uint8Array) {
  let encoding: 'utf8' | 'hex' = 'utf8'
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!new TextEncoder().encode(value).every((byte, index) => byte === bytes[index])) {
      throw new Error('Non-canonical UTF-8')
    }
  } catch {
    encoding = 'hex'
    value = `0x${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return digestLedgerPayload(bytes).then(sha256 =>
    Object.freeze({ encoding, value, byteLength: bytes.length, sha256 })
  )
}

export async function ledgerEvmPersonalSummary(
  chainId: ChainId,
  address: string,
  bytes: Uint8Array
): Promise<SigningSummary> {
  const message = await canonicalContent(bytes)
  return parseSigningSummary(
    {
      schema: 'evm.personal-message.v1',
      chainId,
      operation: 'message',
      review:
        message.encoding === 'utf8'
          ? { level: 'standard', issues: [] }
          : { level: 'caution', issues: [{ code: 'opaque-message' }] },
      fields: { signer: address, message }
    },
    { family: 'evm', chainId, operation: 'message' }
  )
}

type TypedField = { readonly name: string; readonly type: string }
type TypedTypes = Readonly<Record<string, readonly TypedField[]>>

function typedValue(type: string, value: unknown, types: TypedTypes, depth = 0): EvmTypedDataValue {
  if (depth > 12) throw new Error('Ledger typed data exceeds the maximum depth')
  const array = /^(.*)\[([0-9]*)\]$/.exec(type)
  if (array) {
    if (
      !Array.isArray(value) ||
      value.length > 128 ||
      (array[2] && value.length !== Number(array[2]))
    )
      throw new Error('Invalid Ledger typed data array')
    return Object.freeze({
      kind: 'array',
      itemType: array[1],
      items: Object.freeze(value.map(item => typedValue(array[1], item, types, depth + 1)))
    })
  }
  const fields = types[type]
  if (fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid Ledger typed data struct')
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).length !== fields.length ||
      fields.some(field => !Object.prototype.hasOwnProperty.call(record, field.name))
    ) {
      throw new Error('Ledger typed data struct fields do not match')
    }
    return Object.freeze({
      kind: 'struct',
      typeName: type,
      fields: Object.freeze(
        fields.map(field =>
          Object.freeze({
            name: field.name,
            value: typedValue(field.type, record[field.name], types, depth + 1)
          })
        )
      )
    })
  }
  if (
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    throw new Error('Invalid Ledger typed data scalar')
  }
  const normalized =
    /^(?:u?int)(?:[0-9]+)?$/.test(type) &&
    (typeof value === 'number' ||
      (typeof value === 'string' && /^(?:-?(?:0|[1-9][0-9]*)|0x[0-9a-fA-F]+)$/.test(value)))
      ? BigInt(value).toString()
      : String(value)
  return Object.freeze({ kind: 'scalar', solidityType: type, value: normalized })
}

export function ledgerEvmTypedDataSummary(
  chainId: ChainId,
  address: string,
  typedData: Readonly<Record<string, unknown>>
): SigningSummary {
  const types = typedData.types as TypedTypes
  const primaryType = typedData.primaryType
  if (
    !types ||
    typeof types !== 'object' ||
    typeof primaryType !== 'string' ||
    !Array.isArray(types.EIP712Domain) ||
    !Array.isArray(types[primaryType])
  ) {
    throw new Error('Invalid Ledger EIP-712 types')
  }
  const domain = typedValue('EIP712Domain', typedData.domain, types)
  const message = typedValue(primaryType, typedData.message, types)
  const digestHex = hashTypedData(
    typedData as unknown as Parameters<typeof hashTypedData>[0]
  ) as Hex
  return parseSigningSummary(
    {
      schema: 'evm.typed-data.v1',
      chainId,
      operation: 'message',
      review: { level: 'standard', issues: [] },
      fields: { signer: address, primaryType, domain, message, digestHex }
    },
    { family: 'evm', chainId, operation: 'message' }
  )
}
