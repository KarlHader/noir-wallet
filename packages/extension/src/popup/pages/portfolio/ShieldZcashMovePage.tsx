import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getZcashChainId } from '@/core/chains/registry'
import { useWalletStore } from '@/store/wallet-store'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'
import { useHomePortfolio } from '@/popup/hooks/useHomePortfolio'
import { getPrivateTransferChainIds } from '@/popup/services/private-balance-transfer'
import { getConfidentialZcashMoveRecipients } from '@/popup/services/zcash-self-move'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { ShieldWithdrawForm } from './ShieldWithdrawPage'

export function ShieldZcashMovePage() {
  const network = useWalletStore(state => state.currentNetwork)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  return <ShieldZcashMoveContent key={`${network}:${walletId}:${accountId}`} />
}

function ShieldZcashMoveContent() {
  const [params] = useSearchParams()
  const network = useWalletStore(state => state.currentNetwork)
  const walletId = useWalletStore(state => state.currentWalletId)
  const accountId = useWalletStore(state => state.currentAccountId)
  const { activeAccount, loading } = useActiveAccountNetworks()
  const { model, refresh, readLatest } = useHomePortfolio(walletId, accountId)
  const [state, setState] = useState({ reviewing: false, busy: false })
  const chainId = getZcashChainId(network)
  const assetId = `${chainId}/slip44:133`
  const accountMatches = Boolean(
    walletId &&
    accountId &&
    params.get('sourceWalletId') === walletId &&
    params.get('sourceAccountId') === accountId &&
    activeAccount?.walletId === walletId &&
    activeAccount.accountId === accountId
  )
  const available =
    accountMatches &&
    params.get('assetId') === assetId &&
    getPrivateTransferChainIds(activeAccount, network === 'mainnet').length > 0 &&
    getConfidentialZcashMoveRecipients(activeAccount, network).length > 0

  return (
    <div className="page-container">
      {!state.reviewing && <PageHeader title="Move" showBack backDisabled={state.busy} />}
      {available ? (
        <ShieldWithdrawForm
          active
          moveToOwnZcash
          entry={{ assetId, networkId: chainId, recipient: '', provider: 'near-confidential' }}
          onStateChange={setState}
          model={model}
          initialAsset={model?.assets.find(item => item.asset.id === assetId) ?? null}
          refresh={refresh}
          readProjection={readLatest}
          onSelectPublic={() => {}}
          onOpenSourcePicker={() => {}}
        />
      ) : (
        <p role="status" className="px-4 py-6 text-center text-sm text-muted">
          {loading
            ? 'Loading account…'
            : accountMatches
              ? 'No Zcash receive address available'
              : 'Account changed. Reopen Move.'}
        </p>
      )}
    </div>
  )
}
