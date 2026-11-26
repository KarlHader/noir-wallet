import type { Network } from '@/types'
import { NOIR_RECEIVE_REFERRAL, NOIR_SEND_REFERRAL } from '@/config/intents'
import { isAddress } from 'viem'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { formatBaseUnitDecimalAmount, parseDisplayUnitAmount } from '@/lib/number-format'
import { resolveManagedIntentsAssets } from '@/core/services/intents-managed-assets'
import { getPrivateCrossChainTransferAssetGroup } from '@/core/chains/cross-chain-asset-group'
import { getAssetMarketMappings } from '@/core/prices/asset-market-mappings'
import {
  createInitialProductChainRegistry,
  getZcashChainId,
  parseAssetId,
  parseChainId,
  selectAdditionalEvmNetworks
} from '@/core/chains/registry'
import {
  assertConfidentialQuoteBinding,
  confidentialQuoteAppFeeBps,
  fingerprintConfidentialValue,
  type ConfidentialFundingPlan,
  type ConfidentialFundingReview,
  type ConfidentialQuote,
  type CreateExternalShieldDepositInput,
  type ExternalShieldDeposit
} from '@/core/services/confidential-funding'
import {
  buildConfidentialPortfolioView,
  filterConfidentialPortfolioMappings
} from '@/core/services/confidential-funding/confidential-funding-portfolio'
import {
  projectShieldDappBalances,
  projectShieldDappCatalog,
  projectShieldDappDepositStatus,
  projectShieldDappOperationDetails,
  projectShieldDappPlanStatus,
  projectShieldDappQuote,
  selectShieldSameTokenAsset,
  shieldDappOperationReport,
  shieldDappPlanAction,
  shieldSameDecimalsQuoteDifferenceRaw,
  unknownShieldDappOperation,
  type ShieldDappBalance,
  type ShieldDappOperationDetails,
  type ShieldDappOperationReport
} from '@/core/services/confidential-funding/shield-dapp-projection'
import type {
  ConfidentialFundingCoordinatorOptions,
  PrepareConfidentialFundingInput
} from './confidential-funding-coordinator'

type ShieldAccountScope = Readonly<{
  network: Network
  keyDomainId: string
  accountId: string
}>

interface ShieldCatalogToken {
  readonly chainId: string
  readonly assetId: string
  readonly symbol: string
  readonly decimals: number
  readonly protocolAssetId: string
  readonly blockchain: string
}

export interface ShieldDappCoordinatorOptions extends Pick<
  ConfidentialFundingCoordinatorOptions,
  | 'network'
  | 'api'
  | 'store'
  | 'signer'
  | 'assets'
  | 'evmNetworks'
  | 'assetMappings'
  | 'protocolTokens'
  | 'getProtocolTokens'
  | 'getNativeZecActiveAccount'
> {
  readonly now: () => number
  readonly prepare: (value: PrepareConfidentialFundingInput) => Promise<ConfidentialFundingReview>
  readonly createExternalDeposit: (
    value: CreateExternalShieldDepositInput
  ) => Promise<ExternalShieldDeposit>
  readonly refreshBalances: (
    scope: ShieldAccountScope,
    authorize: boolean
  ) => Promise<readonly Readonly<{ tokenId: string; available: string; source: string }>[]>
  readonly requireConfidentialSession: (scope: ShieldAccountScope) => Promise<unknown>
  readonly refreshExternalDeposit: (depositId: string) => Promise<ExternalShieldDeposit>
  readonly continuePlan: (planId: string) => Promise<ConfidentialFundingPlan>
  readonly updatePlan: (
    plan: ConfidentialFundingPlan,
    changes: Partial<ConfidentialFundingPlan>
  ) => Promise<ConfidentialFundingPlan>
  readonly readUsableSessionForPlan: (plan: ConfidentialFundingPlan) => Promise<unknown>
  readonly finishArrivedShieldDeposit: (
    plan: ConfidentialFundingPlan
  ) => Promise<ConfidentialFundingPlan | null>
  readonly isIdleShieldPlan: (plan: ConfidentialFundingPlan) => boolean
}

/** Plans are reused only for the same site, so one site cannot cancel or observe another's plan. */
async function shieldDappDedupKey(origin: string): Promise<string> {
  return `shield-dapp:${await fingerprintConfidentialValue(origin)}`
}

function quoteDeadline(quote: ConfidentialQuote): number {
  const value = Date.parse(quote.quote.deadline)
  if (!Number.isSafeInteger(value)) throw new Error('Confidential quote deadline is invalid')
  return value
}

/**
 * A Zcash origin-chain deposit refunds to a transparent address.
 * The confidential signer is an EVM account, which the quote service rejects as refundTo.
 */
export function selectOwnedTransparentZcashRefundAddress(input: {
  readonly network: Network
  readonly scope: ShieldAccountScope
  readonly account:
    | ReturnType<NonNullable<ShieldDappCoordinatorOptions['getNativeZecActiveAccount']>>
    | undefined
}): string {
  const refundTo = input.account?.refundAddresses.find(address => {
    try {
      return parseZcashAddress(address, input.network).scheme.startsWith('zcash-transparent-')
    } catch {
      return false
    }
  })
  if (
    !input.account ||
    input.account.network !== input.network ||
    input.account.network !== input.scope.network ||
    input.account.walletId !== input.scope.keyDomainId ||
    input.account.accountId !== input.scope.accountId ||
    !refundTo
  ) {
    throw new Error('Shield quote refund address is invalid.')
  }
  return refundTo
}

export class ShieldDappCoordinator {
  constructor(private readonly options: ShieldDappCoordinatorOptions) {}

  async shieldDappAuthorized(origin: string, scope: ShieldAccountScope): Promise<boolean> {
    if (scope.network !== this.options.network) return false
    return this.options.store.hasShieldSiteGrant(
      origin,
      scope.network,
      scope.keyDomainId,
      scope.accountId
    )
  }

  async grantShieldDapp(origin: string, scope: ShieldAccountScope): Promise<void> {
    if (scope.network !== this.options.network) throw new Error('Confidential network changed')
    await this.options.requireConfidentialSession(scope)
    await this.options.store.putShieldSiteGrant({
      origin,
      network: scope.network,
      keyDomainId: scope.keyDomainId,
      accountId: scope.accountId
    })
  }

  async revokeShieldDapp(origin: string, scope: ShieldAccountScope): Promise<void> {
    if (scope.network !== this.options.network) throw new Error('Confidential network changed')
    await this.options.store.deleteShieldSiteGrant(
      origin,
      scope.network,
      scope.keyDomainId,
      scope.accountId
    )
  }

  private shieldProductChains() {
    return createInitialProductChainRegistry(
      this.options.network,
      selectAdditionalEvmNetworks(this.options.network, this.options.evmNetworks)
    )
  }

  private shieldCatalogInputs() {
    const tokens = this.options.getProtocolTokens?.() ?? this.options.protocolTokens ?? []
    const managedAssets = (() => {
      try {
        return resolveManagedIntentsAssets(tokens, this.options.network, this.options.evmNetworks)
      } catch {
        return []
      }
    })()
    const chains = this.shieldProductChains()
    const zcashChainId = getZcashChainId(this.options.network)
    return { tokens, managedAssets, chains, zcashChainId }
  }

  listShieldDappCatalog(): Readonly<{
    chains: readonly Readonly<{ chainId: string; name: string }>[]
    tokens: readonly Readonly<{
      chainId: string
      assetId: string
      symbol: string
      decimals: number
    }>[]
  }> {
    const { tokens, managedAssets, chains, zcashChainId } = this.shieldCatalogInputs()
    return projectShieldDappCatalog({
      tokens,
      managedAssets,
      mappings: filterConfidentialPortfolioMappings(
        this.options.assetMappings,
        this.options.network
      ),
      assets: this.options.assets,
      network: this.options.network,
      acceptChain: chainId => {
        try {
          const chain = chains.resolve(chainId)
          return (
            (chain.family === 'evm' || chain.id === zcashChainId) &&
            chain.capabilities.transaction.status === 'available'
          )
        } catch {
          return false
        }
      },
      chainNameFor: chainId => {
        try {
          return chains.resolve(chainId).displayName
        } catch {
          return chainId
        }
      }
    })
  }

  private resolveShieldCatalogToken(chainId: string, assetId: string): ShieldCatalogToken {
    const { tokens, managedAssets } = this.shieldCatalogInputs()
    const catalog = this.listShieldDappCatalog().tokens.find(
      token => token.chainId === chainId && token.assetId === assetId
    )
    const managed = managedAssets.find(
      asset => asset.management === 'evm' && asset.chainId === chainId && asset.assetId === assetId
    )
    const mapping = managed
      ? undefined
      : filterConfidentialPortfolioMappings(this.options.assetMappings, this.options.network).find(
          item => item.assetId === assetId
        )
    const protocolAssetId = managed?.protocolAssetId ?? mapping?.protocolAssetId
    const protocol = protocolAssetId
      ? tokens.find(token => token.assetId === protocolAssetId)
      : undefined
    if (!catalog || !protocolAssetId || !protocol || protocol.decimals !== catalog.decimals) {
      throw new Error('Shield token is not available.')
    }
    return Object.freeze({
      chainId,
      assetId,
      symbol: catalog.symbol,
      decimals: catalog.decimals,
      protocolAssetId,
      blockchain: protocol.blockchain
    })
  }

  private shieldTokenIdentity(assetId: string): string | null {
    if (this.options.network === 'mainnet') {
      try {
        // BNB USDC shares the private USDC group. Public send does not map that contract.
        const group = getPrivateCrossChainTransferAssetGroup(parseAssetId(assetId))
        if (group) return group
      } catch {
        return null
      }
    }
    return (
      getAssetMarketMappings(this.options.network, this.options.assets).find(
        mapping => mapping.assetId === assetId
      )?.marketAssetId ?? null
    )
  }

  private resolveTransferDestinationToken(
    source: ShieldCatalogToken,
    destinationChainId?: string
  ): ShieldCatalogToken {
    if (!destinationChainId || destinationChainId === source.chainId) return source
    const selected = selectShieldSameTokenAsset({
      sourceAssetId: source.assetId,
      sourceSymbol: source.symbol,
      destinationChainId,
      tokens: this.listShieldDappCatalog().tokens,
      identityFor: assetId => this.shieldTokenIdentity(assetId)
    })
    if (!selected) throw new Error('Shield token is not available.')
    return this.resolveShieldCatalogToken(selected.chainId, selected.assetId)
  }

  private shieldQuoteRecipient(chainId: string, address: string): string {
    if (chainId.startsWith('eip155:')) {
      if (!isAddress(address) || /^0x0{40}$/i.test(address)) {
        throw new Error('Shield destination address is invalid.')
      }
      return address
    }
    if (chainId === getZcashChainId(this.options.network)) {
      parseZcashAddress(address, this.options.network)
      return address
    }
    throw new Error('Shield destination chain is invalid.')
  }

  async quoteShieldDapp(input: {
    readonly scope: ShieldAccountScope
    readonly action: 'receive' | 'transfer'
    readonly amount: string
    readonly source: Readonly<{ chainId: string; assetId: string }>
    readonly destination?:
      | Readonly<{ kind: 'public'; chainId: string; address: string }>
      | Readonly<{ kind: 'confidential'; accountId: string; chainId?: string }>
  }) {
    if (input.scope.network !== this.options.network)
      throw new Error('Confidential network changed')
    if (input.action === 'transfer' && !input.destination) {
      throw new Error('Shield destination chain is invalid.')
    }
    const source = this.resolveShieldCatalogToken(input.source.chainId, input.source.assetId)
    let amountRaw: string
    try {
      amountRaw = parseDisplayUnitAmount(input.amount, source.decimals)
    } catch {
      throw new Error('Shield amount is invalid.')
    }
    if (!/^[1-9][0-9]*$/.test(amountRaw)) throw new Error('Shield amount is invalid.')
    const signingChain = source.chainId.startsWith('eip155:')
      ? source.chainId
      : this.options.evmNetworks.find(network => network.chainId.startsWith('eip155:'))?.chainId
    if (!signingChain) throw new Error('Confidential EVM network is unavailable')
    const identity = await this.options.signer.resolveIdentity(parseChainId(signingChain).id)
    if (
      identity.context.chainAccount.scope.keyDomainId !== input.scope.keyDomainId ||
      identity.context.chainAccount.scope.accountId !== input.scope.accountId
    ) {
      throw new Error('Active Wallet Account changed')
    }
    const confidentialDestination =
      input.destination?.kind === 'confidential' ? input.destination : undefined
    const publicDestination = input.destination?.kind === 'public' ? input.destination : undefined
    const destination = publicDestination
      ? this.resolveTransferDestinationToken(source, publicDestination.chainId)
      : confidentialDestination
        ? this.resolveTransferDestinationToken(source, confidentialDestination.chainId)
        : source
    // A different destination chain may credit the connected account. The same chain cannot.
    if (
      confidentialDestination &&
      confidentialDestination.accountId.toLowerCase() === identity.address.toLowerCase() &&
      destination.chainId === source.chainId
    ) {
      throw new Error('Shield recipient account is invalid.')
    }
    const recipient = confidentialDestination
      ? confidentialDestination.accountId
      : publicDestination
        ? this.shieldQuoteRecipient(publicDestination.chainId, publicDestination.address)
        : identity.address
    const zcashReceiveRefundTo =
      input.action === 'receive' && source.chainId === getZcashChainId(this.options.network)
        ? selectOwnedTransparentZcashRefundAddress({
            network: this.options.network,
            scope: input.scope,
            account: this.options.getNativeZecActiveAccount?.()
          })
        : undefined
    const binding = Object.freeze(
      input.action === 'receive'
        ? {
            originAsset: source.protocolAssetId,
            destinationAsset: source.protocolAssetId,
            amountRaw,
            signerId: identity.address,
            ...(zcashReceiveRefundTo ? { refundTo: zcashReceiveRefundTo } : {}),
            recipient: identity.address,
            depositType: 'ORIGIN_CHAIN' as const,
            refundType: 'ORIGIN_CHAIN' as const,
            recipientType: 'CONFIDENTIAL_INTENTS' as const,
            slippageBps: 50
          }
        : confidentialDestination
          ? {
              originAsset: source.protocolAssetId,
              destinationAsset: destination.protocolAssetId,
              amountRaw,
              signerId: identity.address,
              recipient,
              depositType: 'CONFIDENTIAL_INTENTS' as const,
              refundType: 'CONFIDENTIAL_INTENTS' as const,
              recipientType: 'CONFIDENTIAL_INTENTS' as const,
              slippageBps: 50
            }
          : {
              originAsset: source.protocolAssetId,
              destinationAsset: destination.protocolAssetId,
              amountRaw,
              signerId: identity.address,
              recipient,
              depositType: 'CONFIDENTIAL_INTENTS' as const,
              refundType: 'CONFIDENTIAL_INTENTS' as const,
              recipientType: 'DESTINATION_CHAIN' as const,
              slippageBps: 50
            }
    )
    const quote = await this.options.api.quote({
      ...binding,
      referral: input.action === 'receive' ? NOIR_RECEIVE_REFERRAL : NOIR_SEND_REFERRAL,
      dry: true
    })
    assertConfidentialQuoteBinding(quote, binding, this.options.now())
    let projected
    try {
      projected = projectShieldDappQuote({
        action: input.action,
        amountRaw,
        amountOutRaw: quote.quote.amountOut,
        sourceDecimals: source.decimals,
        destinationDecimals: destination.decimals,
        sameAsset: source.protocolAssetId === destination.protocolAssetId,
        expiresAt: quoteDeadline(quote),
        source: { chainId: source.chainId, assetId: source.assetId, symbol: source.symbol },
        destination: {
          chainId: destination.chainId,
          assetId: destination.assetId,
          symbol: destination.symbol
        }
      })
    } catch {
      throw new Error('Shield quote is invalid.')
    }
    return projected
  }

  async prepareShieldDappReceive(input: {
    readonly origin: string
    readonly scope: ShieldAccountScope
    readonly source: Readonly<{ chainId: string; assetId: string }>
    readonly amount: string
  }): Promise<{
    readonly planId: string
    readonly phase: ConfidentialFundingPlan['phase'] | 'awaiting-payment'
    readonly payloadFingerprint: string
    readonly amount: string
    readonly symbol: string
    readonly chainName: string
    readonly assetId: string
    readonly sourceAddress: string
    readonly expectedReceive: string
    readonly expectedSymbol: string
    readonly quoteDifference?: string
    readonly networkFee?: string
    readonly networkFeeSymbol?: string
  }> {
    if (input.scope.network !== this.options.network)
      throw new Error('Active Wallet Account changed')
    const source = this.resolveShieldCatalogToken(input.source.chainId, input.source.assetId)
    const amountRaw = parseDisplayUnitAmount(input.amount, source.decimals)
    if (source.chainId === getZcashChainId(this.options.network)) {
      return this.prepareShieldDappZcashReceive(input, source, amountRaw)
    }
    if (!source.chainId.startsWith('eip155:')) throw new Error('Shield chain is invalid.')
    if (!/^[1-9]\d*$/.test(amountRaw)) throw new Error('Shield amount is invalid.')
    const chainName = this.shieldProductChains().resolve(source.chainId).displayName
    const review = await this.options.prepare({
      network: input.scope.network,
      keyDomainId: input.scope.keyDomainId,
      accountId: input.scope.accountId,
      operation: 'deposit',
      sourceDomain: 'public',
      destinationDomain: 'shield',
      source: {
        chainId: source.chainId,
        chainName: source.blockchain,
        assetId: source.assetId,
        protocolAssetId: source.protocolAssetId,
        amountRaw
      },
      destination: {
        chainId: source.chainId,
        chainName: source.blockchain,
        assetId: source.assetId,
        protocolAssetId: source.protocolAssetId
      },
      slippageBps: 50,
      dedupKey: await shieldDappDedupKey(input.origin)
    })
    return Object.freeze({
      planId: review.planId,
      phase: review.phase,
      payloadFingerprint: review.payloadFingerprint,
      amount: formatBaseUnitDecimalAmount(amountRaw, source.decimals),
      symbol: source.symbol,
      chainName,
      assetId: source.assetId,
      ...this.shieldApprovalQuoteFields(review, source, source)
    })
  }

  /**
   * ZEC receive quotes an external deposit. The connected account's transparent address is the refund
   * target and the account that pays it. Confirmation broadcasts that transparent payment.
   */
  private async prepareShieldDappZcashReceive(
    input: {
      readonly origin: string
      readonly scope: ShieldAccountScope
    },
    source: ShieldCatalogToken,
    amountRaw: string
  ) {
    if (!/^[1-9]\d*$/.test(amountRaw)) throw new Error('Shield amount is invalid.')
    const refundTo = selectOwnedTransparentZcashRefundAddress({
      network: this.options.network,
      scope: input.scope,
      account: this.options.getNativeZecActiveAccount?.()
    })
    const chainName = this.shieldProductChains().resolve(source.chainId).displayName
    // Each Receive click is its own deposit. A stable fingerprint would return an
    // earlier quote for the same amount, including one that is still unpaid.
    const requestId = crypto.randomUUID()
    const deposit = await this.options.createExternalDeposit({
      network: input.scope.network,
      keyDomainId: input.scope.keyDomainId,
      accountId: input.scope.accountId,
      source: {
        chainId: source.chainId,
        chainName,
        assetId: source.assetId,
        protocolAssetId: source.protocolAssetId,
        amountRaw
      },
      refundAddress: refundTo,
      slippageBps: 50,
      requestId
    })
    const differenceRaw = shieldSameDecimalsQuoteDifferenceRaw(
      amountRaw,
      deposit.expectedOutputRaw,
      true
    )
    return Object.freeze({
      planId: deposit.depositId,
      phase: deposit.phase,
      payloadFingerprint: requestId,
      amount: formatBaseUnitDecimalAmount(amountRaw, source.decimals),
      symbol: source.symbol,
      chainName,
      assetId: source.assetId,
      sourceAddress: refundTo,
      expectedReceive: formatBaseUnitDecimalAmount(deposit.expectedOutputRaw, source.decimals),
      expectedSymbol: source.symbol,
      feeSourceAmountRaw: amountRaw,
      feeSourceDecimals: String(source.decimals),
      feeBps: String(confidentialQuoteAppFeeBps(deposit.quote)),
      ...(differenceRaw
        ? { quoteDifference: formatBaseUnitDecimalAmount(differenceRaw, source.decimals) }
        : {})
    })
  }

  async prepareShieldDappTransfer(input: {
    readonly origin: string
    readonly scope: ShieldAccountScope
    readonly token: Readonly<{ chainId: string; assetId: string }>
    readonly amount: string
    readonly destination:
      | Readonly<{ kind: 'public'; chainId: string; address: string }>
      | Readonly<{ kind: 'confidential'; accountId: string; chainId?: string }>
  }): Promise<{
    readonly planId: string
    readonly phase: ConfidentialFundingPlan['phase']
    readonly payloadFingerprint: string
    readonly amount: string
    readonly symbol: string
    readonly chainName: string
    readonly assetId: string
    readonly destinationAddress: string
    readonly destinationChainName: string
    readonly destinationSymbol: string
    readonly destinationAssetId: string
    readonly sourceAddress: string
    readonly expectedReceive: string
    readonly expectedSymbol: string
    readonly quoteDifference?: string
    readonly networkFee?: string
    readonly networkFeeSymbol?: string
  }> {
    if (input.scope.network !== this.options.network)
      throw new Error('Active Wallet Account changed')
    const source = this.resolveShieldCatalogToken(input.token.chainId, input.token.assetId)
    if (input.destination.kind === 'confidential') {
      const target = this.resolveTransferDestinationToken(source, input.destination.chainId)
      let amountRaw: string
      try {
        amountRaw = parseDisplayUnitAmount(input.amount, source.decimals)
      } catch {
        throw new Error('Shield amount is invalid.')
      }
      if (!/^[1-9]\d*$/.test(amountRaw)) throw new Error('Shield amount is invalid.')
      const chains = this.shieldProductChains()
      const review = await this.options.prepare({
        network: input.scope.network,
        keyDomainId: input.scope.keyDomainId,
        accountId: input.scope.accountId,
        operation: 'confidential-transfer',
        sourceDomain: 'shield',
        destinationDomain: 'shield',
        source: {
          chainId: source.chainId,
          chainName: source.blockchain,
          assetId: source.assetId,
          protocolAssetId: source.protocolAssetId,
          amountRaw
        },
        destination: {
          chainId: target.chainId,
          chainName: target.blockchain,
          assetId: target.assetId,
          protocolAssetId: target.protocolAssetId
        },
        confidentialRecipient: input.destination.accountId,
        slippageBps: 50,
        dedupKey: await shieldDappDedupKey(input.origin)
      })
      return Object.freeze({
        planId: review.planId,
        phase: review.phase,
        payloadFingerprint: review.payloadFingerprint,
        amount: formatBaseUnitDecimalAmount(amountRaw, source.decimals),
        symbol: source.symbol,
        chainName: chains.resolve(source.chainId).displayName,
        assetId: source.assetId,
        destinationAddress: input.destination.accountId,
        destinationChainName: 'NEAR Confidential',
        destinationSymbol: target.symbol,
        destinationAssetId: target.assetId,
        ...this.shieldApprovalQuoteFields(review, source, target)
      })
    }
    const destination = this.resolveTransferDestinationToken(source, input.destination.chainId)
    const zcashChainId = getZcashChainId(this.options.network)
    // Same-chain public ZEC, including this account's transparent address, is a withdraw.
    // Same-chain confidential sends back to this account are rejected earlier.
    if (!destination.chainId.startsWith('eip155:') && destination.chainId !== zcashChainId) {
      throw new Error('Shield destination chain is invalid.')
    }
    const recipient = this.shieldQuoteRecipient(destination.chainId, input.destination.address)
    let amountRaw: string
    try {
      amountRaw = parseDisplayUnitAmount(input.amount, source.decimals)
    } catch {
      throw new Error('Shield amount is invalid.')
    }
    if (!/^[1-9]\d*$/.test(amountRaw)) throw new Error('Shield amount is invalid.')
    const chains = this.shieldProductChains()
    const review = await this.options.prepare({
      network: input.scope.network,
      keyDomainId: input.scope.keyDomainId,
      accountId: input.scope.accountId,
      operation: 'withdraw',
      sourceDomain: 'shield',
      destinationDomain: 'public',
      source: {
        chainId: source.chainId,
        chainName: source.blockchain,
        assetId: source.assetId,
        protocolAssetId: source.protocolAssetId,
        amountRaw
      },
      destination: {
        chainId: destination.chainId,
        chainName: destination.blockchain,
        assetId: destination.assetId,
        protocolAssetId: destination.protocolAssetId
      },
      externalRecipient: recipient,
      slippageBps: 50,
      dedupKey: await shieldDappDedupKey(input.origin)
    })
    return Object.freeze({
      planId: review.planId,
      phase: review.phase,
      payloadFingerprint: review.payloadFingerprint,
      amount: formatBaseUnitDecimalAmount(amountRaw, source.decimals),
      symbol: source.symbol,
      chainName: chains.resolve(source.chainId).displayName,
      assetId: source.assetId,
      destinationAddress: recipient,
      destinationChainName: chains.resolve(destination.chainId).displayName,
      destinationSymbol: destination.symbol,
      destinationAssetId: destination.assetId,
      ...this.shieldApprovalQuoteFields(review, source, destination)
    })
  }

  async refreshShieldDappBalances(
    scope: ShieldAccountScope,
    authorize: boolean
  ): Promise<readonly ShieldDappBalance[]> {
    const balances = await this.options.refreshBalances(scope, authorize)
    const { tokens, managedAssets, chains } = this.shieldCatalogInputs()
    const view = buildConfidentialPortfolioView(
      balances,
      tokens,
      managedAssets,
      filterConfidentialPortfolioMappings(this.options.assetMappings, this.options.network),
      this.options.assets
    )
    return projectShieldDappBalances(view, chainId => {
      try {
        return chains.resolve(chainId).displayName
      } catch {
        return chainId
      }
    })
  }

  reportStoredShieldDappPlan(plan: ConfidentialFundingPlan): ShieldDappOperationReport {
    return shieldDappOperationReport(
      plan.planId,
      shieldDappPlanAction(plan),
      projectShieldDappPlanStatus(plan),
      this.shieldDappPlanDetails(plan)
    )
  }

  async readShieldDappStatus(input: {
    readonly scope: ShieldAccountScope
    readonly operationId: string
  }): Promise<ShieldDappOperationReport> {
    if (input.scope.network !== this.options.network)
      throw new Error('Confidential network changed')
    const plan = await this.options.store.getPlan(input.operationId).catch(() => null)
    if (plan) {
      if (!this.shieldRecordInScope(plan, input.scope)) {
        return unknownShieldDappOperation(input.operationId)
      }
      const current = await this.observeShieldPlan(plan)
      return this.reportStoredShieldDappPlan(current)
    }
    const deposit = await this.options.store.getExternalDeposit(input.operationId).catch(() => null)
    if (!deposit || !this.shieldRecordInScope(deposit, input.scope)) {
      return unknownShieldDappOperation(input.operationId)
    }
    let current = deposit
    try {
      current = await this.options.refreshExternalDeposit(deposit.depositId)
    } catch {
      current =
        (await this.options.store.getExternalDeposit(deposit.depositId).catch(() => null)) ??
        deposit
    }
    return shieldDappOperationReport(
      current.depositId,
      'receive',
      projectShieldDappDepositStatus(current),
      this.shieldDappDepositDetails(current)
    )
  }

  private shieldApprovalQuoteFields(
    review: ConfidentialFundingReview,
    source: Readonly<{ decimals: number; symbol: string }>,
    destination: Readonly<{ decimals: number; symbol: string }>
  ): Readonly<{
    sourceAddress: string
    expectedReceive: string
    expectedSymbol: string
    quoteDifference?: string
    feeSourceAmountRaw: string
    feeSourceDecimals: string
    feeBps: string
    networkFee?: string
    networkFeeSymbol?: string
  }> {
    const differenceRaw = shieldSameDecimalsQuoteDifferenceRaw(
      review.sourceAmountRaw,
      review.expectedOutputRaw,
      source.decimals === destination.decimals
    )
    const networkFee = review.sourceNetworkFee
    return Object.freeze({
      sourceAddress: review.sourceAddress,
      expectedReceive: formatBaseUnitDecimalAmount(review.expectedOutputRaw, destination.decimals),
      expectedSymbol: destination.symbol,
      feeSourceAmountRaw: review.sourceAmountRaw,
      feeSourceDecimals: String(source.decimals),
      feeBps: String(review.quoteAppFeeBps ?? 0),
      ...(differenceRaw
        ? { quoteDifference: formatBaseUnitDecimalAmount(differenceRaw, source.decimals) }
        : {}),
      ...(networkFee
        ? {
            networkFee: formatBaseUnitDecimalAmount(networkFee.raw, networkFee.decimals),
            networkFeeSymbol: networkFee.symbol
          }
        : {})
    })
  }

  private shieldCatalogTokenDisplay(
    chainId: string,
    assetId: string
  ): Readonly<{ symbol?: string; decimals?: number }> {
    try {
      const token = this.listShieldDappCatalog().tokens.find(
        candidate => candidate.chainId === chainId && candidate.assetId === assetId
      )
      return token ? { symbol: token.symbol, decimals: token.decimals } : {}
    } catch {
      return {}
    }
  }

  private shieldDappPlanDetails(plan: ConfidentialFundingPlan): ShieldDappOperationDetails {
    const hashes: string[] = []
    const depositHash = plan.preparedDeposit?.transactionHash
    if (typeof depositHash === 'string') hashes.push(depositHash)
    for (const row of plan.withdraws ?? []) {
      if (typeof row?.transactionHash === 'string') hashes.push(row.transactionHash)
    }
    return projectShieldDappOperationDetails({
      ...(plan.source
        ? {
            source: {
              chainId: plan.source.chainId,
              assetId: plan.source.assetId,
              amountRaw: plan.source.amountRaw,
              ...this.shieldCatalogTokenDisplay(plan.source.chainId, plan.source.assetId)
            }
          }
        : {}),
      ...(plan.destination
        ? {
            destination: {
              chainId: plan.destination.chainId,
              assetId: plan.destination.assetId,
              amountRaw: plan.expectedOutputRaw,
              ...this.shieldCatalogTokenDisplay(plan.destination.chainId, plan.destination.assetId)
            }
          }
        : {}),
      transactionHashes: hashes,
      ...(typeof plan.orderId === 'string' ? { orderId: plan.orderId } : {})
    })
  }

  private shieldDappDepositDetails(record: {
    readonly source?: Readonly<{ chainId?: string; assetId?: string; amountRaw?: string }>
    readonly amountRaw?: string
    readonly sourceSymbol?: string
    readonly sourceDecimals?: number
    readonly depositAddress?: string
    readonly depositMemo?: string
  }): ShieldDappOperationDetails {
    const depositAddress =
      typeof record.depositAddress === 'string' &&
      record.depositAddress.length > 0 &&
      record.depositAddress.length <= 256
        ? record.depositAddress
        : undefined
    const depositMemo =
      typeof record.depositMemo === 'string' &&
      record.depositMemo.length > 0 &&
      record.depositMemo.length <= 256
        ? record.depositMemo
        : undefined
    if (!record.source) {
      return Object.freeze({
        ...(depositAddress ? { depositAddress } : {}),
        ...(depositMemo ? { depositMemo } : {})
      })
    }
    return Object.freeze({
      ...projectShieldDappOperationDetails({
        source: {
          chainId: record.source.chainId,
          assetId: record.source.assetId,
          amountRaw: record.amountRaw ?? record.source.amountRaw,
          ...(typeof record.sourceSymbol === 'string' ? { symbol: record.sourceSymbol } : {}),
          ...(typeof record.sourceDecimals === 'number' ? { decimals: record.sourceDecimals } : {})
        }
      }),
      ...(depositAddress ? { depositAddress } : {}),
      ...(depositMemo ? { depositMemo } : {})
    })
  }

  private shieldRecordInScope(
    record: Readonly<{ network: Network; keyDomainId: string; accountId: string }>,
    scope: ShieldAccountScope
  ): boolean {
    return (
      record.network === this.options.network &&
      record.network === scope.network &&
      record.keyDomainId === scope.keyDomainId &&
      record.accountId === scope.accountId
    )
  }

  private async observeShieldPlan(plan: ConfidentialFundingPlan): Promise<ConfidentialFundingPlan> {
    if (plan.phase === 'needs-auth') {
      const settled = await this.options.finishArrivedShieldDeposit(plan).catch(() => null)
      if (settled) return settled
      if (plan.resumePhase !== 'deposit-confirming' && plan.resumePhase !== 'deposit-signed') {
        return plan
      }
      const session = await this.options.readUsableSessionForPlan(plan).catch(() => null)
      if (!session) return plan
      const resumed = await this.options.updatePlan(plan, {
        phase: plan.resumePhase,
        resumePhase: undefined
      })
      try {
        return await this.options.continuePlan(resumed.planId)
      } catch {
        return (await this.options.store.getPlan(plan.planId).catch(() => null)) ?? resumed
      }
    }
    if (this.options.isIdleShieldPlan(plan)) return plan
    const settled = await this.options.finishArrivedShieldDeposit(plan).catch(() => null)
    if (settled) return settled
    try {
      return await this.options.continuePlan(plan.planId)
    } catch {
      return (await this.options.store.getPlan(plan.planId).catch(() => null)) ?? plan
    }
  }
}
