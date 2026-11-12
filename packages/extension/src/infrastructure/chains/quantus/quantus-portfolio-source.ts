import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import { parseQuantusAddress } from '@/core/chains/quantus'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'
import { logger } from '@/lib/logger'

import {
  QuantusRpcError,
  type QuantusReadRpc,
  type QuantusRpcErrorCode
} from './quantus-rpc-client'

const QUANTUS_NATIVE_ASSET_REFERENCE = '189189'

export interface ReadQuantusPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<QuantusReadRpc, 'assertExpectedChain' | 'getAccountInfo'>
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function mapErrorCode(code: QuantusRpcErrorCode): PortfolioReadErrorCode {
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
    case 'bad-signature':
    case 'rpc-error':
    case 'cancelled':
      return 'unknown'
  }
}

function parseAccountAddress(chainAccount: ChainAccount): string {
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Quantus Portfolio requires an account-identifier binding')
  }
  if (
    chainAccount.derivation.scheme !== 'ml-dsa-87' &&
    chainAccount.derivation.scheme !== 'ml-dsa-65'
  ) {
    throw new Error('Quantus Portfolio ChainAccount uses an unsupported derivation scheme')
  }
  return parseQuantusAddress(chainAccount.identity.value)
}

/**
 * Reads the `System.Account` record for a projected Quantus ChainAccount. The
 * spendable figure is `free` because fees are paid from it; `reserved` is only
 * counted in the total.
 */
export async function readQuantusPortfolioSource(
  input: ReadQuantusPortfolioSourceInput
): Promise<PortfolioSourceSnapshot> {
  const address = parseAccountAddress(input.chainAccount)
  const chainId = input.chainAccount.scope.chainId
  const nativeAssetId = `${chainId}/slip44:${QUANTUS_NATIVE_ASSET_REFERENCE}`
  const nativeAsset = input.assets.resolve(nativeAssetId)
  if (
    nativeAsset.asset.chainId !== chainId ||
    nativeAsset.asset.kind !== 'native' ||
    nativeAsset.asset.namespace !== 'slip44' ||
    nativeAsset.asset.reference !== QUANTUS_NATIVE_ASSET_REFERENCE
  ) {
    throw new Error('Quantus Portfolio native asset binding is invalid')
  }
  try {
    await input.rpc.assertExpectedChain(input.signal)
    const account = await input.rpc.getAccountInfo(address, input.signal)
    const updatedAt = (input.now ?? Date.now)()
    const total = account.free + account.reserved
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: Object.freeze([
        Object.freeze({
          assetId: nativeAssetId,
          totalRaw: total.toString(),
          spendableRaw: account.free.toString(),
          availableRaw: total.toString(),
          pendingRaw: '0',
          updatedAt
        })
      ])
    })
  } catch (error) {
    if (error instanceof QuantusRpcError && error.code === 'cancelled') throw error
    const errorCode = error instanceof QuantusRpcError ? mapErrorCode(error.code) : 'unknown'
    const cause =
      error instanceof QuantusRpcError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown'
    logger.warn(
      `Quantus Portfolio refresh failed code=${errorCode} cause=${cause}`,
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
