import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'

import { readNearBalances } from './near-balance-reader'
import { readNearAccountId } from './near-rpc-codecs'
import { NearRpcError, type NearReadRpc, type NearRpcErrorCode } from './near-rpc-types'
import type { NearAccountTokenInventoryClient } from './near-fastnear-client'

export interface ReadNearPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<
    NearReadRpc,
    'assertExpectedChain' | 'getAccount' | 'getFinalBlock' | 'getFungibleTokenBalance'
  >
  readonly tokenInventory?: NearAccountTokenInventoryClient
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
  const trustedTokens = input.assets.list(nativeAsset.asset.chainId).flatMap(entry =>
    entry.asset.kind === 'token' && entry.asset.namespace === 'nep141'
      ? [
          Object.freeze({
            contractId: entry.asset.reference.replace(/%5F/gi, '_'),
            symbol: entry.metadata.symbol,
            decimals: entry.metadata.decimals
          })
        ]
      : []
  )
  try {
    const balances = await readNearBalances({
      chainId,
      accountId,
      rpc: input.rpc,
      allowMissingAccount: true,
      trustedTokens,
      ...(input.tokenInventory === undefined ? {} : { tokenInventory: input.tokenInventory }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.now === undefined ? {} : { now: input.now })
    })
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: Object.freeze([
        Object.freeze({
          assetId: nativeAssetId,
          totalRaw: (
            BigInt(balances.native.amountRaw) + BigInt(balances.native.lockedRaw)
          ).toString(),
          spendableRaw: balances.native.amountRaw,
          availableRaw: balances.native.amountRaw,
          pendingRaw: '0',
          updatedAt: balances.updatedAt
        }),
        ...balances.tokens.map(token =>
          Object.freeze({
            assetId: token.assetId,
            totalRaw: token.amountRaw,
            spendableRaw: token.amountRaw,
            availableRaw: token.amountRaw,
            pendingRaw: '0',
            updatedAt: balances.updatedAt
          })
        )
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
