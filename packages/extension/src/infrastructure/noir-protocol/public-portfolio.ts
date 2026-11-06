import { parseAccountId, parseChainAccountId, type ChainAccount } from '@/core/accounts/domain'
import { parseChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { PortfolioSourceSnapshot } from '@/core/portfolio'
import { publicIdentityPath } from '@/core/services/noir-protocol/public/identity'
import type {
  NoirPublicAccount,
  NoirPublicAsset,
  NoirPublicAssets
} from '@/core/services/noir-protocol/public/types'
import { isRetainedPublicAccount, withPublicAccountDataLock } from './public-account-projection'
import {
  IndexedDbPortfolioCacheRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'

export interface NoirPublicPortfolioScope {
  readonly walletId: string
  readonly accountId: string
  readonly derivationIndex: number
}

export type NoirPublicTokenMetadata = Pick<
  NoirPublicAsset,
  'tokenId' | 'symbol' | 'name' | 'decimals'
>

export function publicAssetId(account: NoirPublicAccount, tokenId: string): string {
  return `noir:${account.network}/nep141:${tokenId}`
}

function publicChainAccount(
  account: NoirPublicAccount,
  scope: NoirPublicPortfolioScope
): ChainAccount {
  return {
    id: parseChainAccountId(
      JSON.stringify([
        'public',
        account.network,
        scope.walletId,
        scope.accountId,
        account.parentContractId,
        account.mcaId,
        ...(account.chain === 'evm' ? ['evm'] : [])
      ])
    ),
    scope: {
      keyDomainId: parseKeyDomainId(scope.walletId),
      accountId: parseAccountId(scope.accountId),
      chainId: parseChainId(`noir:${account.network}`).id
    },
    derivation:
      account.chain === 'evm'
        ? { scheme: 'evm-address', path: account.address }
        : {
            scheme: 'zcash-lending-v1',
            path: publicIdentityPath(
              scope.derivationIndex,
              account.signingMode as 'derived' | 'legacy_index0'
            )
          },
    identity:
      account.chain === 'evm'
        ? { kind: 'account-identifier', value: account.address }
        : { kind: 'public-key', value: account.publicKey },
    createdAt: 0
  }
}

export function projectPublicPortfolio(
  result: NoirPublicAssets,
  scope: NoirPublicPortfolioScope
): PortfolioSourceSnapshot {
  return {
    chainAccount: publicChainAccount(result.account, scope),
    status: result.assets.every(asset => asset.status === 'fresh') ? 'ready' : 'error',
    balances: result.assets.flatMap(asset =>
      asset.balanceRaw === null
        ? []
        : [
            {
              assetId: publicAssetId(result.account, asset.tokenId),
              totalRaw: asset.balanceRaw,
              spendableRaw: asset.balanceRaw,
              availableRaw: asset.balanceRaw,
              pendingRaw: '0',
              updatedAt: asset.updatedAt ?? 0
            }
          ]
    ),
    ...(result.assets.some(asset => asset.status !== 'fresh')
      ? { errorCode: 'network-unavailable' as const }
      : {})
  }
}

export class NoirPublicPortfolioCache {
  private readonly cache = new IndexedDbPortfolioCacheRepository()
  private readonly storage = new IndexedDbStorageV2Repository()

  async read(
    account: NoirPublicAccount,
    scope: NoirPublicPortfolioScope,
    tokens: readonly NoirPublicTokenMetadata[]
  ): Promise<NoirPublicAssets> {
    const pointer = await this.storage.getActivePointer()
    const cached = pointer
      ? await this.cache.get(pointer.generationId, publicChainAccount(account, scope).id)
      : null
    const source =
      cached?.source.chainAccount.identity.value === account.publicKey ? cached.source : null
    return {
      account,
      assets: tokens.map(token => {
        const balance = source?.balances.find(
          item => item.assetId === publicAssetId(account, token.tokenId)
        )
        return {
          ...token,
          balanceRaw: balance?.totalRaw ?? null,
          status: balance ? 'stale' : 'unavailable',
          ...(balance ? { updatedAt: balance.updatedAt } : {})
        }
      })
    }
  }

  async write(result: NoirPublicAssets, scope: NoirPublicPortfolioScope): Promise<void> {
    await withPublicAccountDataLock(async () => {
      if (!(await isRetainedPublicAccount({ ...scope, network: result.account.network }))) return
      const pointer = await this.storage.getActivePointer()
      if (!pointer) return
      const snapshot = await this.storage.getSnapshot(pointer.generationId)
      if (
        !snapshot?.accounts.some(
          account => account.id === scope.accountId && account.keyDomainId === scope.walletId
        )
      )
        return
      await this.cache.put({
        generationId: pointer.generationId,
        cachedAt: Date.now(),
        source: projectPublicPortfolio(result, scope)
      })
    })
  }
}
