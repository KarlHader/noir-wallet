import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry, AssetRegistryEntry } from '@/core/chains/registry'
import { parseAssetDisplayMetadata } from '@/core/chains/registry'
import {
  decodeNearContractId,
  isNearBridgeFungibleContract,
  isNearFungibleContractId,
  nearFungibleAssetId,
  nearPortfolioPrivateAccountId,
  selectNearPortfolioTokens,
  NEAR_PORTFOLIO_INVENTORY_LIMIT,
  NEAR_PORTFOLIO_TOKEN_LIMIT,
  type NearPortfolioPrivateExecution,
  type NearPortfolioTokenCandidate
} from '@/core/chains/near/near-portfolio-assets'
import type {
  PortfolioBalanceSnapshot,
  PortfolioReadErrorCode,
  PortfolioSourceSnapshot
} from '@/core/portfolio'

import { readNearBalances, type NearFungibleTokenDefinition } from './near-balance-reader'
import {
  type NearAccountTokenInventoryClient,
  type NearIndexedFungibleTokenBalance
} from './near-fastnear-client'
import { readNearAccountId } from './near-rpc-codecs'
import { NearRpcError, type NearReadRpc, type NearRpcErrorCode } from './near-rpc-types'

export interface ReadNearPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<
    NearReadRpc,
    'assertExpectedChain' | 'getAccount' | 'getFinalBlock' | 'getFungibleTokenBalance'
  > &
    Partial<Pick<NearReadRpc, 'viewFunction'>>
  readonly tokenInventory?: NearAccountTokenInventoryClient
  readonly privateExecution?: NearPortfolioPrivateExecution
  readonly userEnabledAssetIds?: ReadonlySet<string>
  readonly onDetectedTokens?: (
    tokens: readonly NearPortfolioTokenCandidate[]
  ) => Promise<void> | void
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function mapErrorCode(code: NearRpcErrorCode): PortfolioReadErrorCode {
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
    case 'account-not-found':
    case 'access-key-not-found':
    case 'transaction-not-found':
    case 'rpc-error':
    case 'cancelled':
      return 'unknown'
  }
}

function parseAccountId(chainAccount: ChainAccount): string {
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('NEAR Portfolio requires an account-identifier binding')
  }
  if (
    chainAccount.derivation.scheme !== 'slip10' &&
    chainAccount.derivation.scheme !== 'imported'
  ) {
    throw new Error('NEAR Portfolio ChainAccount uses an unsupported derivation scheme')
  }
  return readNearAccountId(chainAccount.identity.value, 'NEAR Portfolio account ID')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function tokenCandidate(
  chainId: string,
  contractId: string,
  metadata: Readonly<{ name: string; symbol: string; decimals: number }>,
  discovered: boolean
): NearPortfolioTokenCandidate {
  return Object.freeze({
    contractId,
    assetId: nearFungibleAssetId(chainId, contractId),
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    name: metadata.name,
    discovered
  })
}

function registeredToken(
  chainId: string,
  entry: AssetRegistryEntry
): NearPortfolioTokenCandidate | null {
  if (entry.asset.kind !== 'token' || entry.asset.namespace !== 'nep141') return null
  if (entry.asset.chainId !== chainId) return null
  const contractId = decodeNearContractId(entry.asset.reference)
  if (!isNearFungibleContractId(contractId)) return null
  return tokenCandidate(chainId, contractId, entry.metadata, entry.source === 'discovered')
}

async function readInventory(
  client: NearAccountTokenInventoryClient | undefined,
  accountId: string,
  signal: AbortSignal | undefined
): Promise<readonly NearIndexedFungibleTokenBalance[]> {
  if (!client) return []
  try {
    const rows = await client.getFungibleTokenBalances(accountId, signal)
    return Array.isArray(rows) ? rows.slice(0, NEAR_PORTFOLIO_INVENTORY_LIMIT) : []
  } catch (error) {
    if (signal?.aborted) throw error
    return []
  }
}

function nonZeroHolding(row: NearIndexedFungibleTokenBalance): boolean {
  return (
    row.amountRaw !== null && row.amountRaw !== '0' && /^(?:0|[1-9][0-9]*)$/.test(row.amountRaw)
  )
}

async function readHoldingMetadata(
  rpc: ReadNearPortfolioSourceInput['rpc'],
  contractId: string,
  signal: AbortSignal | undefined
): Promise<Readonly<{ name: string; symbol: string; decimals: number }> | null> {
  if (!rpc.viewFunction) return null
  try {
    const value = await rpc.viewFunction(contractId, 'ft_metadata', {}, { signal })
    if (!isRecord(value)) return null
    const metadata = parseAssetDisplayMetadata({
      name: value.name,
      symbol: value.symbol,
      decimals: value.decimals
    })
    return Object.freeze({
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals
    })
  } catch (error) {
    if (signal?.aborted || (error instanceof NearRpcError && error.code === 'cancelled'))
      throw error
    return null
  }
}

function splitRaw(
  mainRaw: bigint,
  privateOnchainRaw: bigint,
  updatedAt: number
): PortfolioBalanceSnapshot {
  const confidentialRaw = 0n
  const privateRaw = privateOnchainRaw + confidentialRaw
  return Object.freeze({
    assetId: '',
    totalRaw: (mainRaw + privateRaw).toString(),
    spendableRaw: (mainRaw + privateOnchainRaw).toString(),
    availableRaw: (mainRaw + privateOnchainRaw).toString(),
    pendingRaw: '0',
    mainRaw: mainRaw.toString(),
    privateRaw: privateRaw.toString(),
    privateOnchainRaw: privateOnchainRaw.toString(),
    confidentialRaw: confidentialRaw.toString(),
    updatedAt
  })
}

export async function readNearPortfolioSource(
  input: ReadNearPortfolioSourceInput
): Promise<PortfolioSourceSnapshot> {
  const accountId = parseAccountId(input.chainAccount)
  const chainId = input.chainAccount.scope.chainId
  const nativeAssetId = `${chainId}/slip44:397`
  const nativeAsset = input.assets.resolve(nativeAssetId)
  if (
    nativeAsset.asset.chainId !== chainId ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.asset.namespace !== 'slip44' ||
    nativeAsset.asset.reference !== '397'
  ) {
    throw new Error('NEAR Portfolio native asset binding is invalid')
  }
  const privateAccountId = nearPortfolioPrivateAccountId(input.privateExecution, accountId)
  try {
    const registered = [
      ...input.assets.list(chainId),
      ...input.assets.listQuarantined(chainId)
    ].flatMap(entry => {
      const token = registeredToken(chainId, entry)
      return token ? [token] : []
    })
    const byContract = new Map(registered.map(token => [token.contractId, token]))
    const enabled = new Set(input.userEnabledAssetIds ?? [])
    const userEnabled = registered.filter(token => enabled.has(token.assetId))
    const bundled = registered.filter(token => {
      const entry = input.assets.inspect(token.assetId)
      return entry?.source === 'bundled'
    })
    const mainInventory = await readInventory(input.tokenInventory, accountId, input.signal)
    const peaInventory = privateAccountId
      ? await readInventory(input.tokenInventory, privateAccountId, input.signal)
      : []
    const inventories = [...mainInventory, ...peaInventory].slice(0, NEAR_PORTFOLIO_INVENTORY_LIMIT)
    const holdings: NearPortfolioTokenCandidate[] = []
    const seenHoldings = new Set<string>()
    for (const row of inventories) {
      if (holdings.length >= NEAR_PORTFOLIO_TOKEN_LIMIT) break
      if (!nonZeroHolding(row) || seenHoldings.has(row.contractId)) continue
      if (
        isNearBridgeFungibleContract(row.contractId) ||
        !isNearFungibleContractId(row.contractId)
      ) {
        continue
      }
      seenHoldings.add(row.contractId)
      const known = byContract.get(row.contractId)
      if (known) {
        holdings.push(known)
        continue
      }
      const metadata = await readHoldingMetadata(input.rpc, row.contractId, input.signal)
      if (!metadata) continue
      holdings.push(tokenCandidate(chainId, row.contractId, metadata, true))
    }
    const selected = selectNearPortfolioTokens({
      userEnabled,
      holdings,
      bundled,
      registered: registered.filter(token => {
        const entry = input.assets.inspect(token.assetId)
        return entry?.source !== 'bundled'
      })
    })
    const detected = selected.filter(token => token.discovered)
    if (detected.length > 0) await input.onDetectedTokens?.(detected)
    const trustedTokens: readonly NearFungibleTokenDefinition[] = selected.map(token =>
      Object.freeze({
        contractId: token.contractId,
        symbol: token.symbol,
        decimals: token.decimals
      })
    )
    const readAccount = (nextAccountId: string, rows: readonly NearIndexedFungibleTokenBalance[]) =>
      readNearBalances({
        chainId,
        accountId: nextAccountId,
        rpc: input.rpc,
        allowMissingAccount: true,
        trustedTokens,
        ...(input.tokenInventory === undefined
          ? {}
          : { tokenInventory: { getFungibleTokenBalances: async () => rows } }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.now === undefined ? {} : { now: input.now })
      })
    const main = await readAccount(accountId, mainInventory)
    const pea = privateAccountId ? await readAccount(privateAccountId, peaInventory) : null
    const updatedAt = Math.max(main.updatedAt, pea?.updatedAt ?? 0)
    const mainTokens = new Map(main.tokens.map(token => [token.assetId, BigInt(token.amountRaw)]))
    const peaTokens = new Map(
      (pea?.tokens ?? []).map(token => [token.assetId, BigInt(token.amountRaw)])
    )
    const native = splitRaw(
      BigInt(main.native.amountRaw) + BigInt(main.native.lockedRaw),
      pea ? BigInt(pea.native.amountRaw) + BigInt(pea.native.lockedRaw) : 0n,
      updatedAt
    )
    const nativeSpendable = (
      BigInt(main.native.amountRaw) + BigInt(pea?.native.amountRaw ?? '0')
    ).toString()
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: Object.freeze([
        Object.freeze({
          ...native,
          assetId: nativeAssetId,
          spendableRaw: nativeSpendable,
          availableRaw: nativeSpendable
        }),
        ...selected.map(token => {
          const mainAmount = mainTokens.get(token.assetId) ?? 0n
          const privateAmount = peaTokens.get(token.assetId) ?? 0n
          const balance = splitRaw(mainAmount, privateAmount, updatedAt)
          return Object.freeze({
            ...balance,
            assetId: token.assetId,
            spendableRaw: (mainAmount + privateAmount).toString(),
            availableRaw: (mainAmount + privateAmount).toString()
          })
        })
      ])
    })
  } catch (error) {
    if (error instanceof NearRpcError && error.code === 'cancelled') throw error
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'error',
      balances: Object.freeze([]),
      errorCode: error instanceof NearRpcError ? mapErrorCode(error.code) : 'unknown'
    })
  }
}
