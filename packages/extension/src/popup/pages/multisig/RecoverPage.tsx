import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { UR } from '@ngraveio/bc-ur'
import { isMultisigUiEnabled } from '@/core/multisig/multisig-runtime-policy'
import { isFrostAccount } from '@/core/accounts/domain'
import { base64ToBytes } from '@/lib/bytes'
import { createBytesUREncoder, decodeBytesUR } from '@/lib/multisig-ur'
import { EncoderAnimatedQR } from '@/popup/components/hardware/AnimatedQR'
import { QRScanner } from '@/popup/components/hardware/QRScanner'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { InlineError } from '@/popup/components/common/InlineError'
import { useMultisigGroup, useMultisigGroupStore } from '@/popup/multisig/group-store'
import { useLocation } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import {
  cancelPhoneRecovery,
  completePhoneRecovery,
  parsePhoneRecoveryLocation,
  preparePhoneRecovery,
  sendPhoneRecoveryOverBluetooth
} from '@/popup/services/multisig-recovery-client'
import type { PhoneRecoveryReply } from '@/popup/services/multisig-recovery-client'
import { MultisigTabLayout } from './MultisigTabLayout'

const FAILURE =
  'Phone recovery could not finish. Keep the wallet unlocked, check this account, and try again. Any unfinished transfer must be resolved first.'

type RecoveryView = 'scan' | 'working' | 'compare' | 'reply' | 'done'

export function RecoverPage() {
  const { search } = useLocation()
  const location = useMemo(() => parsePhoneRecoveryLocation(search), [search])
  const wallet = useWalletStore()
  const group = useMultisigGroup(location?.scope ?? null)
  const isGroupLoaded = useMultisigGroupStore(state => state.loaded)
  const account = wallet.getCurrentAccount()
  const isAvailable = Boolean(
    isMultisigUiEnabled() &&
    location &&
    account &&
    isFrostAccount(account) &&
    wallet.currentNetwork === location.scope.network &&
    wallet.currentWalletId === location.scope.walletId &&
    wallet.currentAccountId === location.scope.accountId &&
    account.source.network === location.scope.network &&
    group?.threshold === '2-of-2' &&
    !group.mock
  )
  return (
    <MultisigTabLayout
      step={null}
      title="Restore phone"
      showBack={false}
      footer={
        <FlowButton variant="outline" onClick={() => window.close()}>
          Close
        </FlowButton>
      }
    >
      {!isGroupLoaded ? (
        <div role="status" className="text-sm text-muted">
          Loading multisig account…
        </div>
      ) : isAvailable && location ? (
        <PhoneRecovery key={`${search}:${isAvailable}`} location={location} />
      ) : (
        <InlineError message="Open phone recovery from the active 2-of-2 multisig account. This account or network is unavailable." />
      )}
    </MultisigTabLayout>
  )
}

function PhoneRecovery({
  location
}: {
  location: NonNullable<ReturnType<typeof parsePhoneRecoveryLocation>>
}) {
  const { scope, transport } = location
  const [view, setView] = useState<RecoveryView>('scan')
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState<PhoneRecoveryReply | null>(null)
  const [code, setCode] = useState('')
  const [isCodeVisible, setIsCodeVisible] = useState(true)
  const [scanAttempt, setScanAttempt] = useState(0)
  const controller = useRef(new AbortController())
  const pending = useRef<PhoneRecoveryReply | null>(null)
  const isBusy = useRef(false)
  const decision = useRef<((matches: boolean) => void) | null>(null)
  useEffect(() => {
    const lifetime = new AbortController()
    controller.current = lifetime
    return () => {
      lifetime.abort()
      decision.current?.(false)
      if (pending.current) void cancelPhoneRecovery(scope, pending.current.recoveryId)
    }
  }, [scope])
  useEffect(() => {
    if (!reply || !isCodeVisible) return
    const timer = window.setTimeout(
      () => setIsCodeVisible(false),
      Math.min(180_000, Math.max(0, reply.expiresAt - Date.now()))
    )
    return () => window.clearTimeout(timer)
  }, [reply, isCodeVisible])
  const encoder = useMemo(
    () => (reply && isCodeVisible ? createBytesUREncoder(base64ToBytes(reply.reply)) : null),
    [reply, isCodeVisible]
  )
  const onPrepared = (value: PhoneRecoveryReply) => {
    pending.current = value
  }
  const fail = async (signal: AbortSignal) => {
    if (pending.current) await cancelPhoneRecovery(scope, pending.current.recoveryId)
    pending.current = null
    if (!signal.aborted) {
      setReply(null)
      setError(FAILURE)
      setView('scan')
      setScanAttempt(value => value + 1)
    }
  }
  const start = async (request?: Uint8Array) => {
    if (isBusy.current || pending.current || controller.current.signal.aborted) return
    const signal = controller.current.signal
    isBusy.current = true
    setError(null)
    setView('working')
    try {
      const prepared = request
        ? await preparePhoneRecovery(scope, request, signal)
        : await sendPhoneRecoveryOverBluetooth(
            scope,
            signal,
            sas =>
              new Promise<boolean>(resolve => {
                decision.current = resolve
                setCode(sas)
                setView('compare')
              }),
            onPrepared
          )
      if (signal.aborted) return
      if (!prepared) {
        setView('scan')
        return
      }
      onPrepared(prepared)
      setReply(prepared)
      setIsCodeVisible(true)
      setView('reply')
    } catch {
      await fail(signal)
    } finally {
      decision.current?.(false)
      decision.current = null
      isBusy.current = false
    }
  }
  const scan = (ur: UR) => {
    const bytes = decodeBytesUR(ur)
    if (!bytes) {
      setError('This is not a phone recovery request.')
      setScanAttempt(value => value + 1)
      return
    }
    void start(bytes)
  }
  const confirmCode = (matches: boolean) => {
    const resolve = decision.current
    decision.current = null
    setView('working')
    resolve?.(matches)
  }
  const complete = async () => {
    if (!reply || isBusy.current) return
    const signal = controller.current.signal
    isBusy.current = true
    setError(null)
    setView('working')
    try {
      await completePhoneRecovery(scope, reply.recoveryId, signal)
      pending.current = null
      if (!signal.aborted) {
        setReply(null)
        setView('done')
      }
    } catch {
      await fail(signal)
    } finally {
      isBusy.current = false
    }
  }
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="text-[22px] font-semibold">
        {transport === 'qr' ? 'Restore with QR codes' : 'Restore over Bluetooth'}
      </div>
      {view !== 'done' && (
        <div className="text-sm text-muted">
          On your phone, choose Import wallet, enter your 32 backup words, and select{' '}
          {transport === 'qr' ? 'QR code' : 'Bluetooth'}.
        </div>
      )}
      {error && <InlineError message={error} />}
      {view === 'scan' &&
        (transport === 'qr' ? (
          <>
            <div className="text-sm">Scan the recovery request displayed on your phone.</div>
            <QRScanner key={scanAttempt} onScan={scan} className="w-full max-w-[320px]" />
          </>
        ) : (
          <FlowButton onClick={() => void start()}>Choose phone</FlowButton>
        ))}
      {view === 'working' && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted">
          <Icon icon="lucide:loader-2" className="animate-spin" />
          Processing phone recovery…
        </div>
      )}
      {view === 'compare' && (
        <>
          <div className="text-sm">Check that your phone shows the same code.</div>
          <div className="font-mono text-4xl tracking-widest tabular-nums">{code}</div>
          <FlowButton onClick={() => confirmCode(true)}>The codes match</FlowButton>
          <FlowButton variant="outline" onClick={() => confirmCode(false)}>
            They don&apos;t match
          </FlowButton>
        </>
      )}
      {view === 'reply' && reply && (
        <>
          {transport === 'qr' &&
            (encoder ? (
              <>
                <div className="text-sm">Scan this reply with your phone.</div>
                <div className="rounded-2xl bg-white p-4">
                  <EncoderAnimatedQR encoder={encoder} size={240} />
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-3 text-sm text-muted">
                <span>The reply code is hidden.</span>
                <FlowButton
                  variant="outline"
                  onClick={() => {
                    if (Date.now() < reply.expiresAt) setIsCodeVisible(true)
                    else void fail(controller.current.signal)
                  }}
                >
                  Show code again
                </FlowButton>
              </div>
            ))}
          <div className="text-sm">
            Wait until your phone confirms recovery and shows this wallet. Then confirm below to
            register it for signing.
          </div>
          <FlowButton onClick={() => void complete()}>My phone restored successfully</FlowButton>
          <div className="text-xs text-muted">
            Confirming replaces the previous phone&apos;s signing identity for this account.
          </div>
        </>
      )}
      {view === 'done' && (
        <div role="status" className="text-sm text-primary">
          Phone registered. You can now use it to sign with this wallet.
        </div>
      )}
    </div>
  )
}
