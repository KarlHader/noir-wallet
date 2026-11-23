import { useEffect, useMemo, useRef, useState } from 'react'
import { formatSortAddress } from '@/lib/format'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { parseNearAccountId } from '@/core/chains/near'
import type { PortfolioAssetView, PortfolioChainView } from '@/core/portfolio'
import { postExactNearIntentsQuote } from '@/core/services/intents-api'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import type { ChainSelectorOption } from '@/popup/components/common/ChainSelector'
import { RecipientSelector } from '@/popup/components/transaction/RecipientSelector'
import {
  SendFormActions,
  SendRecipientAddress,
  type SendFormAdapter
} from '@/popup/components/transaction/SendInputCards'
import { SendTransferScreen } from '@/popup/components/transaction/SendTransferView'
import { accountNetworksClient } from '@/popup/services/account-networks-client'
import {
  nearWalletClient,
  type NearTransferReview,
  type NearTransferSubmission
} from '@/popup/services/near-wallet-client'
import {
  NEAR_PRIVATE_SEND_SLIPPAGE_BPS,
  buildNearPrivateSendRouteInput,
  decideNearSendPage,
  nearPrivatePreparationMatches,
  readNearSendAccount
} from '@/popup/services/near-send-receive-page'
import type { NearPrivateSendAccount } from '@/popup/services/near-send-routing'
import {
  getNearSendApprovalError,
  getNearSendPrepareError
} from '@/popup/services/near-send-validation'
import { formatPortfolioNetworkName } from '@/popup/services/portfolio-format'
import { formatSendReviewAmounts, parseSendAmount } from '@/popup/services/send-transfer-model'
import { openModal } from '@/popup/provider/ModalManager'
import { useWalletStore } from '@/store/wallet-store'

const PRIVATE_PREPARE_ERROR = 'The private transfer could not be prepared.'
const RAW_AMOUNT = /^(?:0|[1-9][0-9]*)$/

export function useNearSendAccount(chainId: string): {
  readonly status: 'loading' | 'ready' | 'error'
  readonly account: NearPrivateSendAccount | null
} {
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    account: NearPrivateSendAccount | null
  }>({ status: 'loading', account: null })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', account: null })
    if (!walletId || !accountId) {
      setState({ status: 'error', account: null })
      return () => {
        cancelled = true
      }
    }
    void accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (cancelled) return
        const entry = catalog?.accounts.find(
          candidate => candidate.walletId === walletId && candidate.accountId === accountId
        )
        const network = entry?.networks.find(
          candidate => candidate.chain.id === chainId && candidate.chain.family === 'near'
        )
        const account =
          entry && network
            ? readNearSendAccount({
                accountIndex: entry.accountIndex,
                walletKind: entry.walletSource.kind,
                mainAccountId:
                  network.addresses.find(address => address.preferredForReceive)?.value ??
                  network.addresses[0]?.value,
                persistedPeaAccountId: network.privateExecutionAddress
              })
            : null
        setState(account ? { status: 'ready', account } : { status: 'error', account: null })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', account: null })
      })
    return () => {
      cancelled = true
    }
  }, [accountId, chainId, walletId])

  return state
}

function spendableRaw(asset: PortfolioAssetView, source: 'main' | 'incognito'): string {
  const value = source === 'incognito' ? asset.balance.privateRaw : asset.balance.mainRaw
  if (value !== undefined && RAW_AMOUNT.test(value)) return value
  return source === 'incognito' ? '0' : asset.balance.availableRaw
}

export function NearPrivateSendForm({
  selection,
  source,
  accountState,
  initialRecipient = '',
  initialAmount = '',
  destinationNetworks = [],
  onSelectDestinationNetwork,
  onSelectAsset,
  onDraftChange,
  onTogglePrivacy,
  onSubmitted
}: {
  readonly selection: { readonly asset: PortfolioAssetView; readonly chain: PortfolioChainView }
  readonly source: 'main' | 'incognito'
  readonly accountState: ReturnType<typeof useNearSendAccount>
  readonly initialRecipient?: string
  readonly initialAmount?: string
  readonly destinationNetworks?: readonly ChainSelectorOption[]
  readonly onSelectDestinationNetwork?: (
    chainId: string,
    draft: Readonly<{ recipient: string; amount: string }>
  ) => void
  readonly onSelectAsset?: (draft: Readonly<{ recipient: string; amount: string }>) => void
  readonly onDraftChange?: (draft: { readonly recipient: string; readonly amount: string }) => void
  readonly onTogglePrivacy?: () => void
  readonly onSubmitted: (submission: NearTransferSubmission) => void
}) {
  const asset = selection.asset
  const chain = selection.chain
  const networkName = formatPortfolioNetworkName(chain)
  const [recipient, setRecipient] = useState(initialRecipient)
  const [amount, setAmount] = useState(initialAmount)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [review, setReview] = useState<{
    readonly prepared: NearTransferReview
    readonly recipient: string
    readonly amountRaw: string
    readonly depositAddress: string
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const reviewRef = useRef(review)
  reviewRef.current = review

  useEffect(() => {
    onDraftChange?.({ recipient, amount })
  }, [amount, onDraftChange, recipient])

  useEffect(
    () => () => {
      abortRef.current?.abort()
      const pending = reviewRef.current
      reviewRef.current = null
      if (pending) {
        void nearWalletClient.rejectTransfer(pending.prepared.graph.root.id).catch(() => undefined)
      }
    },
    []
  )

  const parsedRecipient = useMemo(() => {
    try {
      return parseNearAccountId(recipient)
    } catch {
      return null
    }
  }, [recipient])
  const amountRaw = useMemo(
    () => parseSendAmount(amount, asset.metadata.decimals),
    [amount, asset.metadata.decimals]
  )
  const availableRaw = spendableRaw(asset, source)
  const availableKnown = RAW_AMOUNT.test(availableRaw)
  const insufficient =
    amountRaw !== null && availableKnown && BigInt(amountRaw) > BigInt(availableRaw)
  const accountMessage =
    accountState.status === 'loading'
      ? 'Loading account...'
      : accountState.account
        ? null
        : 'Unable to load account.'
  const placeholder =
    chain.chain.network.kind === 'testnet'
      ? 'alice.testnet or implicit account'
      : 'alice.near or implicit account'
  const canSelectNetwork = Boolean(onSelectDestinationNetwork && destinationNetworks.length > 1)

  const selectRecipient = async () => {
    await openModal<string | undefined>({
      title: 'Select Recipient',
      showCloseButton: true,
      scroll: 'body',
      fixedHeight: true,
      body: resolve => (
        <RecipientSelector
          chainId={chain.chain.id}
          onSelect={(address, name) => {
            setRecipient(address)
            setSelectedName(name ?? null)
            resolve(address)
          }}
        />
      )
    })
  }

  const continueSend = async () => {
    const account = accountState.account
    if (!account || !parsedRecipient || !amountRaw || insufficient || preparing) return
    const now = Date.now()
    const abort = new AbortController()
    abortRef.current?.abort()
    abortRef.current = abort
    setPreparing(true)
    setError(null)
    let prepared: NearTransferReview | null = null
    try {
      const quoteRoute = buildNearPrivateSendRouteInput({
        chainId: chain.chain.id,
        source,
        assetId: asset.asset.id,
        amountRaw,
        recipient: parsedRecipient,
        account,
        now
      })
      const quoted = quoteRoute
        ? decideNearSendPage({ sendPrivately: true, source, route: quoteRoute })
        : null
      if (!quoted || quoted.action !== 'private' || quoted.route.phase !== 'quote') {
        setError(quoted?.action === 'stopped' ? quoted.message : PRIVATE_PREPARE_ERROR)
        return
      }
      const quote = await postExactNearIntentsQuote(quoted.route.quoteRequest, abort.signal)
      if (abort.signal.aborted) return
      const fundedRoute = buildNearPrivateSendRouteInput({
        chainId: chain.chain.id,
        source,
        assetId: asset.asset.id,
        amountRaw,
        recipient: parsedRecipient,
        account,
        now,
        quote
      })
      const funded = fundedRoute
        ? decideNearSendPage({ sendPrivately: true, source, route: fundedRoute })
        : null
      if (!funded || funded.action !== 'private' || funded.route.phase !== 'intents-deposit') {
        setError(funded?.action === 'stopped' ? funded.message : PRIVATE_PREPARE_ERROR)
        return
      }
      prepared = await nearWalletClient.preparePrivateSend({
        source,
        assetId: asset.asset.id,
        amountRaw,
        recipient: parsedRecipient,
        slippageTolerance: NEAR_PRIVATE_SEND_SLIPPAGE_BPS,
        deadline: funded.route.quoteRequest.deadline,
        quote
      })
      const intent = prepared.graph.root.intent
      if (
        !nearPrivatePreparationMatches(
          {
            assetId: intent?.primaryAmount?.assetId ?? '',
            recipient: intent?.recipient?.address ?? '',
            amountRaw: intent?.primaryAmount?.amountRaw ?? '',
            signerId: intent?.sender?.address ?? ''
          },
          funded.route
        )
      ) {
        await nearWalletClient.rejectTransfer(prepared.graph.root.id).catch(() => undefined)
        prepared = null
        setError(PRIVATE_PREPARE_ERROR)
        return
      }
      setReview({
        prepared,
        recipient: parsedRecipient,
        amountRaw,
        depositAddress: funded.route.intentsDeposit.depositAddress
      })
      prepared = null
    } catch (caught) {
      if (prepared) {
        await nearWalletClient.rejectTransfer(prepared.graph.root.id).catch(() => undefined)
      }
      if (!abort.signal.aborted) setError(getNearSendPrepareError(caught, networkName))
    } finally {
      setPreparing(false)
    }
  }

  const closeReview = async () => {
    const current = review
    setReview(null)
    if (current) {
      await nearWalletClient.rejectTransfer(current.prepared.graph.root.id).catch(() => undefined)
    }
  }

  const approveSend = async () => {
    if (!review) return
    setApproving(true)
    setError(null)
    try {
      const submission = await nearWalletClient.approveTransfer(
        review.prepared.graph.root.id,
        review.prepared.review.payloadFingerprint.digestHex
      )
      setReview(null)
      onSubmitted(submission)
    } catch (caught) {
      const current = review
      setReview(null)
      setError(getNearSendApprovalError(caught))
      void nearWalletClient.rejectTransfer(current.prepared.graph.root.id).catch(() => undefined)
    } finally {
      setApproving(false)
    }
  }

  const reviewAmounts = review
    ? formatSendReviewAmounts(
        review.amountRaw,
        review.prepared.debit.maximumFeeRaw,
        asset.metadata.decimals,
        24,
        asset.asset.kind === 'native'
      )
    : null
  const adapter: SendFormAdapter = {
    amount: {
      ariaLabel: `${asset.metadata.symbol} amount`,
      value: amount,
      onChange: value => {
        if (/^\d*\.?\d*$/.test(value)) setAmount(value)
      }
    },
    asset: {
      assetId: asset.asset.id,
      symbol: asset.metadata.symbol,
      icon: asset.metadata.iconUrl,
      networkName,
      nativeChain: asset.asset.kind === 'native' ? 'near' : undefined,
      blockchain: asset.asset.kind === 'token' ? 'near' : undefined,
      disabled: preparing || approving || review !== null,
      onSelectAsset: onSelectAsset ? () => onSelectAsset({ recipient, amount }) : undefined
    },
    balance: {
      value: availableKnown
        ? formatBaseUnitDecimalAmount(availableRaw, asset.metadata.decimals)
        : null
    },
    maximum: {
      disabled: !availableKnown || BigInt(availableRaw) <= 0n,
      onClick: () => {
        if (!availableKnown || BigInt(availableRaw) <= 0n) return
        setAmount(formatBaseUnitDecimalAmount(availableRaw, asset.metadata.decimals))
      }
    },
    recipient: {
      id: 'near-private-send-recipient',
      value: recipient,
      onChange: value => {
        setSelectedName(null)
        setRecipient(value.trim())
      },
      placeholder,
      network: {
        name: networkName,
        icon: destinationNetworks.find(option => option.id === chain.chain.id)?.icon ?? 'near',
        onSelect: canSelectNetwork ? () => setNetworkPickerOpen(true) : undefined,
        disabled: preparing || approving || review !== null
      },
      onSelectRecipient: () => void selectRecipient(),
      feedback: recipient && !parsedRecipient && (
        <p className="px-1 text-xs text-danger">Enter a valid NEAR account ID.</p>
      )
    }
  }

  return (
    <SendTransferScreen
      destinationPicker={
        canSelectNetwork
          ? {
              open: networkPickerOpen,
              onOpenChange: setNetworkPickerOpen,
              selectedId: chain.chain.id,
              options: destinationNetworks,
              onSelect: id => {
                if (id !== chain.chain.id) {
                  onSelectDestinationNetwork?.(id, { recipient, amount })
                }
              }
            }
          : undefined
      }
      form={{
        adapter,
        footer: (
          <SendFormActions
            disabled={
              Boolean(accountMessage) ||
              !parsedRecipient ||
              !amountRaw ||
              insufficient ||
              preparing ||
              approving
            }
            loading={preparing}
            onContinue={() => void continueSend()}
            privacy={{ checked: true, onChange: onTogglePrivacy ?? (() => undefined) }}
          />
        ),
        children: (
          <>
            {insufficient && (
              <p role="alert" className="text-xs text-danger">
                Insufficient {asset.metadata.symbol} balance.
              </p>
            )}
            {accountMessage && (
              <p role="status" className="text-xs text-muted">
                {accountMessage}
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </>
        )
      }}
      review={{
        titleId: 'near-private-send-review-title',
        description: 'Review the NEAR recipient and maximum network fee before signing.',
        approving,
        onCancel: () => void closeReview(),
        onConfirm: () => void approveSend(),
        review:
          review && reviewAmounts
            ? {
                asset: {
                  assetId: asset.asset.id,
                  symbol: asset.metadata.symbol,
                  icon: asset.metadata.iconUrl
                },
                amount: reviewAmounts.amount,
                network: networkName,
                rows: [
                  {
                    label: 'Recipient',
                    content: (
                      <SendRecipientAddress
                        address={review.recipient}
                        name={selectedName ?? undefined}
                      />
                    )
                  },
                  {
                    label: 'Deposit',
                    content: (
                      <span className="font-mono text-muted">
                        {formatSortAddress(review.depositAddress)}
                      </span>
                    )
                  },
                  {
                    label: 'From',
                    content: (
                      <span className="font-mono text-muted">
                        {formatSortAddress(
                          review.prepared.graph.root.intent?.sender?.address ?? ''
                        )}
                      </span>
                    )
                  },
                  { label: 'Network', content: networkName },
                  {
                    label: 'Network fee',
                    content: <AmountDisplay value={reviewAmounts.fee} symbol="NEAR" profile="fee" />
                  },
                  ...(reviewAmounts.total === null
                    ? []
                    : [
                        {
                          label: 'Maximum total',
                          content: <AmountDisplay value={reviewAmounts.total} symbol="NEAR" />
                        }
                      ])
                ],
                confirmLabel: 'Confirm'
              }
            : null
      }}
    />
  )
}
