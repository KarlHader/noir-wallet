import { useEffect } from 'react'
import { Button } from '../ui/button'
import { BackupWordInputs } from '../seed-phrase/BackupWordInputs'
import { useWalletBackupVerification } from '@/popup/hooks/useWalletBackupVerification'
import type { WalletBackupVerification } from '@/core/wallet/secret-phrase-backup'

export function RemoveWalletContent({
  walletId,
  onRemove,
  onCancel,
  onViewBackup
}: {
  walletId: string
  onRemove: (verification: WalletBackupVerification) => Promise<void>
  onCancel: () => void
  onViewBackup: () => void
}) {
  const verification = useWalletBackupVerification(walletId)
  const { prepare, isSubmitting } = verification

  useEffect(() => {
    void prepare()
  }, [prepare])

  return (
    <form
      autoComplete="off"
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault()
        void verification.submit(onRemove)
      }}
    >
      <p className="text-sm text-muted">
        Enter two words from your saved secret phrase to remove this wallet.{' '}
        <button type="button" className="text-primary underline" onClick={onViewBackup}>
          View secret phrase
        </button>
      </p>
      <BackupWordInputs verification={verification} />
      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={!verification.canSubmit}
          isLoading={isSubmitting}
          className="flex-1"
        >
          Remove
        </Button>
      </div>
    </form>
  )
}
