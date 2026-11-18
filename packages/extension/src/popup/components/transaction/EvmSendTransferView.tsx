import { Icon } from '@iconify/react'
import { ChainIcon } from '@/popup/components/common/ChainIcon'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainSelector } from '@/popup/components/common/ChainSelector'
import { formatTokenQuantity } from '@/lib/number-format'
import {
  SendAmountInputCard,
  SendFormView,
  SendFormActions,
  SendFieldLabel,
  SendAssetHeader,
  SendRecipientInputCard
} from '@/popup/components/transaction/SendInputCards'
import type { EvmSendTransferState } from '@/popup/hooks/useEvmSendTransfer'
import { EvmSendReviewView } from './EvmSendReviewView'
import { EvmSendRoutePanels } from './EvmSendRoutePanels'

export function EvmSendTransferView({ state }: { readonly state: EvmSendTransferState }) {
  const {
    destinationNetworks,
    priceUsd,
    sourceMode,
    amount,
    recipient,
    preparing,
    approving,
    updatingFee,
    networkPickerOpen,
    setNetworkPickerOpen,
    asset,
    chain,
    networkMode,
    shieldSourceAvailable,
    domainAvailableRaw,
    availableRaw,
    tokenFeeBalanceError,
    sourceAddress,
    destinationNetworkOptions,
    sendPrivately,
    route,
    canMoveRecipient,
    validRecipient,
    recipientPolicyError,
    maximum,
    maxSelected,
    maxHighlighted,
    transferAvailability,
    maximumPending,
    privatePreviewReady,
    privatePreviewKey,
    privatePreviewLoading,
    feePreview,
    validAmount,
    handleSelectRecipient,
    handleMoveRecipient,
    handleContinue,
    setInputAmount,
    setInputRecipient,
    selectMaximum,
    selectShield,
    selectAsset,
    openDestinationNetworks,
    selectDestinationNetwork,
    togglePrivacyRoute,
    support
  } = state
  return (
    <>
      <SendFormView
        domain="public"
        disabled={preparing || approving || updatingFee}
        availableDomains={shieldSourceAvailable ? ['public', 'shield'] : ['public']}
        onDomainChange={selectShield}
        amountInput={
          <SendAmountInputCard
            ariaLabel={`${asset.metadata.symbol} amount`}
            value={amount}
            onChange={setInputAmount}
            available={transferAvailability.display}
            symbol={asset.metadata.symbol}
            priceUsd={priceUsd}
            inline
          />
        }
        assetSelector={
          <SendAssetHeader
            assetId={asset.asset.id}
            symbol={asset.metadata.symbol}
            icon={asset.metadata.iconUrl}
            networkName={chain.chain.displayName}
            blockchain={resolveChainIconAlias(
              chain.chain.family,
              chain.chain.displayName,
              chain.chain.id
            )}
            onSelectAsset={selectAsset}
            variant="pill"
          />
        }
        balance={
          <span
            data-testid="send-available-balance"
            className="min-w-0 truncate"
            title={transferAvailability.display}
          >
            {domainAvailableRaw === null ? '—' : formatTokenQuantity(transferAvailability.display)}
          </span>
        }
        maxButton={
          <button
            type="button"
            aria-label="Max"
            aria-pressed={maxHighlighted}
            disabled={
              route === 'pending' ||
              !sourceAddress ||
              BigInt(availableRaw) <= 0n ||
              (asset.asset.kind === 'native' && !validRecipient) ||
              maximum.loading
            }
            onClick={selectMaximum}
            className="rounded-md bg-white/10 px-2 py-1 font-medium text-muted aria-pressed:bg-primary/15 aria-pressed:text-primary disabled:opacity-40"
          >
            Max
          </button>
        }
        recipient={
          <div>
            <div className="mb-2 flex items-center justify-between text-xs">
              <SendFieldLabel>Send to</SendFieldLabel>
              {!sendPrivately && (destinationNetworks.length > 1 || networkPickerOpen) ? (
                <>
                  <button
                    type="button"
                    onClick={openDestinationNetworks}
                    className="inline-flex items-center gap-1.5 text-foreground hover:text-primary"
                    aria-label={`Select destination network, ${chain.chain.displayName}`}
                  >
                    <ChainIcon
                      chain={resolveChainIconAlias(
                        chain.chain.family,
                        chain.chain.displayName,
                        chain.chain.id
                      )}
                      width={16}
                      height={16}
                      className="rounded-[4px]"
                      showTooltip={false}
                    />
                    {chain.chain.displayName}
                    <Icon icon="lucide:chevron-down" width={13} height={13} />
                  </button>
                  <ChainSelector
                    open={networkPickerOpen}
                    onOpenChange={setNetworkPickerOpen}
                    selectedId={chain.chain.id}
                    enabledFirst
                    label={`Networks for ${asset.metadata.symbol}`}
                    options={destinationNetworkOptions}
                    onSelect={selectDestinationNetwork}
                  />
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <ChainIcon
                    chain={resolveChainIconAlias(
                      chain.chain.family,
                      chain.chain.displayName,
                      chain.chain.id
                    )}
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                    showTooltip={false}
                  />
                  {chain.chain.displayName}
                </span>
              )}
            </div>
            <SendRecipientInputCard
              id="evm-send-recipient"
              value={recipient}
              onChange={setInputRecipient}
              placeholder="Enter address"
              variant="filled"
              hideLabel
              onSelectRecipient={() => void handleSelectRecipient()}
            />
            {recipient && !validRecipient && (
              <div className="mt-2 flex items-start justify-between gap-3 px-1 text-xs text-danger">
                <p className="min-w-0 flex-1">
                  {recipientPolicyError ?? 'Enter a valid non-zero EVM address.'}
                </p>
                {canMoveRecipient && recipientPolicyError && (
                  <button
                    type="button"
                    onClick={() => void handleMoveRecipient()}
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-primary"
                  >
                    <Icon
                      icon="lucide:arrow-right-left"
                      width={13}
                      height={13}
                      aria-hidden="true"
                    />
                    Move
                  </button>
                )}
              </div>
            )}
          </div>
        }
        footer={
          <SendFormActions
            privacy={
              sourceMode === 'main' &&
              networkMode === 'mainnet' &&
              support.support !== 'unsupported'
                ? {
                    checked: sendPrivately,
                    onChange: togglePrivacyRoute
                  }
                : undefined
            }
            disabled={
              !validAmount ||
              !validRecipient ||
              maximumPending ||
              !sourceAddress ||
              route === 'pending' ||
              (sendPrivately && !privatePreviewReady) ||
              tokenFeeBalanceError !== null ||
              (route === 'onchain' && feePreview.loading)
            }
            loading={
              preparing ||
              (maxSelected && maximum.loading) ||
              (route === 'onchain' && feePreview.loading) ||
              (privatePreviewKey !== null && privatePreviewLoading)
            }
            onContinue={handleContinue}
          />
        }
      >
        <EvmSendRoutePanels state={state} />
      </SendFormView>

      <EvmSendReviewView state={state} />
    </>
  )
}
