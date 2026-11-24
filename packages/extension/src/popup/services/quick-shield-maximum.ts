import {
  confidentialFundingClient,
  type PrepareConfidentialFundingRequest
} from './confidential-funding-client'
import { evmWalletClient } from './evm-wallet-client'
import { quickShieldSpendableRaw } from './quick-shield'
import { matchesShieldReview } from './shield-transfer'
import { matchesFixedShieldFundsRecipient } from './shield-funds-route'

export async function readQuickShieldBalances(request: PrepareConfidentialFundingRequest) {
  const { chainId, assetId } = request.source
  const portfolio = await evmWalletClient.getPortfolio('refresh', {
    chainIds: [chainId],
    detailAssetId: assetId,
    refreshConfidential: false,
    expectedWalletId: request.keyDomainId,
    expectedAccountId: request.accountId
  })
  const chain = portfolio?.chains.find(item => item.chain.id === chainId)
  const asset = chain?.assets.find(item => item.asset.id === assetId)
  const native = chain?.assets.find(item => item.asset.kind === 'native')
  const assetRaw = asset && quickShieldSpendableRaw(asset)
  const gasRaw = native && quickShieldSpendableRaw(native)
  if (
    portfolio?.scope.keyDomainId !== request.keyDomainId ||
    portfolio.scope.accountId !== request.accountId ||
    asset?.freshness !== 'fresh' ||
    native?.freshness !== 'fresh' ||
    assetRaw == null ||
    gasRaw == null ||
    !chain ||
    chain.errorCodes.length
  ) {
    throw new Error('Could not refresh the spendable balance. Try again.')
  }
  return {
    native: asset.asset.kind === 'native',
    assetRaw: BigInt(assetRaw),
    gasRaw: BigInt(gasRaw)
  }
}

export function quickShieldMaximum(
  balances: Awaited<ReturnType<typeof readQuickShieldBalances>>,
  feeRaw: string
) {
  const fee = BigInt(feeRaw)
  const amount = balances.native ? balances.assetRaw - fee : balances.assetRaw
  if (fee <= 0n || balances.gasRaw < fee || amount <= 0n)
    throw new Error('Insufficient balance for the transfer and network fee.')
  return amount.toString()
}

export async function prepareQuickShieldMaximum(
  request: PrepareConfidentialFundingRequest,
  sender: string,
  current: () => boolean
) {
  const balances = await readQuickShieldBalances(request)
  if (!current()) return null
  let amountRaw = balances.assetRaw.toString()
  if (balances.native) {
    const estimate = await evmWalletClient.estimateTransferFee(
      { assetId: request.source.assetId, recipient: sender, amountRaw: '1' },
      { executionMode: 'main', feeSelection: request.feeSelection }
    )
    amountRaw = quickShieldMaximum(balances, estimate.maximumFeeWei)
  }
  for (let attempt = 0; attempt < 3 && current(); attempt++) {
    const candidate = {
      ...request,
      source: { ...request.source, amountRaw },
      dedupKey: `move:${crypto.randomUUID()}`
    }
    const review = await confidentialFundingClient.prepare(candidate)
    if (review.phase !== 'prepared') throw new Error('Could not prepare a new Shield review.')
    let keep = false
    try {
      if (!current()) return null
      if (
        !matchesShieldReview(review, candidate) ||
        !matchesFixedShieldFundsRecipient(review, candidate, sender) ||
        !review.sourceNetworkFee ||
        review.expiresAt <= Date.now()
      )
        throw new Error('Shield review changed. Try again.')
      const maximum = quickShieldMaximum(balances, review.sourceNetworkFee.raw)
      if (maximum === amountRaw) {
        keep = true
        return { review, request: candidate }
      }
      amountRaw = maximum
    } finally {
      if (!keep) await confidentialFundingClient.cancel(review.planId)
    }
  }
  if (current()) throw new Error('Network fees changed. Try again.')
  return null
}
