import {
  ensureRpcEndpointPreferencesLoaded,
  getNextRpcEndpointOption,
  getPreferredRpcEndpointOption,
  getRpcEndpointOptions,
  setActiveRpcEndpointOverride
} from './rpc-endpoints'
import type { RpcEndpointId } from '@/config/rpc-endpoints'
import { probeRpcEndpoint } from './rpc-registry-client'
import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashChainId } from '@/core/chains/registry'

export const RPC_FAILOVER_STORAGE_KEY = 'rpc_failover_state'
export const RPC_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000
export const RPC_RECOVERY_PROBE_INTERVAL_MS = 30 * 1000
export const RPC_RECOVERY_SUCCESS_THRESHOLD = 2

const RPC_CHAIN = 'zcash' as const

export interface RpcFailoverState {
  preferredEndpointId: RpcEndpointId
  activeEndpointId: RpcEndpointId
  failedOverAt: number | null
  recoverAfter: number | null
  preferredProbeSuccesses: number
}

export interface RpcFailoverTransition {
  reason: 'failover' | 'recovery'
  fromEndpointId: RpcEndpointId
  toEndpointId: RpcEndpointId
}

interface RpcFailoverUpdate {
  state: RpcFailoverState
  transition?: RpcFailoverTransition
}

let loadPromise: Promise<RpcFailoverState> | null = null

export function createRpcFailoverState(preferredEndpointId: RpcEndpointId): RpcFailoverState {
  return {
    preferredEndpointId,
    activeEndpointId: preferredEndpointId,
    failedOverAt: null,
    recoverAfter: null,
    preferredProbeSuccesses: 0
  }
}

export function registerRpcFailure(
  current: RpcFailoverState,
  preferredEndpointId: RpcEndpointId,
  fallbackEndpointId: RpcEndpointId | undefined,
  now: number
): RpcFailoverUpdate {
  const state =
    current.preferredEndpointId === preferredEndpointId
      ? current
      : createRpcFailoverState(preferredEndpointId)

  if (!fallbackEndpointId || fallbackEndpointId === state.activeEndpointId) {
    return { state }
  }

  return {
    state: {
      ...state,
      activeEndpointId: fallbackEndpointId,
      failedOverAt: state.failedOverAt ?? now,
      recoverAfter: now + RPC_RECOVERY_COOLDOWN_MS,
      preferredProbeSuccesses: 0
    },
    transition: {
      reason: 'failover',
      fromEndpointId: state.activeEndpointId,
      toEndpointId: fallbackEndpointId
    }
  }
}

export function registerRpcSuccess(
  current: RpcFailoverState,
  preferredEndpointId: RpcEndpointId
): RpcFailoverState {
  if (current.preferredEndpointId !== preferredEndpointId) {
    return createRpcFailoverState(preferredEndpointId)
  }
  return current
}

export function registerPreferredRpcProbe(
  current: RpcFailoverState,
  preferredEndpointId: RpcEndpointId,
  succeeded: boolean,
  now: number
): RpcFailoverUpdate {
  if (current.preferredEndpointId !== preferredEndpointId) {
    return { state: createRpcFailoverState(preferredEndpointId) }
  }
  if (current.activeEndpointId === preferredEndpointId) {
    return { state: registerRpcSuccess(current, preferredEndpointId) }
  }

  if (!succeeded) {
    return {
      state: {
        ...current,
        preferredProbeSuccesses: 0,
        recoverAfter: now + RPC_RECOVERY_COOLDOWN_MS
      }
    }
  }

  const preferredProbeSuccesses = current.preferredProbeSuccesses + 1
  if (preferredProbeSuccesses < RPC_RECOVERY_SUCCESS_THRESHOLD) {
    return {
      state: {
        ...current,
        preferredProbeSuccesses,
        recoverAfter: now + RPC_RECOVERY_PROBE_INTERVAL_MS
      }
    }
  }

  return {
    state: createRpcFailoverState(preferredEndpointId),
    transition: {
      reason: 'recovery',
      fromEndpointId: current.activeEndpointId,
      toEndpointId: preferredEndpointId
    }
  }
}

function isValidState(value: unknown): value is RpcFailoverState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<RpcFailoverState>
  const endpointIds = new Set(getRpcEndpointOptions(RPC_CHAIN).map(option => option.id))
  return (
    endpointIds.has(state.preferredEndpointId as RpcEndpointId) &&
    endpointIds.has(state.activeEndpointId as RpcEndpointId) &&
    (state.failedOverAt === null || Number.isFinite(state.failedOverAt)) &&
    (state.recoverAfter === null || Number.isFinite(state.recoverAfter)) &&
    Number.isSafeInteger(state.preferredProbeSuccesses) &&
    (state.preferredProbeSuccesses as number) >= 0
  )
}

function applyRuntimeState(state: RpcFailoverState): void {
  loadPromise = Promise.resolve(state)
  setActiveRpcEndpointOverride(
    RPC_CHAIN,
    state.activeEndpointId === state.preferredEndpointId ? undefined : state.activeEndpointId
  )
}

function hasSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.session
}

async function persistState(state: RpcFailoverState): Promise<void> {
  if (!hasSessionStorage()) return
  const isDefault =
    state.activeEndpointId === state.preferredEndpointId && state.preferredProbeSuccesses === 0
  try {
    if (isDefault) {
      await chrome.storage.session.remove(RPC_FAILOVER_STORAGE_KEY)
    } else {
      await chrome.storage.session.set({ [RPC_FAILOVER_STORAGE_KEY]: state })
    }
  } catch {
    /* keep the in-memory override for the current extension context */
  }
}

async function readState(): Promise<RpcFailoverState> {
  const preferredEndpointId = getPreferredRpcEndpointOption(RPC_CHAIN).id
  if (!hasSessionStorage()) {
    const state = createRpcFailoverState(preferredEndpointId)
    applyRuntimeState(state)
    return state
  }

  const stored = await chrome.storage.session.get(RPC_FAILOVER_STORAGE_KEY)
  const value = stored[RPC_FAILOVER_STORAGE_KEY]
  const state =
    isValidState(value) && value.preferredEndpointId === preferredEndpointId
      ? value
      : createRpcFailoverState(preferredEndpointId)
  applyRuntimeState(state)
  if (state !== value && value !== undefined) {
    await chrome.storage.session.remove(RPC_FAILOVER_STORAGE_KEY)
  }
  return state
}

export function ensureRpcFailoverStateLoaded(): Promise<RpcFailoverState> {
  if (!loadPromise) {
    loadPromise = ensureRpcEndpointPreferencesLoaded()
      .catch(() => undefined)
      .then(() => readState())
      .catch(() => {
        const state = createRpcFailoverState(getPreferredRpcEndpointOption(RPC_CHAIN).id)
        applyRuntimeState(state)
        return state
      })
  }
  return loadPromise
}

export async function resetRpcFailoverState(): Promise<void> {
  const state = createRpcFailoverState(getPreferredRpcEndpointOption(RPC_CHAIN).id)
  applyRuntimeState(state)
  if (hasSessionStorage()) {
    await chrome.storage.session.remove(RPC_FAILOVER_STORAGE_KEY).catch(() => {})
  }
}

export async function recordRpcFailure(): Promise<RpcFailoverTransition | null> {
  if (
    findChainEndpointOverride(getActiveChainEndpointSettings(), getZcashChainId(DEFAULT_NETWORK))
      ?.rpc
  ) {
    return null
  }
  const current = await ensureRpcFailoverStateLoaded()
  const preferredEndpointId = getPreferredRpcEndpointOption(RPC_CHAIN).id
  const fallbackEndpointId = getNextRpcEndpointOption(
    RPC_CHAIN,
    preferredEndpointId,
    current.activeEndpointId
  )?.id
  const update = registerRpcFailure(current, preferredEndpointId, fallbackEndpointId, Date.now())
  applyRuntimeState(update.state)
  await persistState(update.state)
  return update.transition || null
}

async function probeEndpoint(endpoint: ReturnType<typeof getPreferredRpcEndpointOption>) {
  try {
    await probeRpcEndpoint(endpoint)
    return true
  } catch {
    return false
  }
}

export async function recordRpcSuccess(): Promise<RpcFailoverTransition | null> {
  if (
    findChainEndpointOverride(getActiveChainEndpointSettings(), getZcashChainId(DEFAULT_NETWORK))
      ?.rpc
  ) {
    return null
  }
  let current = await ensureRpcFailoverStateLoaded()
  const preferred = getPreferredRpcEndpointOption(RPC_CHAIN)
  const afterSuccess = registerRpcSuccess(current, preferred.id)

  if (afterSuccess !== current) {
    current = afterSuccess
    applyRuntimeState(current)
    await persistState(current)
  }

  if (current.activeEndpointId === preferred.id) {
    return null
  }

  const now = Date.now()
  if (current.recoverAfter !== null && now < current.recoverAfter) {
    return null
  }

  const update = registerPreferredRpcProbe(
    current,
    preferred.id,
    await probeEndpoint(preferred),
    now
  )
  applyRuntimeState(update.state)
  await persistState(update.state)
  return update.transition || null
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') return
    const change = changes[RPC_FAILOVER_STORAGE_KEY]
    if (!change) return

    const preferredEndpointId = getPreferredRpcEndpointOption(RPC_CHAIN).id
    const nextState =
      isValidState(change.newValue) && change.newValue.preferredEndpointId === preferredEndpointId
        ? change.newValue
        : createRpcFailoverState(preferredEndpointId)
    applyRuntimeState(nextState)
  })
}
