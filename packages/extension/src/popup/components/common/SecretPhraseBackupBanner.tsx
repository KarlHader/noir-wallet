import { Icon } from '@iconify/react'
import { getWalletsNeedingSecretPhraseBackup } from '@/core/wallet/secret-phrase-backup'
import { formatWalletName } from '@/lib/format'
import { useWalletStore } from '@/store/wallet-store'
import { useNavigate } from '../../provider/Router'

export function SecretPhraseBackupBanner() {
  const wallets = useWalletStore(state => state.wallets)
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const { navigate } = useNavigate()
  const wallet = getWalletsNeedingSecretPhraseBackup(wallets).find(
    candidate => candidate.id === currentWalletId
  )
  if (!wallet) return null

  return (
    <aside
      aria-label="Secret phrase backup reminder"
      className="flex shrink-0 items-center gap-3 border-b border-warning/25 bg-warning-surface px-3 py-2"
    >
      <Icon icon="lucide:triangle-alert" width={18} height={18} className="shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="break-words text-xs leading-4 text-warning">
          Back up the secret phrase for {formatWalletName(wallet, wallets)}.
        </p>
      </div>
      <button
        type="button"
        className="shrink-0 rounded bg-warning px-2 py-1.5 text-xs font-medium text-warning-foreground"
        onClick={() =>
          navigate(`/view-seed-phrase?walletId=${encodeURIComponent(wallet.id)}&backup=1`, {
            state: { fromBackupBanner: true }
          })
        }
      >
        Back up
      </button>
    </aside>
  )
}
