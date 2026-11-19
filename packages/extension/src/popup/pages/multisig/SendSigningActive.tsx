import { useMemo } from 'react'
import type { UR } from '@ngraveio/bc-ur'
import { QRScanner } from '@/popup/components/hardware/QRScanner'
import { EncoderAnimatedQR } from '@/popup/components/hardware/AnimatedQR'
import { createEnvelopesUREncoder } from '@/lib/multisig-ur'
import type { VaultSendProgress } from '@/core/multisig/send-rpc'
import type { MultisigEnvelope } from '@/core/multisig/messages'
import type { MultisigDevice } from '@/core/multisig/types'

export function SendSigningActive({
  progress,
  selectedPhones,
  outbound,
  isScanning,
  scanCount,
  onScan
}: {
  progress: VaultSendProgress | null
  selectedPhones: readonly MultisigDevice[]
  outbound: readonly MultisigEnvelope[]
  isScanning: boolean
  scanCount: number
  onScan: (ur: UR) => Promise<void>
}) {
  const qrEncoder = useMemo(
    () => (outbound.length ? createEnvelopesUREncoder(outbound) : null),
    [outbound]
  )
  return (
    <>
      <h2 className="text-lg font-semibold">
        {progress?.status?.phase === 'shares'
          ? 'Collecting signatures'
          : 'Waiting for phone approval'}
      </h2>
      <div className="space-y-2" role="list" aria-label="Signing progress">
        {selectedPhones.map(device => {
          const slot = device.slot - 1
          const isShared = progress?.status?.sharedSlots.includes(slot)
          const isCommitted = progress?.status?.committedSlots.includes(slot)
          return (
            <div key={device.slot} role="listitem" className="flex justify-between gap-3 text-sm">
              <span>{device.name}</span>
              <span className="text-muted">
                {isShared ? 'Signed' : isCommitted ? 'Approved' : 'Waiting'}
              </span>
            </div>
          )
        })}
      </div>
      {outbound.length > 0 && !isScanning && qrEncoder && (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="text-sm">Scan this code with the selected phone(s)</div>
          <div className="bg-white p-4">
            <EncoderAnimatedQR encoder={qrEncoder} size={240} />
          </div>
        </div>
      )}
      {isScanning && (
        <div className="space-y-3">
          <div className="text-sm">Scan a selected phone’s response</div>
          <QRScanner
            key={scanCount}
            onScan={ur => void onScan(ur).catch(() => {})}
            className="w-full max-w-[320px]"
          />
        </div>
      )}
    </>
  )
}
