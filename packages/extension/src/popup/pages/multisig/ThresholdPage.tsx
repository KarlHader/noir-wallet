import { useEffect, useState } from 'react'
import { FlowButton } from '@/popup/components/multisig/FlowButton'
import { InlineError } from '@/popup/components/common/InlineError'
import { Pill } from '@/popup/components/multisig/Pill'
import { ThresholdOptionCard } from '@/popup/components/multisig/ThresholdOptionCard'
import { useCreateSessionStore } from '@/popup/multisig/create-session-store'
import { useMultisigGroup, useMultisigGroupStore } from '@/popup/multisig/group-store'
import { useLocation, useNavigate } from '@/popup/provider/Router'
import { useWalletStore } from '@/store/wallet-store'
import type { MultisigThreshold } from '@/core/multisig/types'
import { isZcashHardwareKeySource } from '@/core/wallet/hardware-wallet-data'
import { getAccountDisplayName } from '@/lib/format'
import type { MultisigGroupScope } from '@/lib/multisig-group-storage'
import { multisigTeamRoute } from '@/lib/multisig-tab'
import { MultisigTabLayout } from './MultisigTabLayout'
import { requestVaultGroup } from '@/core/worker/client'
import type { MultisigCreationOperation } from '@/lib/multisig-creation-storage'

const THRESHOLDS: readonly MultisigThreshold[] = ['2-of-2', '2-of-3', '3-of-3']
const DEFAULT_THRESHOLD: MultisigThreshold = '2-of-3'
const FALLBACK_OWNER_NAME = 'Account'
const ACCOUNT_ERRORS = {
  missing: 'Missing account.',
  unsupported: 'This account type does not support multisig.',
  inactive: 'Switch to this account to set up multisig.'
} as const

type AccountCheck = 'ok' | keyof typeof ACCOUNT_ERRORS

/** Step 1: choose how many devices must approve each transaction. */
export function ThresholdPage() {
  const { search } = useLocation()
  const { navigate, replace } = useNavigate()
  const start = useCreateSessionStore(state => state.start)
  const network = useWalletStore(state => state.currentNetwork)
  const [threshold, setThreshold] = useState<MultisigThreshold>(DEFAULT_THRESHOLD)
  const [reserving, setReserving] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [pending, setPending] = useState<MultisigCreationOperation[]>([])
  const [checkingPending, setCheckingPending] = useState(true)
  const [pendingChecked, setPendingChecked] = useState(false)
  const [pendingRefresh, setPendingRefresh] = useState(0)
  // Read before the reset below clears it: a page that comes back here without the query still
  // knows which account the setup was for.
  const [storedScope] = useState(() => {
    const { scope, reservation } = useCreateSessionStore.getState()
    return scope && reservation ? { ...scope, accountId: reservation.parentAccountId } : scope
  })

  const params = new URLSearchParams(search)
  const queryWalletId = params.get('walletId')
  const queryAccountId = params.get('accountId')
  const target =
    queryWalletId && queryAccountId
      ? { walletId: queryWalletId, accountId: queryAccountId }
      : storedScope
  const walletId = target?.walletId ?? null
  const accountId = target?.accountId ?? null

  // Multisig starts from a recovery phrase, so an account that is not in the wallet list, or that
  // belongs to a hardware or private-key wallet, cannot start a setup.
  const accountCheck = useWalletStore((state): AccountCheck => {
    if (!walletId || !accountId) return 'missing'
    const wallet = state.wallets.find(candidate => candidate.id === walletId)
    if (!wallet?.accounts.some(candidate => candidate.id === accountId)) return 'missing'
    if (wallet.accounts.find(candidate => candidate.id === accountId)?.source) return 'unsupported'
    if (isZcashHardwareKeySource(wallet.keySource) || wallet.keySource === 'private-key') {
      return 'unsupported'
    }
    // Background binds only the active wallet's credential, so the share could not be sealed.
    if (state.currentWalletId !== walletId || state.currentAccountId !== accountId)
      return 'inactive'
    return 'ok'
  })

  // The selector returns a string, so the page re-renders only when the name itself changes.
  const ownerName = useWalletStore(state => {
    if (!walletId || !accountId) return FALLBACK_OWNER_NAME
    const account = state.wallets
      .find(wallet => wallet.id === walletId)
      ?.accounts.find(candidate => candidate.id === accountId)
    if (!account) return FALLBACK_OWNER_NAME
    return getAccountDisplayName(walletId, accountId, account.name, state.accountDisplayNames)
  })

  // Reaching this page means the user is starting over, so an earlier session, including one
  // that already aborted, must not leak into the new setup.
  useEffect(() => {
    useCreateSessionStore.getState().reset()
  }, [])

  const scope: MultisigGroupScope | null =
    walletId && accountId && accountCheck === 'ok' ? { network, walletId, accountId } : null
  useEffect(() => {
    let disposed = false
    setCheckingPending(true)
    setPendingChecked(false)
    if (!walletId || !accountId || accountCheck !== 'ok') {
      setCheckingPending(false)
      return
    }
    void requestVaultGroup('vault.group.pending', { scope: { network, walletId, accountId } }).then(
      operations => {
        if (!disposed) {
          setPending(operations)
          setCheckingPending(false)
          setPendingChecked(true)
          setCreationError(null)
        }
      },
      () => {
        if (!disposed) {
          setCreationError('Unlock this wallet to check unfinished setup.')
          setCheckingPending(false)
        }
      }
    )
    return () => {
      disposed = true
    }
  }, [walletId, accountId, network, accountCheck, pendingRefresh])
  // Looking a group up needs no credential, so an account of a wallet that is not active still
  // finds its existing group; only starting a new setup is limited to the active wallet.
  const lookupScope: MultisigGroupScope | null =
    walletId && accountId && (accountCheck === 'ok' || accountCheck === 'inactive')
      ? { network, walletId, accountId }
      : null

  // An account has at most one group, so one that already exists opens its team page instead of
  // a second setup.
  const existingGroup = useMultisigGroup(lookupScope)
  const groupsLoaded = useMultisigGroupStore(state => state.loaded)
  const teamRoute =
    groupsLoaded && existingGroup && walletId && accountId
      ? multisigTeamRoute({ walletId, accountId })
      : null
  useEffect(() => {
    if (teamRoute) replace(teamRoute)
  }, [teamRoute, replace])

  const handleContinue = async () => {
    if (!scope || teamRoute || pending.length > 0) return
    setReserving(true)
    setCreationError(null)
    try {
      const reservation = await requestVaultGroup('vault.group.reserve', { scope, threshold })
      start(reservation.scope, threshold, 'ble', ownerName, reservation)
      navigate('/multisig/create/connect')
    } catch {
      setCreationError('Could not start account setup. Unlock this wallet and try again.')
    } finally {
      setReserving(false)
    }
  }

  return (
    <MultisigTabLayout
      step={1}
      title="Multisig"
      onBack={() => window.close()}
      footer={
        <>
          {accountCheck !== 'ok' && (
            <InlineError message={ACCOUNT_ERRORS[accountCheck]} className="mb-3" />
          )}
          {creationError && <InlineError message={creationError} className="mb-3" />}
          {!pendingChecked && !checkingPending && scope && (
            <FlowButton onClick={() => setPendingRefresh(value => value + 1)}>
              Check unfinished setup
            </FlowButton>
          )}
          {pending.map(operation => (
            <div key={operation.operationId} className="mb-3 space-y-2">
              <InlineError
                message={
                  operation.group
                    ? 'An earlier setup needs to finish saving its account.'
                    : operation.phase === 'reserved'
                      ? 'An earlier device setup is still open.'
                      : 'An earlier setup did not finish device verification. Its saved share is retained. Keep this wallet and your paired devices.'
                }
              />
              {operation.group ? (
                <FlowButton
                  onClick={async () => {
                    try {
                      const status = await requestVaultGroup('vault.group.status', {
                        scope: operation.scope,
                        operationId: operation.operationId
                      })
                      if (status.phase === 'ready') navigate(multisigTeamRoute(operation.scope))
                    } catch {
                      setCreationError(
                        'Could not finish account setup. Unlock this wallet and retry.'
                      )
                    }
                  }}
                >
                  Finish account setup
                </FlowButton>
              ) : operation.phase === 'reserved' ? (
                <FlowButton
                  onClick={async () => {
                    try {
                      await requestVaultGroup('vault.group.cancel', {
                        scope: operation.scope,
                        operationId: operation.operationId
                      })
                      setPending(current =>
                        current.filter(op => op.operationId !== operation.operationId)
                      )
                    } catch {
                      setCreationError('This setup has saved material and must be retained.')
                    }
                  }}
                >
                  Cancel unfinished setup
                </FlowButton>
              ) : null}
            </div>
          ))}
          <FlowButton
            disabled={
              !scope ||
              teamRoute !== null ||
              reserving ||
              checkingPending ||
              !pendingChecked ||
              pending.length > 0
            }
            onClick={handleContinue}
          >
            {reserving ? 'Preparing…' : 'Continue'}
          </FlowButton>
        </>
      }
    >
      <h2 className="text-[26px] font-medium leading-[1.35]">
        <span className="block">Multiple devices.</span>
        <span className="block">One secure authorization.</span>
      </h2>
      <p className="mt-2 text-sm text-[#BCBCC8]">
        Pick how many devices must approve each transaction.
      </p>
      <div className="mt-7">
        <Pill tone="account">{ownerName}</Pill>
      </div>
      <div role="radiogroup" aria-label="Security mode" className="mt-3 space-y-3">
        {THRESHOLDS.map(option => (
          <ThresholdOptionCard
            key={option}
            threshold={option}
            selected={threshold === option}
            onSelect={() => setThreshold(option)}
          />
        ))}
      </div>
    </MultisigTabLayout>
  )
}
