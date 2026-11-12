import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'

export const STARKNET_WALLET_API_VERSION = '0.10.4' as const

/** JSON-RPC spec versions this wallet speaks. Distinct from Wallet API 0.10.4. */
export const STARKNET_SUPPORTED_JSON_RPC_SPECS = Object.freeze(['0.10.3'] as const)

export const STARKNET_DAPP_RUNTIME_METHODS = Object.freeze([
  'wallet_supportedWalletApi',
  'wallet_supportedSpecs',
  'wallet_getPermissions',
  'wallet_requestAccounts',
  'wallet_requestChainId',
  'wallet_deploymentData',
  'wallet_switchStarknetChain',
  'wallet_addStarknetChain',
  'wallet_watchAsset',
  'wallet_addInvokeTransaction',
  'wallet_addDeclareTransaction',
  'wallet_signTypedData',
  'wallet_disconnect',
  'wallet_strk20InvokeTransaction',
  'wallet_strk20PrepareInvoke',
  'wallet_strk20Balances',
  'wallet_strk20ShadowAccountCommitment'
] as const)

export type StarknetDAppRuntimeMethod = (typeof STARKNET_DAPP_RUNTIME_METHODS)[number]

export const STARKNET_UNSUPPORTED_METHODS = Object.freeze([
  'wallet_addStarknetChain',
  'wallet_addDeclareTransaction',
  'wallet_strk20InvokeTransaction',
  'wallet_strk20PrepareInvoke',
  'wallet_strk20Balances',
  'wallet_strk20ShadowAccountCommitment'
] as const)

const UNSUPPORTED = new Set<string>(STARKNET_UNSUPPORTED_METHODS)

export const STARKNET_ERROR = Object.freeze({
  notErc20: 111,
  userRefused: 113,
  invalidPayload: 114,
  accountAlreadyDeployed: 115,
  deploymentDataUnavailable: 116,
  chainIdNotSupported: 117,
  apiVersionNotSupported: 162,
  unknown: 163,
  unauthorized: 4100,
  unavailable: 4200
} as const)

export class StarknetProviderError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'StarknetProviderError'
    this.code = code
  }
}

export function toStarknetProviderErrorShape(error: unknown): {
  readonly code: number
  readonly message: string
} {
  if (error instanceof StarknetProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  return Object.freeze({
    code: STARKNET_ERROR.unknown,
    message: 'Noir Wallet could not complete the Starknet request.'
  })
}

export function isUnsupportedStarknetMethod(method: string): boolean {
  return UNSUPPORTED.has(method)
}

export interface StarknetInvokeCall {
  readonly contract_address: string
  readonly entry_point: string
  readonly calldata: readonly string[]
}

export interface StarknetWorkerCall {
  readonly to: string
  readonly entrypoint?: string
  readonly selector?: string
  readonly calldata: readonly string[]
}

export function parseStarknetFelt(value: unknown, label = 'felt'): string {
  if (value === '0x0' || value === '0x00' || value === '0x') {
    if (value === '0x')
      throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, `Invalid ${label}.`)
    return '0x0'
  }
  if (typeof value !== 'string') {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, `Invalid ${label}.`)
  }
  try {
    const felt = normalizeStarknetFelt(value)
    if (BigInt(felt) >= 1n << 251n) {
      throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, `Invalid ${label}.`)
    }
    return felt
  } catch (error) {
    if (error instanceof StarknetProviderError) throw error
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, `Invalid ${label}.`)
  }
}

export function readStarknetParams(
  params: readonly unknown[] | Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> {
  if (params === undefined) return Object.freeze({})
  if (Array.isArray(params)) {
    if (params.length === 0) return Object.freeze({})
    if (params.length === 1 && isRecord(params[0])) return Object.freeze({ ...params[0] })
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid Starknet parameters.')
  }
  if (!isRecord(params)) {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid Starknet parameters.')
  }
  return params
}

export function assertStarknetApiVersion(params: Readonly<Record<string, unknown>>): void {
  if (!Object.prototype.hasOwnProperty.call(params, 'api_version')) return
  if (params.api_version !== STARKNET_WALLET_API_VERSION) {
    throw new StarknetProviderError(
      STARKNET_ERROR.apiVersionNotSupported,
      'This Starknet wallet API version is not supported.'
    )
  }
}

export function parseStarknetCalls(value: unknown): readonly StarknetInvokeCall[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid invoke calls.')
  }
  return Object.freeze(
    value.map(item => {
      if (!isRecord(item)) {
        throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid invoke call.')
      }
      if (
        Object.prototype.hasOwnProperty.call(item, 'proof') ||
        Object.prototype.hasOwnProperty.call(item, 'proofFacts')
      ) {
        throw new StarknetProviderError(
          STARKNET_ERROR.invalidPayload,
          'Starknet invoke calls cannot include a proof.'
        )
      }
      const entryPoint = item.entry_point
      if (typeof entryPoint !== 'string' || entryPoint.length === 0 || entryPoint.length > 128) {
        throw new StarknetProviderError(
          STARKNET_ERROR.invalidPayload,
          'Invalid invoke entry point.'
        )
      }
      const rawCalldata = item.calldata === undefined ? [] : item.calldata
      if (!Array.isArray(rawCalldata) || rawCalldata.length > 128) {
        throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid invoke calldata.')
      }
      return Object.freeze({
        contract_address: parseStarknetFelt(item.contract_address, 'contract address'),
        entry_point: entryPoint,
        calldata: Object.freeze(rawCalldata.map(felt => parseStarknetFelt(felt, 'calldata felt')))
      })
    })
  )
}

export function toStarknetWorkerCall(call: StarknetInvokeCall): StarknetWorkerCall {
  const feltEntry = /^0x[0-9a-fA-F]{1,64}$/.test(call.entry_point)
  return Object.freeze({
    to: call.contract_address,
    ...(feltEntry
      ? { selector: parseStarknetFelt(call.entry_point, 'selector') }
      : { entrypoint: call.entry_point }),
    calldata: call.calldata
  })
}

export function parseStarknetTypedData(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid typed data.')
  }
  if (
    !isRecord(value.types) ||
    typeof value.primaryType !== 'string' ||
    value.primaryType.length === 0
  ) {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid typed data.')
  }
  if (!isRecord(value.domain) || !isRecord(value.message)) {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid typed data.')
  }
  if (value.primaryType.length > 128) {
    throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid typed data.')
  }
  return Object.freeze({
    types: value.types,
    primaryType: value.primaryType,
    domain: value.domain,
    message: value.message
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
