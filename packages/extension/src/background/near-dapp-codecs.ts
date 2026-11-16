import { parseNearAccountId } from '@/core/chains/near'
import { NativeTransferProviderError } from '@/core/dapp/native-transfer-provider'
import { encodeNearFunctionArgs } from '@/infrastructure/chains/near/near-rpc-codecs'
import { bytesToBase64 } from '@/lib/bytes'

const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n

interface NearFunctionCall {
  readonly type: 'functionCall'
  readonly methodName: string
  readonly args: Readonly<Record<string, unknown>> | readonly number[]
  readonly gas: string
  readonly deposit: string
}

interface NearTransfer {
  readonly type: 'transfer'
  readonly deposit: string
}

export interface NearTransactionRequest {
  readonly receiverId: string
  readonly actions: readonly (NearFunctionCall | NearTransfer)[]
  readonly signerId?: string
}

export interface NearMessageRequest {
  readonly message: string
  readonly recipient: string
  readonly nonce: readonly number[]
  readonly callbackUrl: string | null
  readonly state: string | null
}

function isNearFunctionCallByteArray(
  args: Readonly<Record<string, unknown>> | readonly number[]
): args is readonly number[] {
  return Array.isArray(args)
}

export function encodeNearDAppFunctionArgs(
  args: Readonly<Record<string, unknown>> | readonly number[]
): string {
  return isNearFunctionCallByteArray(args)
    ? bytesToBase64(Uint8Array.from(args))
    : encodeNearFunctionArgs(args)
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeTransferProviderError(-32602, `${label} must be an object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NativeTransferProviderError(-32602, `${label} must be a plain object.`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  if (
    !required.every(key => Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some(key => !allowed.has(key))
  ) {
    throw new NativeTransferProviderError(-32602, `${label} has invalid fields.`)
  }
}

function parseUnsigned(value: unknown, maximum: bigint, label: string): string {
  const normalized = typeof value === 'bigint' ? value.toString() : value
  if (typeof normalized !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw new NativeTransferProviderError(-32602, `${label} must be an unsigned integer string.`)
  }
  if (BigInt(normalized) > maximum) {
    throw new NativeTransferProviderError(-32602, `${label} exceeds the protocol limit.`)
  }
  return normalized
}

function parseFunctionCallArgs(
  value: unknown
): Readonly<Record<string, unknown>> | readonly number[] {
  if (Array.isArray(value)) {
    if (
      value.length > 256 * 1024 ||
      !value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ) {
      throw new NativeTransferProviderError(
        -32602,
        'NEAR function-call argument bytes are invalid.'
      )
    }
    return Object.freeze(value as number[])
  }
  return Object.freeze(readRecord(value, 'NEAR function-call arguments'))
}

function parseTransaction(value: unknown): NearTransactionRequest {
  const record = readRecord(value, 'NEAR transaction')
  assertExactKeys(record, ['receiverId', 'actions'], ['signerId'], 'NEAR transaction')
  if (
    !Array.isArray(record.actions) ||
    record.actions.length === 0 ||
    record.actions.length > 100
  ) {
    throw new NativeTransferProviderError(-32602, 'NEAR actions must contain 1 to 100 calls.')
  }
  const actions = record.actions.map((value, index): NearFunctionCall | NearTransfer => {
    const action = readRecord(value, `NEAR action ${index + 1}`)
    if (action.type === 'Transfer' || action.enum === 'transfer') {
      const modern = action.enum === 'transfer'
      assertExactKeys(
        action,
        modern ? ['enum', 'transfer'] : ['type', 'params'],
        [],
        'NEAR transfer'
      )
      const params = readRecord(
        modern ? action.transfer : action.params,
        'NEAR transfer parameters'
      )
      assertExactKeys(params, ['deposit'], [], 'NEAR transfer parameters')
      return Object.freeze({
        type: 'transfer',
        deposit: parseUnsigned(params.deposit, MAXIMUM_U128, 'NEAR deposit')
      })
    }
    const modern = action.enum === 'functionCall'
    if (action.type === 'FunctionCall' || modern) {
      assertExactKeys(
        action,
        modern ? ['enum', 'functionCall'] : ['type', 'params'],
        [],
        'NEAR function call'
      )
    }
    const functionCall = modern
      ? readRecord(action.functionCall, 'NEAR function-call parameters')
      : action.type === 'FunctionCall'
        ? readRecord(action.params, 'NEAR function-call parameters')
        : action
    assertExactKeys(
      functionCall,
      ['methodName', 'args', 'gas', 'deposit'],
      [],
      'NEAR function call'
    )
    if (
      typeof functionCall.methodName !== 'string' ||
      functionCall.methodName.length === 0 ||
      functionCall.methodName.length > 256
    ) {
      throw new NativeTransferProviderError(-32602, 'NEAR method name is invalid.')
    }
    return Object.freeze({
      type: 'functionCall',
      methodName: functionCall.methodName,
      args: parseFunctionCallArgs(functionCall.args),
      gas: parseUnsigned(functionCall.gas, MAXIMUM_U64, 'NEAR gas'),
      deposit: parseUnsigned(functionCall.deposit, MAXIMUM_U128, 'NEAR deposit')
    })
  })
  if (typeof record.receiverId !== 'string') {
    throw new NativeTransferProviderError(-32602, 'NEAR receiver account ID is invalid.')
  }
  let receiverId: string
  try {
    receiverId = parseNearAccountId(record.receiverId)
  } catch {
    throw new NativeTransferProviderError(-32602, 'NEAR receiver account ID is invalid.')
  }
  let signerId: string | undefined
  try {
    if (record.signerId !== undefined && typeof record.signerId !== 'string') {
      throw new TypeError('Invalid signer')
    }
    signerId = record.signerId === undefined ? undefined : parseNearAccountId(record.signerId)
  } catch {
    throw new NativeTransferProviderError(-32602, 'NEAR signer account ID is invalid.')
  }
  return Object.freeze({
    receiverId,
    actions: Object.freeze(actions),
    ...(signerId === undefined ? {} : { signerId })
  })
}

export function parseNearDAppTransaction(
  params: readonly unknown[] | undefined
): NearTransactionRequest {
  if (!Array.isArray(params) || params.length !== 1) {
    throw new NativeTransferProviderError(-32602, 'NEAR signing requires one transaction.')
  }
  return parseTransaction(params[0])
}

export function parseNearDAppTransactionBatch(
  params: readonly unknown[] | undefined
): readonly NearTransactionRequest[] {
  if (!Array.isArray(params) || params.length !== 1) {
    throw new NativeTransferProviderError(-32602, 'NEAR batch signing requires one request.')
  }
  const request = readRecord(params[0], 'NEAR batch request')
  assertExactKeys(request, ['transactions'], [], 'NEAR batch request')
  if (
    !Array.isArray(request.transactions) ||
    request.transactions.length === 0 ||
    request.transactions.length > 16
  ) {
    throw new NativeTransferProviderError(-32602, 'NEAR batch size must be between 1 and 16.')
  }
  return Object.freeze(request.transactions.map(parseTransaction))
}

export function parseNearDAppMessage(params: readonly unknown[] | undefined): NearMessageRequest {
  if (!Array.isArray(params) || params.length !== 1) {
    throw new NativeTransferProviderError(-32602, 'NEAR message signing requires one request.')
  }
  const request = readRecord(params[0], 'NEAR message request')
  assertExactKeys(
    request,
    ['message', 'recipient', 'nonce', 'callbackUrl', 'state'],
    [],
    'NEAR message request'
  )
  if (
    typeof request.message !== 'string' ||
    request.message.length === 0 ||
    request.message.length > 256 * 1024 ||
    typeof request.recipient !== 'string' ||
    request.recipient.length === 0 ||
    request.recipient.length > 128 ||
    !Array.isArray(request.nonce) ||
    request.nonce.length !== 32 ||
    !request.nonce.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ||
    (request.callbackUrl !== null &&
      (typeof request.callbackUrl !== 'string' || request.callbackUrl.length > 2_048)) ||
    (request.state !== null && (typeof request.state !== 'string' || request.state.length > 4_096))
  ) {
    throw new NativeTransferProviderError(-32602, 'NEAR message request is invalid.')
  }
  return Object.freeze({
    message: request.message,
    recipient: request.recipient,
    nonce: Object.freeze([...request.nonce]),
    callbackUrl: request.callbackUrl,
    state: request.state
  }) as NearMessageRequest
}
