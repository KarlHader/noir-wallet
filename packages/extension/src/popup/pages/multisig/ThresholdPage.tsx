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

const THRESHOLDS: readonly MultisigThreshold[] = ['2-of-2', '2-of-3', '3-of-3']
const DEFAULT_THRESHOLD: MultisigThreshold = '2-of-3'
const FALLBACK_OWNER_NAME = 'Account'
const ACCOUNT_ERRORS = {
  missing: 'Missing account.',
  unsupported: 'This account type does not support multisig.',
  inactive: 'Switch to this wallet to set up multisig.'
} as const

type AccountCheck = 'ok' | keyof typeof ACCOUNT_ERRORS

/** Step 1: choose how many devices must approve each transaction. */
export function ThresholdPage() {
  const { search } = useLocation()
  const { navigate, replace } = useNavigate()
  const start = useCreateSessionStore(state => state.start)
  const network = useWalletStore(state => state.currentNetwork)
  const [threshold, setThreshold] = useState<MultisigThreshold>(DEFAULT_THRESHOLD)
  // Read before the reset below clears it: a page that comes back here without the query still
  // knows which account the setup was for.
  const [storedScope] = useState(() => useCreateSessionStore.getState().scope)

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
    if (isZcashHardwareKeySource(wallet.keySource) || wallet.keySource === 'private-key') {
      return 'unsupported'
    }
    // Background binds only the active wallet's credential, so the share could not be sealed.
    if (state.currentWalletId !== walletId) return 'inactive'
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

  const handleContinue = () => {
    if (!scope || teamRoute) return
    start(scope, threshold, 'ble', ownerName)
    navigate('/multisig/create/connect')
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
          <FlowButton disabled={!scope || teamRoute !== null} onClick={handleContinue}>
            Continue
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
