import { getNearNetworkConfigs } from '@/config/networks'
import { createAssetId, parseChainId } from '@/core/chains/registry'

import type { NearReadRpc } from './near-rpc-types'
import { readNearAccountId } from './near-rpc-codecs'
import type {
  NearAccountTokenInventoryClient,
  NearIndexedFungibleTokenBalance
} from './near-fastnear-client'

const MAXIMUM_TOKEN_DEFINITIONS = 64
const MAXIMUM_CONCURRENT_TOKEN_READS = 4

export interface NearFungibleTokenDefinition {
  readonly contractId: string
  readonly symbol: string
  readonly decimals: number
}

export interface NearNativeBalanceSnapshot {
  readonly assetId: string
  readonly amountRaw: string
  readonly lockedRaw: string
  readonly storageUsage: number
  readonly blockHash: string
  readonly blockHeight: number
}

export interface NearFungibleTokenReadModel {
  readonly assetId: string
  readonly contractId: string
  readonly symbol: string
  readonly decimals: number
  readonly amountRaw: string
  readonly blockHash: string
  readonly blockHeight: number
}

export interface NearBalanceReadModel {
  readonly chainId: string
  readonly accountId: string
  readonly native: NearNativeBalanceSnapshot
  readonly tokens: readonly NearFungibleTokenReadModel[]
  readonly updatedAt: number
}

export interface ReadNearBalancesInput {
  readonly chainId: string
  readonly accountId: string
  readonly trustedTokens?: readonly NearFungibleTokenDefinition[]
  readonly rpc: Pick<
    NearReadRpc,
    'assertExpectedChain' | 'getAccount' | 'getFinalBlock' | 'getFungibleTokenBalance'
  >
  readonly tokenInventory?: NearAccountTokenInventoryClient
  readonly allowMissingAccount?: boolean
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function parseIndexedTokenBalances(
  values: readonly NearIndexedFungibleTokenBalance[]
): ReadonlyMap<string, NearIndexedFungibleTokenBalance> {
  if (!Array.isArray(values) || values.length > 2_048) {
    throw new Error('Invalid indexed NEAR fungible token inventory')
  }
  const balances = new Map<string, NearIndexedFungibleTokenBalance>()
  for (const value of values) {
    const contractId = readNearAccountId(
      value.contractId,
      'Indexed NEAR fungible token contract ID'
    )
    if (
      balances.has(contractId) ||
      (value.amountRaw !== null &&
        (typeof value.amountRaw !== 'string' ||
          value.amountRaw.length === 0 ||
          value.amountRaw.length > 128 ||
          !/^(?:0|[1-9][0-9]*)$/.test(value.amountRaw))) ||
      (value.lastUpdateBlockHeight !== null &&
        (!Number.isSafeInteger(value.lastUpdateBlockHeight) || value.lastUpdateBlockHeight < 0))
    ) {
      throw new Error('Invalid indexed NEAR fungible token inventory')
    }
    balances.set(
      contractId,
      Object.freeze({
        contractId,
        amountRaw: value.amountRaw,
        lastUpdateBlockHeight: value.lastUpdateBlockHeight
      })
    )
  }
  return balances
}

function parseTokenDefinitions(
  values: readonly NearFungibleTokenDefinition[]
): readonly NearFungibleTokenDefinition[] {
  if (values.length > MAXIMUM_TOKEN_DEFINITIONS) {
    throw new Error('NEAR fungible token list exceeds the supported limit')
  }
  const seen = new Set<string>()
  return Object.freeze(
    values.map(value => {
      const contractId = readNearAccountId(value.contractId, 'NEAR fungible token contract ID')
      if (seen.has(contractId)) throw new Error(`Duplicate NEAR fungible token: ${contractId}`)
      seen.add(contractId)
      if (
        typeof value.symbol !== 'string' ||
        value.symbol.length === 0 ||
        value.symbol.length > 32 ||
        value.symbol.trim() !== value.symbol
      ) {
        throw new Error('Invalid NEAR fungible token symbol')
      }
      if (!Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
        throw new Error('Invalid NEAR fungible token decimals')
      }
      return Object.freeze({ contractId, symbol: value.symbol, decimals: value.decimals })
    })
  )
}

function nearContractAssetReference(contractId: string): string {
  return contractId.replace(/_/g, '%5F')
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  mapper: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(MAXIMUM_CONCURRENT_TOKEN_READS, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(values[index])
      }
    }
  )
  await Promise.all(workers)
  return Object.freeze(results)
}

export async function readNearBalances(
  input: ReadNearBalancesInput
): Promise<NearBalanceReadModel> {
  const parsedChainId = parseChainId(input.chainId)
  if (
    parsedChainId.namespace !== 'near' ||
    !getNearNetworkConfigs().some(network => network.chainId === parsedChainId.id)
  ) {
    throw new Error('Unsupported NEAR chain ID')
  }
  const chainId = parsedChainId.id
  const accountId = readNearAccountId(input.accountId, 'NEAR account ID')
  const tokenDefinitions = parseTokenDefinitions(input.trustedTokens ?? [])
  await input.rpc.assertExpectedChain(input.signal)
  const indexedTokenBalancesPromise = input.tokenInventory
    ? input.tokenInventory
        .getFungibleTokenBalances(accountId, input.signal)
        .then(parseIndexedTokenBalances)
        .catch(error => {
          if (input.signal?.aborted) throw error
          return null
        })
    : Promise.resolve(null)
  const [account, indexedTokenBalances] = await Promise.all([
    input.rpc.getAccount(accountId, input.signal),
    indexedTokenBalancesPromise
  ])
  if (account === null && !input.allowMissingAccount) throw new Error('NEAR account was not found')
  if (account !== null && account.accountId !== accountId) {
    throw new Error('NEAR account response identity mismatch')
  }
  const missingAccountBlock = account === null ? await input.rpc.getFinalBlock(input.signal) : null
  const native =
    account ??
    Object.freeze({
      amountRaw: '0',
      lockedRaw: '0',
      storageUsage: 0,
      blockHash: missingAccountBlock?.hash ?? '',
      blockHeight: missingAccountBlock?.height ?? 0
    })
  if (native.blockHash.length === 0) {
    throw new Error('NEAR missing-account projection requires a final block')
  }
  const tokens = await mapWithConcurrency(
    account === null ? [] : tokenDefinitions,
    async definition => {
      const indexedBalance = indexedTokenBalances?.get(definition.contractId)
      if (indexedTokenBalances && indexedBalance?.amountRaw !== null) {
        return Object.freeze({
          assetId: createAssetId(
            parsedChainId.id,
            'nep141',
            nearContractAssetReference(definition.contractId)
          ),
          contractId: definition.contractId,
          symbol: definition.symbol,
          decimals: definition.decimals,
          amountRaw: indexedBalance?.amountRaw ?? '0',
          blockHash: native.blockHash,
          blockHeight: indexedBalance?.lastUpdateBlockHeight ?? native.blockHeight
        })
      }
      const balance = await input.rpc.getFungibleTokenBalance(
        definition.contractId,
        accountId,
        input.signal
      )
      if (balance.contractId !== definition.contractId || balance.accountId !== accountId) {
        throw new Error('NEAR fungible token response identity mismatch')
      }
      return Object.freeze({
        assetId: createAssetId(
          parsedChainId.id,
          'nep141',
          nearContractAssetReference(definition.contractId)
        ),
        contractId: definition.contractId,
        symbol: definition.symbol,
        decimals: definition.decimals,
        amountRaw: balance.amountRaw,
        blockHash: balance.blockHash,
        blockHeight: balance.blockHeight
      })
    }
  )
  const updatedAt = (input.now ?? Date.now)()
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('Invalid NEAR balance timestamp')
  }
  return Object.freeze({
    chainId,
    accountId,
    native: Object.freeze({
      assetId: createAssetId(parsedChainId.id, 'slip44', '397'),
      amountRaw: native.amountRaw,
      lockedRaw: native.lockedRaw,
      storageUsage: native.storageUsage,
      blockHash: native.blockHash,
      blockHeight: native.blockHeight
    }),
    tokens: Object.freeze(
      [...tokens].sort((left, right) => left.assetId.localeCompare(right.assetId))
    ),
    updatedAt
  })
}
