import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import type { useWalletBackupVerification } from '@/popup/hooks/useWalletBackupVerification'

export function BackupWordInputs({
  verification
}: {
  verification: ReturnType<typeof useWalletBackupVerification>
}) {
  if (verification.isPreparing)
    return (
      <div role="status" aria-label="Preparing backup check" className="space-y-4">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-[46px] w-full rounded-lg" />
          </div>
        ))}
      </div>
    )
  if (!verification.wordIndices) {
    return verification.error ? (
      <p role="alert" className="text-sm text-danger">
        {verification.error}
      </p>
    ) : null
  }
  return (
    <div className="space-y-4">
      {verification.wordIndices.map((wordIndex, position) => (
        <label key={wordIndex} className="block text-sm text-muted">
          Word {wordIndex + 1}
          <Input
            value={verification.words[position]}
            onChange={event => verification.setWord(position, event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-[46px]"
          />
        </label>
      ))}
      {verification.error && (
        <p role="alert" className="text-sm text-danger">
          {verification.error}
        </p>
      )}
    </div>
  )
}
