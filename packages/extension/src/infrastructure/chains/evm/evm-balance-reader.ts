import type { ChainAccount } from '@/core/accounts/domain'
import type { ChainId } from '@/core/chains/domain'
import type { AssetRegistry, AssetRegistryEntry } from '@/core/chains/registry'
import type {
  PortfolioBalanceSnapshot,
  PortfolioReadErrorCode,
  PortfolioSourceSnapshot
} from '@/core/portfolio'
import { parseEvmAccountBinding } from './evm-account'
import { readPreferredEvmPortfolioBalances } from './evm-portfolio-batch'
import {
  EvmRpcError,
  type EvmBalanceRpc,
  type EvmContractRpc,
  type EvmRpcErrorCode
} from './evm-rpc-client'

const MAXIMUM_ASSETS_PER_READ = 512
const READ_CONCURRENCY = 4
const RAW_BALANCE_PATTERN = /^(0|[1-9][0-9]{0,127})$/

export interface ReadEvmPortfolioInput {
  readonly chainId: ChainId
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: EvmBalanceRpc
  readonly preferredBalanceRpc?: EvmContractRpc
  readonly privateAddress?: string
  readonly publicOnly?: boolean
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function parseEvmAddress(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value.toLowerCase() as `0x${string}`
}

function parseRawBalance(value: string): string {
  if (!RAW_BALANCE_PATTERN.test(value)) {
    throw new EvmRpcError('invalid-response', 'Invalid EVM balance amount')
  }
  return value
}

function mapErrorCode(code: EvmRpcErrorCode): PortfolioReadErrorCode {
  switch (code) {
    case 'rate-limited':
      return 'rate-limited'
    case 'unauthorized':
      return 'unauthorized'
    case 'invalid-response':
    case 'chain-mismatch':
      return 'invalid-response'
    case 'network-unavailable':
    case 'timeout':
      return 'network-unavailable'
    case 'rpc-error':
      return 'unknown'
    case 'cancelled':
      return 'unknown'
  }
}

function errorPriority(code: PortfolioReadErrorCode): number {
  const priorities: Record<PortfolioReadErrorCode, number> = {
    unauthorized: 0,
    'invalid-response': 1,
    'rate-limited': 2,
    'network-unavailable': 3,
    unsupported: 4,
    unknown: 5
  }
  return priorities[code]
}

function selectErrorCode(errors: readonly PortfolioReadErrorCode[]): PortfolioReadErrorCode {
  return (
    [...errors].sort((left, right) => errorPriority(left) - errorPriority(right))[0] ?? 'unknown'
  )
}

function balanceSnapshot(
  asset: AssetRegistryEntry,
  totalRaw: string,
  updatedAt: number
): PortfolioBalanceSnapshot {
  return Object.freeze({
    assetId: asset.asset.id,
    totalRaw,
    spendableRaw: totalRaw,
    availableRaw: totalRaw,
    pendingRaw: '0',
    updatedAt
  })
}

async function readAsset(
  asset: AssetRegistryEntry,
  address: string,
  rpc: EvmBalanceRpc,
  signal: AbortSignal | undefined,
  updatedAt: number
): Promise<PortfolioBalanceSnapshot> {
  if (asset.asset.kind === 'native' && asset.asset.namespace === 'slip44') {
    return balanceSnapshot(
      asset,
      parseRawBalance(await rpc.getNativeBalance(address, signal)),
      updatedAt
    )
  }
  if (asset.asset.kind === 'token' && asset.asset.namespace === 'erc20') {
    return balanceSnapshot(
      asset,
      parseRawBalance(await rpc.getErc20Balance(asset.asset.reference, address, signal)),
      updatedAt
    )
  }
  throw new EvmRpcError('invalid-response', 'Unsupported EVM asset definition')
}

function combineAccountBalances(
  main: PortfolioBalanceSnapshot,
  privateBalance: PortfolioBalanceSnapshot
): PortfolioBalanceSnapshot {
  if (main.assetId !== privateBalance.assetId || main.updatedAt !== privateBalance.updatedAt) {
    throw new EvmRpcError('invalid-response', 'EVM account balance snapshots do not match')
  }
  const mainRaw = main.totalRaw
  const privateRaw = privateBalance.totalRaw
  const totalRaw = parseRawBalance((BigInt(mainRaw) + BigInt(privateRaw)).toString())
  return Object.freeze({
    assetId: main.assetId,
    totalRaw,
    spendableRaw: totalRaw,
    availableRaw: totalRaw,
    pendingRaw: '0',
    mainRaw,
    privateRaw,
    updatedAt: main.updatedAt
  })
}

export function completePublicOnlyEvmBalance(
  balance: PortfolioBalanceSnapshot
): PortfolioBalanceSnapshot {
  if (balance.mainRaw !== undefined || balance.privateRaw !== undefined) return balance
  return Object.freeze({ ...balance, mainRaw: balance.totalRaw, privateRaw: '0' })
}

export async function readEvmPortfolioSource(
  input: ReadEvmPortfolioInput
): Promise<PortfolioSourceSnapshot> {
  const { address: accountAddress } = parseEvmAccountBinding(input.chainAccount, input.chainId)
  const address = parseEvmAddress(accountAddress, 'EVM Main Address')
  const privateAddress =
    input.privateAddress === undefined
      ? undefined
      : parseEvmAddress(input.privateAddress, 'Private Execution Address')
  if (privateAddress === address) {
    throw new Error('Private Execution Address must differ from the Main Address')
  }
  const assets = Object.freeze([
    ...input.assets.list(input.chainId),
    ...input.assets.listQuarantined(input.chainId)
  ])
  if (assets.length === 0 || assets.length > MAXIMUM_ASSETS_PER_READ) {
    throw new Error('Invalid EVM asset inventory')
  }
  const addresses = privateAddress ? [address, privateAddress] : [address]
  const preferred = input.preferredBalanceRpc
    ? await readPreferredEvmPortfolioBalances(
        input.preferredBalanceRpc,
        assets,
        addresses,
        input.signal
      )
    : undefined
  let fallbackError: EvmRpcError | undefined
  if (addresses.some(owner => assets.some(({ asset }) => !preferred?.get(owner)?.has(asset.id)))) {
    try {
      await input.rpc.assertExpectedChain(input.signal)
    } catch (error) {
      if (error instanceof EvmRpcError && error.code === 'cancelled') throw error
      fallbackError =
        error instanceof EvmRpcError
          ? error
          : new EvmRpcError('rpc-error', 'EVM balance endpoint could not be verified')
    }
  }

  const updatedAt = (input.now ?? Date.now)()
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('Invalid EVM balance timestamp')
  }
  const balances: Array<PortfolioBalanceSnapshot | undefined> = new Array(assets.length)
  const errors: PortfolioReadErrorCode[] = []
  let nextIndex = 0

  const readBalance = (asset: AssetRegistryEntry, owner: string) => {
    const raw = preferred?.get(owner)?.get(asset.asset.id)
    if (raw !== undefined) return balanceSnapshot(asset, raw, updatedAt)
    if (fallbackError) throw fallbackError
    return readAsset(asset, owner, input.rpc, input.signal, updatedAt)
  }

  const worker = async () => {
    while (nextIndex < assets.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        const main = await readBalance(assets[index], address)
        balances[index] = privateAddress
          ? combineAccountBalances(main, await readBalance(assets[index], privateAddress))
          : input.publicOnly
            ? completePublicOnlyEvmBalance(main)
            : main
      } catch (error) {
        if (error instanceof EvmRpcError && error.code === 'cancelled') throw error
        errors.push(error instanceof EvmRpcError ? mapErrorCode(error.code) : 'unknown')
      }
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          privateAddress ? Math.max(1, READ_CONCURRENCY / 2) : READ_CONCURRENCY,
          assets.length
        )
      },
      () => worker()
    )
  )
  const completed = Object.freeze(
    balances.filter((balance): balance is PortfolioBalanceSnapshot => balance !== undefined)
  )
  if (errors.length === 0) {
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: completed
    })
  }
  return Object.freeze({
    chainAccount: input.chainAccount,
    status: 'error',
    balances: completed,
    errorCode: selectErrorCode(errors)
  })
}
