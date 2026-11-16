import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'
import { logger } from '@/lib/logger'

import { readSolanaBalances } from './solana-balance-reader'
import {
  parseSolanaPublicKey,
  SolanaRpcError,
  type SolanaReadRpc,
  type SolanaRpcErrorCode
} from './solana-rpc-client'

export interface ReadSolanaPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<
    SolanaReadRpc,
    'assertExpectedChain' | 'getBalanceSnapshot' | 'getTokenAccountsByMints'
  >
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function mapErrorCode(code: SolanaRpcErrorCode): PortfolioReadErrorCode {
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
    case 'cancelled':
      return 'unknown'
  }
}

function parseAccountAddress(chainAccount: ChainAccount): string {
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Solana Portfolio requires an account-identifier binding')
  }
  if (
    chainAccount.derivation.scheme !== 'slip10' &&
    chainAccount.derivation.scheme !== 'imported'
  ) {
    throw new Error('Solana Portfolio ChainAccount uses an unsupported derivation scheme')
  }
  return parseSolanaPublicKey(chainAccount.identity.value)
}

export async function readSolanaPortfolioSource(
  input: ReadSolanaPortfolioSourceInput
): Promise<PortfolioSourceSnapshot> {
  const address = parseAccountAddress(input.chainAccount)
  const chainId = input.chainAccount.scope.chainId
  const nativeAssetId = `${chainId}/slip44:501`
  const nativeAsset = input.assets.resolve(nativeAssetId)
  if (
    nativeAsset.asset.chainId !== chainId ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.asset.namespace !== 'slip44' ||
    nativeAsset.asset.reference !== '501'
  ) {
    throw new Error('Solana Portfolio native asset binding is invalid')
  }
  try {
    const tokenMints = input.assets
      .list(chainId)
      .flatMap(entry =>
        entry.asset.kind === 'token' && entry.asset.namespace === 'token'
          ? [entry.asset.reference]
          : []
      )
    const balances = await readSolanaBalances({
      chainId,
      address,
      rpc: input.rpc,
      tokenMints,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.now === undefined ? {} : { now: input.now })
    })
    const tokenBalances = new Map(balances.tokens.map(token => [token.assetId, token] as const))
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: Object.freeze([
        Object.freeze({
          assetId: nativeAssetId,
          totalRaw: balances.native.amountRaw,
          spendableRaw: balances.native.amountRaw,
          availableRaw: balances.native.amountRaw,
          pendingRaw: '0',
          updatedAt: balances.updatedAt
        }),
        ...input.assets.list(chainId).flatMap(asset => {
          if (
            asset.asset.chainId !== chainId ||
            asset.asset.kind !== 'token' ||
            asset.asset.namespace !== 'token'
          ) {
            return []
          }
          const token = tokenBalances.get(asset.asset.id)
          if (token && asset.metadata.decimals !== token.decimals) return []
          return [
            Object.freeze({
              assetId: asset.asset.id,
              totalRaw: token?.amountRaw ?? '0',
              spendableRaw: token?.amountRaw ?? '0',
              availableRaw: token?.amountRaw ?? '0',
              pendingRaw: '0',
              updatedAt: balances.updatedAt
            })
          ]
        })
      ])
    })
  } catch (error) {
    if (error instanceof SolanaRpcError && error.code === 'cancelled') throw error
    const errorCode = error instanceof SolanaRpcError ? mapErrorCode(error.code) : 'unknown'
    const cause =
      error instanceof SolanaRpcError ? error.code : error instanceof Error ? error.name : 'unknown'
    logger.warn(
      `Solana Portfolio refresh failed code=${errorCode} cause=${cause}`,
      input.chainAccount.scope.keyDomainId,
      input.chainAccount.scope.accountId
    )
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'error',
      balances: Object.freeze([]),
      errorCode
    })
  }
}
