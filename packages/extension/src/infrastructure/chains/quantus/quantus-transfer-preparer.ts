import { getQuantusNetworkConfigs } from '@/config/networks'
import {
  parseQuantusAddress,
  resolveQuantusDerivationScheme,
  type QuantusDerivationScheme
} from '@/core/chains/quantus'
import { getQuantusChainId, parseChainId } from '@/core/chains/registry'
import type { ChainId } from '@/core/chains/domain'
import { QUANTUS_DEFAULT_ERA_PERIOD } from '@/infrastructure/keyring/multichain/quantus-signing-client'
import type { QuantusTransferPrepareRequest } from '@/infrastructure/keyring/multichain/signing-adapter-quantus'
import { estimateQuantusFeeLimit } from './quantus-fee-estimate'

import type { QuantusAccountInfo, QuantusReadRpc } from './quantus-rpc-types'

const MAXIMUM_U128 = (1n << 128n) - 1n
// The fee ceiling is quoted per transfer; never treat a static amount as a fee estimate.
const MAXIMUM_ACCOUNT_INDEX = 0x7fffffff
const MINIMUM_ERA_PERIOD = 4
const MAXIMUM_ERA_PERIOD = 65_536

export type QuantusTransferErrorCode =
  | 'insufficient-funds'
  | 'keep-alive-would-drain'
  | 'nonce-reserved'
  | 'stale-account-index'

export class QuantusTransferError extends Error {
  readonly code: QuantusTransferErrorCode

  constructor(code: QuantusTransferErrorCode, message: string) {
    super(message)
    this.name = 'QuantusTransferError'
    this.code = code
  }
}

export interface PrepareQuantusNativeTransferInput {
  readonly chainId: string
  readonly scheme?: QuantusDerivationScheme
  readonly accountIndex: number
  readonly address: string
  /** Untrusted transfer intent; `toAddress`, `amountRaw`, and `keepAlive`. */
  readonly intent: unknown
  readonly rpc: Pick<
    QuantusReadRpc,
    | 'assertExpectedChain'
    | 'getBestHead'
    | 'getHeader'
    | 'getAccountInfo'
    | 'getSystemAccountNextIndex'
    | 'getRuntimeVersion'
    | 'queryFee'
  >
  readonly eraPeriod?: number
  readonly signal?: AbortSignal
}

export interface PreparedQuantusNativeTransfer {
  /** The `signing.prepare` payload for `quantus-transfer`. */
  readonly request: QuantusTransferPrepareRequest
  readonly account: QuantusAccountInfo
  readonly debit: Readonly<{
    readonly amountRaw: string
    readonly tipRaw: string
    readonly feeLimitRaw: string
    readonly freeRaw: string
  }>
}

interface QuantusTransferIntent {
  readonly toAddress: string
  readonly amountRaw: string
  readonly keepAlive: boolean
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function parseQuantusChain(chainIdValue: string): {
  readonly chainId: ChainId
  readonly genesisHash: string
} {
  const chainId = parseChainId(chainIdValue)
  if (
    chainId.namespace !== 'quantus' ||
    (chainId.id !== getQuantusChainId('mainnet') && chainId.id !== getQuantusChainId('testnet'))
  ) {
    throw new Error('Unsupported Quantus chain ID')
  }
  const network = getQuantusNetworkConfigs().find(candidate => candidate.chainId === chainId.id)
  if (!network) throw new Error('Unsupported Quantus chain ID')
  return Object.freeze({ chainId: chainId.id, genesisHash: network.genesisHash })
}

function parseAccountIndex(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAXIMUM_ACCOUNT_INDEX
  ) {
    throw new Error('Invalid Quantus account index')
  }
  return value as number
}

/**
 * Substrate only encodes mortal eras whose period is a power of two between 4
 * and 65536 blocks, so the host rejects anything the engine would trip on.
 */
function parseEraPeriod(value: number | undefined): number {
  const period = value ?? QUANTUS_DEFAULT_ERA_PERIOD
  if (
    !Number.isSafeInteger(period) ||
    period < MINIMUM_ERA_PERIOD ||
    period > MAXIMUM_ERA_PERIOD ||
    (period & (period - 1)) !== 0
  ) {
    throw new Error('Quantus era period must be a power of two between 4 and 65536')
  }
  return period
}

function parseUnsignedDecimal(value: unknown, label: string, maximum: bigint): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`)
  }
  const parsed = BigInt(value)
  if (parsed > maximum) throw new Error(`${label} exceeds u128`)
  return parsed
}

function parseIntent(value: unknown): QuantusTransferIntent {
  const record = readRecord(value, 'Quantus transfer intent')
  const allowed = ['toAddress', 'amountRaw', 'keepAlive']
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error('Invalid Quantus transfer intent')
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'toAddress')) {
    throw new Error('Invalid Quantus transfer intent')
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'amountRaw')) {
    throw new Error('Invalid Quantus transfer intent')
  }
  const amountRaw = record.amountRaw
  const amount = parseUnsignedDecimal(amountRaw, 'Quantus transfer amount', MAXIMUM_U128)
  if (amount === 0n) throw new Error('Quantus transfer amount must be positive')
  if (record.keepAlive !== undefined && typeof record.keepAlive !== 'boolean') {
    throw new Error('Invalid Quantus transfer intent')
  }
  return Object.freeze({
    toAddress: parseQuantusAddress(record.toAddress, 'Quantus recipient'),
    amountRaw: amountRaw as string,
    // Keep-alive is the safe default: a Mist-style "allow death" transfer must be
    // requested explicitly.
    keepAlive: record.keepAlive === undefined ? true : record.keepAlive
  })
}

/**
 * Reads the chain state and quotes a fee for the same encoded native transfer
 * shape that will be signed. The reviewed ceiling has a 25% safety margin;
 * the signed bytes are checked against it again before submission.
 */
export async function prepareQuantusNativeTransfer(
  input: PrepareQuantusNativeTransferInput
): Promise<PreparedQuantusNativeTransfer> {
  const chain = parseQuantusChain(input.chainId)
  const scheme = resolveQuantusDerivationScheme(input.scheme)
  const accountIndex = parseAccountIndex(input.accountIndex)
  const address = parseQuantusAddress(input.address, 'Quantus signer')
  const intent = parseIntent(input.intent)
  const eraPeriod = parseEraPeriod(input.eraPeriod)

  await input.rpc.assertExpectedChain(input.signal)
  const [runtime, bestHead, account, nextIndex] = await Promise.all([
    input.rpc.getRuntimeVersion(input.signal),
    input.rpc.getBestHead(input.signal),
    input.rpc.getAccountInfo(address, input.signal),
    input.rpc.getSystemAccountNextIndex(address, input.signal)
  ])
  const header = await input.rpc.getHeader(bestHead, input.signal)

  // `system_accountNextIndex` includes the pending pool, so it is the nonce a new
  // extrinsic must use; a value below the stored nonce means an inconsistent RPC.
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > MAXIMUM_ACCOUNT_INDEX) {
    throw new Error('Invalid Quantus account index')
  }
  if (nextIndex < account.nonce) {
    throw new QuantusTransferError(
      'stale-account-index',
      'Quantus RPC returned an account index below the stored nonce'
    )
  }

  const tipRaw = '0'
  const feeLimitRaw = await estimateQuantusFeeLimit({
    rpc: input.rpc,
    signer: address,
    recipient: intent.toAddress,
    amountRaw: intent.amountRaw,
    keepAlive: intent.keepAlive,
    scheme,
    nonce: nextIndex,
    eraPeriod,
    signal: input.signal
  })
  const debit = BigInt(intent.amountRaw) + BigInt(feeLimitRaw)
  if (debit > account.free) {
    throw new QuantusTransferError(
      'insufficient-funds',
      'Quantus balance cannot cover the transfer amount and fee ceiling'
    )
  }
  // Without the runtime's existential deposit the host cannot prove a keep-alive
  // transfer leaves the account alive, but a non-positive remainder cannot succeed.
  if (intent.keepAlive && debit === account.free) {
    throw new QuantusTransferError(
      'keep-alive-would-drain',
      'Quantus keep-alive transfer would leave the account without a balance'
    )
  }

  const request: QuantusTransferPrepareRequest = Object.freeze({
    kind: 'quantus-transfer',
    chainId: chain.chainId,
    scheme,
    accountIndex,
    toAddress: intent.toAddress,
    amountRaw: intent.amountRaw,
    feeLimitRaw,
    keepAlive: intent.keepAlive,
    nonce: nextIndex,
    tip: tipRaw,
    period: eraPeriod,
    blockNumber: header.number,
    genesisHash: chain.genesisHash,
    blockHash: bestHead,
    specVersion: runtime.specVersion,
    transactionVersion: runtime.transactionVersion,
    allowImmortal: false
  })
  return Object.freeze({
    request,
    account: Object.freeze({ ...account }),
    debit: Object.freeze({
      amountRaw: intent.amountRaw,
      tipRaw,
      feeLimitRaw,
      freeRaw: account.free.toString()
    })
  })
}
