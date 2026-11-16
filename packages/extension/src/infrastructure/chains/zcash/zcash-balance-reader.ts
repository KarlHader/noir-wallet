import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry, ChainRegistry } from '@/core/chains/registry'
import {
  parsePortfolioSourceState,
  type PortfolioReadErrorCode,
  type PortfolioSourceSnapshot,
  type PortfolioSourceStatus
} from '@/core/portfolio'
import type { ZcashBalance } from '@/types'
import { parseDisplayUnitAmount } from '@/lib/number-format'

const ZCASH_DECIMALS = 8
const ZEC_ASSET_REFERENCE = 'slip44:133'
const ZEC_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,119})(?:\.([0-9]{1,8}))?$/

export interface ReadZcashPortfolioInput {
  readonly chainId: string
  readonly chainAccount: ChainAccount
  readonly chains: ChainRegistry
  readonly assets: AssetRegistry
  readonly balance: ZcashBalance | null
  readonly status: PortfolioSourceStatus
  readonly updatedAt: number
  readonly errorCode?: PortfolioReadErrorCode
}

function toZatoshis(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error(`${label} must be a canonical ZEC amount`)
  }
  const match = ZEC_AMOUNT_PATTERN.exec(value)
  if (!match) throw new Error(`${label} must be a canonical ZEC amount`)
  return parseDisplayUnitAmount(value, ZCASH_DECIMALS)
}

export function readZcashPortfolioSource(input: ReadZcashPortfolioInput): PortfolioSourceSnapshot {
  const chain = input.chains.resolve(input.chainId)
  if (
    chain.family !== 'zcash' ||
    input.chainAccount.scope.chainId !== chain.id ||
    !Number.isSafeInteger(input.updatedAt) ||
    input.updatedAt < 0
  ) {
    throw new Error('Invalid Zcash Portfolio source context')
  }
  const asset = input.assets.resolve(`${chain.id}/${ZEC_ASSET_REFERENCE}`)
  if (
    asset.asset.chainId !== chain.id ||
    asset.asset.kind !== 'native' ||
    asset.metadata.decimals !== ZCASH_DECIMALS
  ) {
    throw new Error('Invalid Zcash native asset definition')
  }
  if (input.status === 'ready' && input.balance === null) {
    throw new Error('Ready Zcash Portfolio source requires a balance')
  }

  const balances =
    input.balance === null
      ? []
      : [
          {
            assetId: asset.asset.id,
            totalRaw: toZatoshis(input.balance?.total ?? '0', 'Zcash total balance'),
            spendableRaw: toZatoshis(
              input.balance?.spendable ?? input.balance?.shielded ?? '0',
              'Zcash spendable balance'
            ),
            availableRaw: toZatoshis(
              input.balance?.available ??
                input.balance?.spendable ??
                input.balance?.shielded ??
                '0',
              'Zcash available balance'
            ),
            pendingRaw: toZatoshis(input.balance?.pending?.total ?? '0', 'Zcash pending balance'),
            shieldableRaw: toZatoshis(
              input.balance?.shieldable ?? input.balance?.transparent ?? '0',
              'Zcash shieldable balance'
            ),
            shieldedRaw: toZatoshis(input.balance?.shielded ?? '0', 'Zcash shielded balance'),
            transparentRaw: toZatoshis(
              input.balance?.transparent ?? '0',
              'Zcash transparent balance'
            ),
            shieldedPendingRaw: toZatoshis(
              input.balance?.pending?.shielded ?? '0',
              'Zcash shielded pending balance'
            ),
            transparentPendingRaw: toZatoshis(
              input.balance?.pending?.transparent ?? '0',
              'Zcash transparent pending balance'
            ),
            updatedAt: input.updatedAt
          }
        ]
  const state = parsePortfolioSourceState({
    status: input.status,
    balances,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
  })
  return Object.freeze({
    chainAccount: input.chainAccount,
    ...state
  })
}
