import { useState } from 'react'
import { openShieldHardwareTab } from '@/popup/services/shield-hardware-tab'
import { TransactionNotice } from './TransactionNotice'

export function ShieldHardwareTabNotice({ path }: Readonly<{ path: string }>) {
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)
  const open = async () => {
    setOpening(true)
    setFailed(false)
    try {
      await openShieldHardwareTab(path)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  return (
    <TransactionNotice
      className="mx-4 mt-6"
      tone={failed ? 'warning' : 'muted'}
      message={failed ? 'Could not open the wallet tab.' : 'Continue with your hardware wallet.'}
      retryLabel="Open wallet tab"
      retrying={opening}
      onRetry={() => void open()}
    />
  )
}
