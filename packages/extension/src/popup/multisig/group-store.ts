import { useEffect } from 'react'
import { create } from 'zustand'
import { isMultisigUiEnabled } from '@/core/multisig/multisig-runtime-policy'
import type { MultisigGroupRecord } from '@/core/multisig/types'
import { DedupPromise } from '@/lib/async-utils'
import {
  clearMultisigData,
  multisigGroupScopeKey,
  readAllMultisigGroups,
  type MultisigGroupScope
} from '@/lib/multisig-group-storage'
import { forgetSharedIdentity } from './device-identity-cache'

export interface MultisigGroupStore {
  /** Keyed by multisigGroupScopeKey. */
  groups: Readonly<Record<string, MultisigGroupRecord>>
  loaded: boolean
  load(): Promise<void>
  getGroup(scope: MultisigGroupScope): MultisigGroupRecord | null
  /** Called by the create-session store once a group activates; it writes storage itself. */
  setGroup(scope: MultisigGroupScope, record: MultisigGroupRecord): void
  clear(): Promise<void>
}

function groupFor(
  groups: Readonly<Record<string, MultisigGroupRecord>>,
  scope: MultisigGroupScope
): MultisigGroupRecord | null {
  const key = multisigGroupScopeKey(scope)
  return Object.prototype.hasOwnProperty.call(groups, key) ? groups[key] : null
}

const loadOnce = new DedupPromise<void>()
// Bumped by clear(), so a load that read storage before the clear cannot bring the groups back.
let clearCount = 0

export const useMultisigGroupStore = create<MultisigGroupStore>()((set, get) => ({
  groups: {},
  loaded: false,

  load: () =>
    loadOnce.run(async () => {
      const startedAt = clearCount
      const stored = await readAllMultisigGroups()
      if (startedAt !== clearCount) return
      // Anything already in memory came from setGroup after this page activated a group. Its
      // storage write may not have landed when this read ran, so memory wins over the read.
      set(state => ({ groups: { ...stored, ...state.groups }, loaded: true }))
    }),

  getGroup: scope => groupFor(get().groups, scope),

  setGroup: (scope, record) => {
    set(state => ({ groups: { ...state.groups, [multisigGroupScopeKey(scope)]: record } }))
  },

  clear: async () => {
    clearCount += 1
    await clearMultisigData()
    // The device identity was deleted with the rest, so a cached copy must not be reused.
    forgetSharedIdentity()
    set({ groups: {}, loaded: true })
  }
}))

/** Refresh on account changes so groups created in another extension page become visible. */
export function useMultisigGroup(scope: MultisigGroupScope | null): MultisigGroupRecord | null {
  // A flag-off build must not touch multisig storage at all; the hooks still run unconditionally
  // so the hook order stays stable, and the flag is decided inside them.
  const enabled = isMultisigUiEnabled()
  const scopeKey = scope ? multisigGroupScopeKey(scope) : null
  const record = useMultisigGroupStore(state =>
    enabled && scope ? groupFor(state.groups, scope) : null
  )
  useEffect(() => {
    if (!enabled) return
    useMultisigGroupStore
      .getState()
      .load()
      .catch(error => console.error('Failed to load multisig groups', error))
  }, [enabled, scopeKey])
  return record
}
