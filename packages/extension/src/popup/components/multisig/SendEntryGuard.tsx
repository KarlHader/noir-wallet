import { useState } from 'react'
import type { ReactNode } from 'react'
import { isFrostAccount } from '@/core/accounts/domain'
import { isMultisigUiEnabled } from '@/core/multisig/multisig-runtime-policy'
import { openMultisigSendTab } from '@/lib/multisig-tab'
import { useWalletStore } from '@/store/wallet-store'
import { toast } from '@/store/toast-store'
import { InlineError } from '@/popup/components/common/InlineError'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { FlowButton } from './FlowButton'

/** Do not mount single-sign forms or their transaction hooks for independent vault accounts. */
export function SendEntryGuard({ children }: { children: ReactNode }) {
  const account = useWalletStore(state => state.getCurrentAccount())
  const walletId = useWalletStore(state => state.currentWalletId)
  const network = useWalletStore(state => state.currentNetwork)
  const [isOpening, setIsOpening] = useState(false)
  if (!account || !isFrostAccount(account)) return children
  const canOpen = Boolean(isMultisigUiEnabled() && walletId && account.source.network === network)
  const openSend = async () => {
    if (!canOpen || !walletId || isOpening) return
    setIsOpening(true)
    try {
      await openMultisigSendTab({ network, walletId, accountId: account.id })
    } catch {
      toast.error('Unable to open multisig send', 'Please try again.')
    } finally {
      setIsOpening(false)
    }
  }
  return (
    <div className="page-container">
      <PageHeader title="Send" showBack />
      <div className="page-content">
        <InlineError
          tone="warning"
          message={
            canOpen
              ? 'This account requires multisig approval.'
              : 'Multisig sending is unavailable for this account and network.'
          }
        />
      </div>
      {canOpen && (
        <div className="page-footer">
          <FlowButton onClick={() => void openSend()} disabled={isOpening} aria-busy={isOpening}>
            {isOpening ? 'Opening…' : 'Open multisig send'}
          </FlowButton>
        </div>
      )}
    </div>
  )
}
