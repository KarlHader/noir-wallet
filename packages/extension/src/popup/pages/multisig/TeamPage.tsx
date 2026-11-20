import { useEffect, useRef, useState } from 'react'
import { readCreationOperation } from '@/lib/multisig-creation-storage'
import { requestVaultGroup } from '@/core/worker/client'
import { InlineError } from '@/popup/components/common/InlineError'
import { Icon } from '@iconify/react'
import type { MultisigThreshold } from '@/core/multisig/types'
import { DeviceCard } from '@/popup/components/multisig/DeviceCard'
import { Pill } from '@/popup/components/multisig/Pill'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { useMultisigGroup, useMultisigGroupStore } from '@/popup/multisig/group-store'
import { useLocation, useNavigate } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import { toast } from '@/store/toast-store'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { isMultisigTabRoute } from '@/lib/multisig-tab'
import { MultisigTabLayout } from './MultisigTabLayout'

const PAGE_TITLE = 'Multisig team'

const THRESHOLD_LABEL: Record<MultisigThreshold, string> = {
  '2-of-2': '2 of 2',
  '2-of-3': '2 of 3',
  '3-of-3': '3 of 3'
}

const THRESHOLD_COPY: Record<MultisigThreshold, string> = {
  '2-of-2': 'Noir wallet and your device must both sign.',
  '2-of-3': 'Noir wallet and any one of 2 devices are required for a transaction.',
  '3-of-3': 'All three devices sign every time.'
}

/** Shows the toast once per page, including under StrictMode's doubled effects. */
function useCreatedToast(created: boolean) {
  const shown = useRef(false)
  useEffect(() => {
    if (!created || shown.current) return
    shown.current = true
    toast.success('Multisig ready')
  }, [created])
}

/** The activated group of one account: `/multisig/team?walletId&accountId[&created=1]`. */
export function TeamPage() {
  const { search } = useLocation()
  const { navigate } = useNavigate()
  const network = useWalletStore(state => state.currentNetwork)
  const loaded = useMultisigGroupStore(state => state.loaded)

  const params = new URLSearchParams(search)
  const walletId = params.get('walletId') || null
  const accountId = params.get('accountId') || null
  const scope: MultisigGroupScope | null =
    walletId && accountId ? { network, walletId, accountId } : null
  const group = useMultisigGroup(scope)
  const [ready, setReady] = useState(false)
  const [readyCheck, setReadyCheck] = useState(0)
  useEffect(() => {
    let disposed = false
    setReady(false)
    if (!walletId || !accountId || !group || group.mock) return
    const scope = { network, walletId, accountId }
    void readCreationOperation(scope)
      .then(async operation => {
        if (!operation) return
        const reply = await requestVaultGroup('vault.group.status', {
          scope,
          operationId: operation.operationId
        })
        if (!disposed) setReady(reply.phase === 'ready')
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [network, walletId, accountId, group, readyCheck])
  useCreatedToast(params.get('created') === '1' && ready)

  // This page runs in the multisig tab, which has no wallet page behind it to go back to.
  const handleDone = () => {
    if (isMultisigTabRoute(window.location.hash)) window.close()
    else navigate('/')
  }

  if (!group) {
    // A group the create flow has just saved is in memory before storage has loaded, so the
    // spinner is only for a page opened on its own.
    if (!loaded) {
      return (
        <MultisigTabLayout step={null} title={PAGE_TITLE} showBack={false}>
          <div
            role="status"
            aria-label="Loading"
            className="flex min-h-full items-center justify-center"
          >
            <Icon
              icon="lucide:loader-2"
              width={32}
              height={32}
              className="animate-spin text-primary motion-reduce:animate-none"
            />
          </div>
        </MultisigTabLayout>
      )
    }
    return (
      <MultisigTabLayout
        step={null}
        title={PAGE_TITLE}
        showBack={false}
        footer={
          <FlowButton variant="outline" onClick={() => window.close()}>
            Close
          </FlowButton>
        }
      >
        <div className="flex min-h-full items-center justify-center text-center">
          <p className="text-sm text-muted">No multisig group for this account.</p>
        </div>
      </MultisigTabLayout>
    )
  }

  const ownerName = group.devices.find(device => device.role === 'owner')?.name
  if (group.mock)
    return (
      <MultisigTabLayout
        step={null}
        title="Older multisig setup"
        showBack={false}
        footer={<FlowButton onClick={handleDone}>Close</FlowButton>}
      >
        <InlineError message="This older setup is a display record. It has not been verified as an independent multisig account. Its original data is retained." />
      </MultisigTabLayout>
    )
  if (!group.mock && !ready)
    return (
      <MultisigTabLayout
        step={null}
        title="Finish account setup"
        showBack={false}
        footer={
          <FlowButton onClick={() => setReadyCheck(value => value + 1)}>
            Retry setup check
          </FlowButton>
        }
      >
        <InlineError message="Account setup has not been confirmed ready. Unlock this wallet and retry to finish." />
      </MultisigTabLayout>
    )

  return (
    <MultisigTabLayout
      step={null}
      title={PAGE_TITLE}
      showBack={false}
      footer={<FlowButton onClick={handleDone}>Done</FlowButton>}
    >
      <div className="flex flex-col items-center text-center">
        {ownerName && <Pill tone="account">{ownerName}</Pill>}
        <p className="mt-3 text-[28px] leading-tight font-semibold">
          {THRESHOLD_LABEL[group.threshold]}
        </p>
        <p className="mt-2 text-sm text-muted">{THRESHOLD_COPY[group.threshold]}</p>
      </div>

      <div className="mt-5 space-y-3">
        {group.devices.map(device => (
          <DeviceCard
            key={device.slot}
            slot={device.slot}
            role={device.role}
            title={`${device.name} · ${device.model}`}
            // The team page lists members, not connections. An empty fragment, unlike null,
            // keeps the card from falling back to its status label.
            status="connected"
            trailing={<></>}
          />
        ))}
      </div>
    </MultisigTabLayout>
  )
}
