import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { UR } from '@ngraveio/bc-ur'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { InlineError } from '@/popup/components/common/InlineError'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { createQrSigningTransport } from '@/popup/multisig/signing-transport'
import { createBleSigningTransport } from '@/popup/multisig/ble-signing-transport'
import { defaultLoadIdentity, loadSharedIdentity } from '@/popup/multisig/device-identity-cache'
import {
  authorityFromReview,
  cancelMultisigSend,
  closeMultisigSend,
  getMultisigSendRoster,
  ingestMultisigSend,
  startMultisigSend
} from '@/popup/services/multisig-send-client'
import type { VaultSendProgress, VaultSendReview } from '@/core/multisig/send-rpc'
import type { MultisigGroupRecord } from '@/core/multisig/types'
import type { MultisigEnvelope } from '@/core/multisig/messages'
import type { VaultSendTransaction } from '@/core/multisig/send-rpc'
import { SendTransactionResult } from './SendTransactionResult'
import { useMultisigSendSubmission } from './useMultisigSendSubmission'
import { SendSigningActive } from './SendSigningActive'

interface SendSigningProps {
  review: VaultSendReview
  group: MultisigGroupRecord
  onClose: () => void
  onSessionClosed: () => void
  onSigned: () => void
}

type SigningView =
  | 'starting'
  | 'connecting'
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'signed'

export function SendSigning({
  review,
  group,
  onClose,
  onSessionClosed,
  onSigned
}: SendSigningProps) {
  const authority = useMemo(() => authorityFromReview(review), [review])
  const [view, setView] = useState<SigningView>('starting')
  const [progress, setProgress] = useState<VaultSendProgress | null>(null)
  const [outbound, setOutbound] = useState<MultisigEnvelope[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [scanCount, setScanCount] = useState(0)
  const [connectedSlots, setConnectedSlots] = useState<number[]>([])
  const [connectingSlot, setConnectingSlot] = useState<number | null>(null)
  const [sasChallenge, setSasChallenge] = useState<{
    slot: number
    code: string
    resolve: (accepted: boolean) => void
  } | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const isDisposed = useRef(false)
  const isTerminal = useRef(false)
  const hasSigned = useRef(false)
  const transport = useRef<ReturnType<typeof createQrSigningTransport> | null>(null)
  const bleTransport = useRef<ReturnType<typeof createBleSigningTransport> | null>(null)
  const sasResolver = useRef<((accepted: boolean) => void) | null>(null)
  const hasStarted = useRef(false)
  const effectGeneration = useRef(0)
  const notifyPhones = useCallback(
    async (transaction: VaultSendTransaction) => {
      if (group.transportKind !== 'ble' || !transaction.outbound.length) return
      if (!bleTransport.current) throw new Error('Bluetooth signing connection ended')
      await bleTransport.current.send(transaction.outbound)
    },
    [group.transportKind]
  )
  const submission = useMultisigSendSubmission(review, authority, notifyPhones)

  useEffect(() => {
    if (view !== 'signed' || submission.view !== 'signed') return
    const warnAboutUnsentSignature = (event: BeforeUnloadEvent) => {
      if (submission.hasSendStarted()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnAboutUnsentSignature)
    return () => window.removeEventListener('beforeunload', warnAboutUnsentSignature)
  }, [submission.hasSendStarted, submission.view, view])

  const stop = useCallback(
    async (nextView: 'stopped' | 'failed', message?: string) => {
      if (isTerminal.current) return
      isTerminal.current = true
      transport.current?.dispose()
      transport.current = null
      bleTransport.current?.dispose()
      bleTransport.current = null
      sasResolver.current?.(false)
      sasResolver.current = null
      if (!isDisposed.current) setView('stopping')
      try {
        await cancelMultisigSend(authority)
        onSessionClosed()
        if (!isDisposed.current) {
          setView(nextView)
          setFeedback(message ?? null)
        }
      } catch {
        if (!isDisposed.current) {
          setView('failed')
          setFeedback(
            'The signing session could not be closed. Check this account before trying again.'
          )
        }
      }
    },
    [authority, onSessionClosed]
  )

  const applyProgress = useCallback(
    (next: VaultSendProgress) => {
      if (isDisposed.current || isTerminal.current) return
      const binding = next.binding
      if (
        binding.reviewId !== review.binding.reviewId ||
        binding.sessionId !== review.binding.sessionId ||
        binding.walletId !== review.binding.walletId ||
        binding.accountId !== review.binding.accountId ||
        binding.network !== review.binding.network ||
        binding.groupId !== review.binding.groupId ||
        binding.pcztDigest !== review.binding.pcztDigest ||
        JSON.stringify(binding.selectedSlots) !== JSON.stringify(review.binding.selectedSlots)
      ) {
        void stop('failed', 'The signing session changed. Check this account before trying again.')
        return
      }
      setProgress(next)
      if (next.phase === 'signed' && next.status?.phase === 'signed') {
        hasSigned.current = true
        isTerminal.current = true
        transport.current?.dispose()
        transport.current = null
        setOutbound([])
        setView('signed')
        onSigned()
        return
      }
      if (next.phase !== 'signing' || !next.status || next.status.phase === 'aborted') {
        void stop('failed', 'Signing ended. Check this account before starting another transfer.')
        return
      }
      if (next.outbound.length) {
        if (group.transportKind === 'qr') {
          transport.current?.setOutbound(next.outbound)
          setOutbound(transport.current?.getOutbound() ?? [])
          setIsScanning(false)
        } else {
          void bleTransport.current
            ?.send(next.outbound)
            .catch(() =>
              stop(
                'failed',
                'The Bluetooth signing connection ended. Check this account before trying again.'
              )
            )
        }
      }
      setView('active')
    },
    [group.transportKind, onSigned, review.binding, stop]
  )

  const handleEnvelope = useCallback(
    async (envelope: MultisigEnvelope) => {
      if (isDisposed.current || isTerminal.current) return
      try {
        const next = await ingestMultisigSend(authority, envelope)
        if (isDisposed.current || isTerminal.current) return
        applyProgress(next)
        setScanCount(count => count + 1)
      } catch {
        await stop(
          'failed',
          'The phone response was rejected. Check this account before trying again.'
        )
        throw new Error('Phone response rejected')
      }
    },
    [applyProgress, authority, stop]
  )

  useEffect(() => {
    const generation = ++effectGeneration.current
    let isEffectActive = true
    isDisposed.current = false
    isTerminal.current = false
    hasSigned.current = false
    if (group.transportKind === 'qr') {
      transport.current = createQrSigningTransport({
        binding: review.binding,
        onEnvelope: handleEnvelope
      })
      void startMultisigSend(authority)
        .then(next => {
          if (isEffectActive) applyProgress(next)
        })
        .catch(() => {
          if (isEffectActive)
            return stop(
              'failed',
              'Unable to start signing. Check this account before trying again.'
            )
        })
    } else {
      void Promise.all([getMultisigSendRoster(authority), loadSharedIdentity(defaultLoadIdentity)])
        .then(([roster, identity]) => {
          if (!isEffectActive || isDisposed.current || isTerminal.current) return
          bleTransport.current = createBleSigningTransport({
            binding: review.binding,
            roster,
            identity,
            onSas: (slot, code) =>
              new Promise(resolve => {
                if (isDisposed.current || isTerminal.current) {
                  resolve(false)
                  return
                }
                sasResolver.current = resolve
                setSasChallenge({ slot, code, resolve })
              }),
            onEnvelope: handleEnvelope,
            onDisconnected: () => {
              void stop(
                'failed',
                'The Bluetooth signing connection ended. Check this account before trying again.'
              )
            }
          })
          setView('connecting')
        })
        .catch(() => {
          if (isEffectActive)
            return stop(
              'failed',
              'Unable to verify signing devices. Check this account before trying again.'
            )
        })
    }
    const timer = window.setTimeout(
      () => void stop('stopped', 'This signing session expired.'),
      Math.max(0, review.binding.expiresAt - Date.now())
    )
    return () => {
      isEffectActive = false
      isDisposed.current = true
      window.clearTimeout(timer)
      transport.current?.dispose()
      transport.current = null
      bleTransport.current?.dispose()
      bleTransport.current = null
      sasResolver.current?.(false)
      sasResolver.current = null
      queueMicrotask(() => {
        if (effectGeneration.current !== generation) return
        if (hasSigned.current) void closeMultisigSend(authority).catch(() => {})
        else if (!isTerminal.current) void cancelMultisigSend(authority).catch(() => {})
      })
    }
  }, [applyProgress, authority, group.transportKind, handleEnvelope, review.binding, stop])

  const connectPhone = (slot: number) => {
    if (view !== 'connecting' || connectingSlot !== null || !bleTransport.current) return
    setConnectingSlot(slot)
    setFeedback(null)
    // Web Bluetooth requires its chooser to begin in this click gesture.
    void bleTransport.current
      .connect(slot)
      .then(() => {
        if (isDisposed.current || isTerminal.current) return
        const connected = bleTransport.current?.connectedSlots() ?? []
        setConnectedSlots(connected)
        if (
          !hasStarted.current &&
          review.binding.selectedSlots.every(
            selected => selected === 0 || connected.includes(selected)
          )
        ) {
          hasStarted.current = true
          setView('starting')
          void startMultisigSend(authority)
            .then(applyProgress)
            .catch(() =>
              stop('failed', 'Unable to start signing. Check this account before trying again.')
            )
        }
      })
      .catch(() => {
        if (!isDisposed.current && !isTerminal.current) {
          setFeedback(
            'Unable to connect and verify this phone. Try its Bluetooth connection again.'
          )
        }
      })
      .finally(() => {
        if (!isDisposed.current) setConnectingSlot(null)
      })
  }

  const scanQr = async (ur: UR) => {
    if (view !== 'active' || isTerminal.current || !transport.current) return
    const outcome = await transport.current.ingestQr(ur)
    if (isTerminal.current || isDisposed.current) return
    if (outcome !== 'accepted' && !isDisposed.current) {
      setFeedback(
        outcome === 'duplicate'
          ? 'This phone response was already scanned.'
          : 'Unrecognized phone response.'
      )
      setScanCount(count => count + 1)
    } else if (!isDisposed.current) {
      setFeedback(null)
    }
  }

  const selectedPhones = group.devices.filter(device =>
    review.binding.selectedSlots.includes(device.slot - 1)
  )
  const isActive = view === 'active'

  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Multisig signing" showBack={false} />
      <div className="page-content space-y-5 pb-4">
        {view === 'starting' || view === 'stopping' ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted">
            <Icon icon="lucide:loader-2" className="animate-spin motion-reduce:animate-none" />
            {view === 'starting' ? 'Starting signing…' : 'Closing signing session…'}
          </div>
        ) : view === 'signed' ? (
          submission.transaction ? (
            <SendTransactionResult
              transaction={submission.transaction}
              notice={submission.notice}
            />
          ) : submission.view === 'recovery' ? (
            <InlineError
              message={
                submission.notice ??
                'The signed transaction needs recovery. Do not start another payment.'
              }
            />
          ) : (
            <div role="status" className="space-y-2">
              <h2 className="text-lg font-semibold">Signatures collected</h2>
              <div className="text-sm text-muted">
                The transaction has not been saved or submitted. Send it now; closing this tab
                requires manual recovery before another payment.
              </div>
            </div>
          )
        ) : view === 'stopped' || view === 'failed' ? (
          <h2 role="status" className="text-lg font-semibold">
            Signing session ended
          </h2>
        ) : view === 'connecting' ? (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Connect signing phones</h2>
            {selectedPhones
              .filter(device => device.slot !== 1)
              .map(device => {
                const slot = device.slot - 1
                return (
                  <FlowButton
                    key={slot}
                    variant="outline"
                    disabled={connectedSlots.includes(slot) || connectingSlot !== null}
                    onClick={() => connectPhone(slot)}
                  >
                    <Icon icon="lucide:bluetooth" aria-hidden="true" />
                    {connectedSlots.includes(slot)
                      ? `${device.name} connected`
                      : `Connect ${device.name}`}
                  </FlowButton>
                )
              })}
            {sasChallenge && (
              <div role="dialog" aria-label="Verify phone pairing code" className="space-y-3">
                <div className="text-sm">Compare this code with the selected phone</div>
                <div className="font-mono text-lg tabular-nums">{sasChallenge.code}</div>
                <FlowButton
                  onClick={() => {
                    sasChallenge.resolve(true)
                    sasResolver.current = null
                    setSasChallenge(null)
                  }}
                >
                  Codes match
                </FlowButton>
                <FlowButton
                  variant="outline"
                  onClick={() => {
                    sasChallenge.resolve(false)
                    sasResolver.current = null
                    setSasChallenge(null)
                  }}
                >
                  Codes differ
                </FlowButton>
              </div>
            )}
          </div>
        ) : (
          <SendSigningActive
            progress={progress}
            selectedPhones={selectedPhones}
            outbound={outbound}
            isScanning={isScanning}
            scanCount={scanCount}
            onScan={scanQr}
          />
        )}
      </div>
      <div className="page-footer space-y-3">
        {feedback && <InlineError message={feedback} />}
        {isActive && group.transportKind === 'qr' && (
          <FlowButton variant="outline" onClick={() => setIsScanning(value => !value)}>
            <Icon icon={isScanning ? 'lucide:qr-code' : 'lucide:scan'} aria-hidden="true" />
            {isScanning ? 'Show code' : 'Scan phone response'}
          </FlowButton>
        )}
        {isActive && (
          <FlowButton
            variant="outline"
            onClick={() =>
              void stop(
                'stopped',
                'Signing ended. Check this account before starting another transfer.'
              )
            }
          >
            End signing session
          </FlowButton>
        )}
        {view === 'connecting' && (
          <FlowButton
            variant="outline"
            onClick={() => void stop('stopped', 'Signing session ended.')}
          >
            End signing session
          </FlowButton>
        )}
        {view === 'signed' && submission.view === 'signed' && (
          <FlowButton onClick={() => void submission.sendTransfer()}>Send transfer</FlowButton>
        )}
        {view === 'signed' && ['executing', 'notifying', 'checking'].includes(submission.view) && (
          <FlowButton disabled aria-busy="true">
            <Icon icon="lucide:loader-2" className="animate-spin motion-reduce:animate-none" />
            {submission.view === 'executing'
              ? 'Saving and sending transaction…'
              : submission.view === 'notifying'
                ? 'Notifying phones…'
                : 'Checking status…'}
          </FlowButton>
        )}
        {view === 'signed' && (submission.view === 'result' || submission.view === 'recovery') && (
          <FlowButton variant="outline" onClick={() => void submission.checkStatus(true)}>
            Check status
          </FlowButton>
        )}
        {(view === 'stopped' ||
          view === 'failed' ||
          (view === 'signed' && ['result', 'recovery'].includes(submission.view))) && (
          <FlowButton onClick={onClose}>Close</FlowButton>
        )}
      </div>
    </div>
  )
}
