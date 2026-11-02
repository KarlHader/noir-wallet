import { useState, useEffect } from 'react'
import { TokenIcon } from '../tokens/TokenIcon'
import { Button } from '../ui/button'
import { formatExplorerUrl, formatSortAddress, detectAddressType } from '@/lib/format'
import { formatAmount } from '@/lib/number-format'
import { safeBig } from '@/lib/big'
import { AmountDisplay } from '@/popup/components/common/AmountDisplay'
import { AddressTypeLabel } from '@/popup/components/account/AddressType'

import { DetailRow } from '@/popup/components/common/DetailRow'
import { getTransactionRecoveryAction } from '@/lib/transaction-replacement'
import { isMultiStepZcashSend } from '@/lib/tx-history-dedup'
import { buildAccountKey, useAccountDataStore } from '@/store/account-data-store'
import { useWalletStore } from '@/store/wallet-store'
import { useAddressBookStore } from '@/store/address-book-store'
import { ZEC_DECIMALS } from '@/config/wallet'
import type { WasmTransactionEntry } from '@/core/worker/types'
import type { Transaction } from '@/types/wallet'
import { resolveMinedTransactionStatus } from '@/lib/transaction-status'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashChainId } from '@/core/chains/registry'
import { formatChainTransactionExplorerUrl } from '@/popup/services/chain-explorer'
import { getLegacyIntentsProgressPresentation } from '@/popup/services/transaction-progress'
import { getTransactionStatusToneClassName } from '@/lib/transaction-status-presentation'
import {
  getMissingZcashTransactionSource,
  getZcashTransactionRecipient
} from '@/popup/services/zcash-transaction-parties'
import { TransactionProgressSteps } from './TransactionProgressSteps'

function formatZcashTransactionExplorerUrl(hash: string): string {
  return formatChainTransactionExplorerUrl(getZcashChainId(DEFAULT_NETWORK), hash, DEFAULT_NETWORK)
}
import { useIntentsProgress } from '../../hooks/useIntentsProgress'
import { getIntentsExplorerUrl } from '@/lib/intents-progress'
import {
  getIntentsStatusCopy,
  getOnChainStatusCopy,
  getTransactionStatusCopy
} from '@/lib/transaction-status-copy'

interface TransactionDetailContentProps {
  transactionId?: string
  onClose?: () => void
  /** Opens the Speed Up confirm sheet (hosted by the page, not this modal). */
  onSpeedUp?: (tx: Transaction) => void
}

const isZcashAddress = (addr: string) => {
  if (!addr) return false
  return addr.startsWith('t') || addr.startsWith('z') || addr.startsWith('u')
}

function MemoSection({ memo }: { memo: string }) {
  return (
    <div className="space-y-2 pt-1">
      <span className="text-sm text-muted">Memo</span>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-border/50 bg-card/30 px-3 py-2.5">
        <p className="whitespace-pre-wrap wrap-break-word font-mono text-xs leading-5 text-foreground/80 select-text">
          {memo}
        </p>
      </div>
    </div>
  )
}

const ZCASH_GENESIS_TS = 1477612800
const ZCASH_BLOCK_INTERVAL = 75

function wasmTxidToHex(txid: number[]): string {
  return Array.from(txid)
    .reverse()
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function useWasmTransaction(transactionId?: string) {
  const [wasmTx, setWasmTx] = useState<WasmTransactionEntry | null>(null)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)

  useEffect(() => {
    if (!transactionId?.startsWith('wasm_')) return
    const txidHex = transactionId.slice(5)
    chrome.runtime
      .sendMessage({ type: 'GET_TRANSACTION_HISTORY', walletId, accountId })
      .then((resp: WasmTransactionEntry[] | undefined) => {
        if (!Array.isArray(resp)) return
        const found = resp.find(e => wasmTxidToHex(e.txid) === txidHex)
        if (found) setWasmTx(found)
      })
      .catch(() => {})
  }, [transactionId, walletId, accountId])

  return wasmTx
}

export function TransactionDetailContent({
  transactionId,
  onClose,
  onSpeedUp
}: TransactionDetailContentProps) {
  const transactions = useAccountDataStore(state => state.getCurrentTransactions())
  const tx = transactions.find(t => t.id === transactionId)
  const wasmTx = useWasmTransaction(tx ? undefined : transactionId)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const network = useWalletStore(state => state.currentNetwork)
  const accountKey =
    walletId && accountId ? buildAccountKey(network, walletId, accountId) : undefined
  const intentsProgress = useIntentsProgress(accountKey).find(
    entry => entry.transactionId === transactionId || entry.depositAddress === tx?.depositAddress
  )

  if (!tx && !wasmTx) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted">
        <p>Transaction not found</p>
        <Button variant="ghost" className="mt-4" onClick={onClose}>
          Close
        </Button>
      </div>
    )
  }

  if (wasmTx && !tx) {
    const txidHex = wasmTxidToHex(wasmTx.txid)
    const isIncoming =
      wasmTx.kind === 'receive' || Number(wasmTx.transparent_received_zatoshis ?? 0) > 0
    const amountZatoshis = isIncoming
      ? wasmTx.transparent_received_zatoshis || wasmTx.amount_zatoshis
      : wasmTx.amount_zatoshis
    const zecAmount = formatAmount(amountZatoshis.toString(), ZEC_DECIMALS)
    let ts: number
    if (wasmTx.timestamp && Number(wasmTx.timestamp) > 0) {
      ts = Number(wasmTx.timestamp) * 1000
    } else if (wasmTx.mined_height) {
      ts = (ZCASH_GENESIS_TS + wasmTx.mined_height * ZCASH_BLOCK_INTERVAL) * 1000
    } else {
      ts = Date.now()
    }
    const dateStr = new Date(ts).toLocaleString()
    const chainTip = useAccountDataStore.getState().getCurrentSyncState().currentHeight
    const wasmType = isIncoming ? 'receive' : wasmTx.kind === 'shield' ? 'shield' : 'send'
    const receiveTrust =
      isIncoming && (wasmTx.kind === 'send' || wasmTx.kind === 'shield') ? 'trusted' : 'untrusted'
    const confirmationState = resolveMinedTransactionStatus(
      wasmTx.status,
      wasmTx.mined_height,
      chainTip,
      wasmType,
      receiveTrust
    )
    const statusCopy = getOnChainStatusCopy(
      confirmationState.status,
      wasmType,
      confirmationState.confirmations,
      confirmationState.requiredConfirmations
    )
    const explorerUrl = formatZcashTransactionExplorerUrl(txidHex)
    const kindLabel = isIncoming ? 'Receive' : wasmTx.kind === 'shield' ? 'Shield' : 'Send'

    return (
      <div>
        <div className="mb-4">
          <h2 className="text-xl font-semibold">{kindLabel}</h2>
        </div>
        <div className="flex flex-col items-center py-8">
          <div className="relative mb-4">
            <TokenIcon
              symbol="ZEC"
              size="xl"
              showBadge
              badgeType={isIncoming ? 'receive' : 'send'}
            />
          </div>
          <div className="max-w-full text-center text-3xl font-bold">
            <AmountDisplay value={zecAmount} prefix={isIncoming ? '+' : '-'} />
          </div>
        </div>
        <div className="space-y-4 mb-6">
          <DetailRow label="Date">{dateStr}</DetailRow>
          <DetailRow label="Status">
            <span className={getTransactionStatusToneClassName(statusCopy.tone)}>
              {statusCopy.label}
            </span>
          </DetailRow>
          {wasmTx.mined_height && (
            <DetailRow label="Block Height">{wasmTx.mined_height.toLocaleString()}</DetailRow>
          )}
          {explorerUrl && (
            <DetailRow label="Transaction Hash">
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline cursor-pointer break-all font-mono"
              >
                {formatSortAddress(txidHex)}
              </a>
            </DetailRow>
          )}
          {wasmTx.fee_zatoshis != null && wasmTx.fee_zatoshis > 0 && (
            <DetailRow label="Fee">
              <AmountDisplay
                value={formatAmount(wasmTx.fee_zatoshis.toString(), ZEC_DECIMALS)}
                symbol="ZEC"
                profile="fee"
              />
            </DetailRow>
          )}
          {wasmTx.memo && <MemoSection memo={wasmTx.memo} />}
        </div>
      </div>
    )
  }

  const localTx = tx!
  const intentsDepositAddress =
    localTx.quoteBinding?.provider === 'rhea-cross-chain-dex'
      ? undefined
      : localTx.depositAddress ||
        localTx.quoteBinding?.depositAddress ||
        intentsProgress?.depositAddress
  const toContact = useAddressBookStore(state =>
    state.getContact(getZcashChainId(DEFAULT_NETWORK), localTx.to)
  )
  const isIncoming =
    localTx.type === 'receive' || localTx.type === 'withdraw' || localTx.type === 'claim'
  const chainHashes = localTx.chainHashes ?? []
  const showMultiStepZcashLabels = isMultiStepZcashSend(localTx)
  const dateStr = new Date(localTx.timestamp).toLocaleString()
  const transactionStatusCopy = getTransactionStatusCopy(localTx)
  const visibleStatusCopy = intentsProgress
    ? getIntentsStatusCopy(intentsProgress.status)
    : transactionStatusCopy
  const intentsSteps = intentsProgress
    ? getLegacyIntentsProgressPresentation(localTx, intentsProgress)
    : null
  const explorerUrl = localTx.txHash ? formatZcashTransactionExplorerUrl(localTx.txHash) : ''
  const fromType = localTx.fromType
  const toType = detectAddressType(localTx.to)
  const missingFromSource = localTx.from
    ? null
    : getMissingZcashTransactionSource(localTx.type, fromType)
  const fromLabel = localTx.from
    ? formatSortAddress(localTx.from)
    : (missingFromSource?.label ?? '')
  const fromLabelType = localTx.from ? fromType : missingFromSource?.type
  const recipient = getZcashTransactionRecipient(localTx)

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-semibold">
          {localTx.type?.charAt(0).toUpperCase() + localTx.type?.slice(1) || ''}
        </h2>
      </div>

      <div className="flex flex-col items-center py-8">
        <div className="relative mb-4">
          <TokenIcon
            symbol="ZEC"
            nativeChain="zcash"
            size="xl"
            showBadge
            badgeType={isIncoming ? 'receive' : 'send'}
          />
        </div>
        <div className="max-w-full text-center text-3xl font-bold">
          <AmountDisplay value={localTx.amount} prefix={isIncoming ? '+' : '-'} />
        </div>
      </div>

      <div className="space-y-4 mb-6">
        <DetailRow label="Date">{dateStr}</DetailRow>
        <DetailRow label="Status">
          <span className={getTransactionStatusToneClassName(visibleStatusCopy.tone)}>
            {visibleStatusCopy.label}
          </span>
        </DetailRow>
        {intentsProgress && (
          <>
            <DetailRow label="Route">
              <span className="inline-flex max-w-full flex-wrap items-center justify-end gap-1">
                <AmountDisplay
                  value={intentsProgress.amountIn}
                  symbol={intentsProgress.tokenInSymbol}
                />
                <span>→</span>
                <AmountDisplay
                  value={intentsProgress.amountOut}
                  symbol={intentsProgress.tokenOutSymbol}
                />
              </span>
            </DetailRow>
            <DetailRow label="Updated">
              {new Date(intentsProgress.lastStatusChangeAt).toLocaleString()}
            </DetailRow>
          </>
        )}
        {intentsDepositAddress && (
          <DetailRow label="NEAR Intents">
            <a
              href={getIntentsExplorerUrl(intentsDepositAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              View transaction
            </a>
          </DetailRow>
        )}
        <DetailRow label="From">
          <div className="flex items-center gap-2">
            <span>{fromLabel}</span>
            {(localTx.from ? isZcashAddress(localTx.from) : !!missingFromSource) &&
              fromLabelType && <AddressTypeLabel type={fromLabelType} />}
          </div>
        </DetailRow>
        {recipient && (
          <DetailRow label="To">
            <div className="flex flex-col items-end gap-0.5">
              {toContact?.znsName && (
                <span className="text-xs text-primary">{toContact.znsName}</span>
              )}
              <div className="flex items-center gap-2">
                <span className={localTx.to ? '' : 'text-muted'}>{recipient.label}</span>
                {((localTx.to && isZcashAddress(localTx.to)) || recipient.type) && (
                  <AddressTypeLabel type={recipient.type ?? toType} />
                )}
              </div>
            </div>
          </DetailRow>
        )}
        {localTx.fee && safeBig(localTx.fee).gt(0) && (
          <DetailRow label="Fee">
            <AmountDisplay value={localTx.fee} symbol="ZEC" profile="fee" />
          </DetailRow>
        )}
        {chainHashes.length > 0
          ? chainHashes.map((chainHash, index) => {
              const chainExplorerUrl = formatExplorerUrl(
                chainHash.chain.toLowerCase(),
                chainHash.hash
              )
              const hashLabel = showMultiStepZcashLabels
                ? index === chainHashes.length - 1
                  ? 'Payment Hash'
                  : 'Funding Hash'
                : `${chainHash.chain} Hash`
              return (
                <DetailRow key={`${chainHash.hash}-${index}`} label={hashLabel}>
                  <div className="flex items-center gap-2">
                    {chainExplorerUrl ? (
                      <a
                        href={chainExplorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline cursor-pointer break-all font-mono"
                      >
                        {formatSortAddress(chainHash.hash)}
                      </a>
                    ) : (
                      <span className="text-sm font-mono">{formatSortAddress(chainHash.hash)}</span>
                    )}
                  </div>
                </DetailRow>
              )
            })
          : localTx.txHash &&
            !localTx.txHash.includes(',') && (
              <DetailRow label="Transaction Hash">
                <div className="flex items-center gap-2">
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline cursor-pointer break-all font-mono"
                  >
                    {formatSortAddress(localTx.txHash)}
                  </a>
                </div>
              </DetailRow>
            )}
        {localTx.replacedByTxHash && (
          <DetailRow label="Replacement Hash">
            <a
              href={formatZcashTransactionExplorerUrl(localTx.replacedByTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline cursor-pointer break-all font-mono"
            >
              {formatSortAddress(localTx.replacedByTxHash)}
            </a>
          </DetailRow>
        )}
        {localTx.memo && <MemoSection memo={localTx.memo} />}
      </div>

      {intentsSteps && <TransactionProgressSteps steps={intentsSteps.steps} className="mb-6" />}

      {getTransactionRecoveryAction(localTx) === 'speed_up' && onSpeedUp && (
        <Button
          className="w-full h-[45px]"
          onClick={() => {
            onClose?.()
            onSpeedUp(localTx)
          }}
        >
          Speed Up
        </Button>
      )}
    </div>
  )
}
