import type { Network } from '@/types'

export const DAPP_EXECUTION_MODES = Object.freeze(['main', 'private'] as const)

export type DAppExecutionMode = (typeof DAPP_EXECUTION_MODES)[number]

export interface DAppExecutionModeScope {
  readonly network: Network
  readonly keyDomainId: string
  readonly accountId: string
}

export interface DAppExecutionModeState {
  readonly mode: DAppExecutionMode
  readonly privateAvailable: boolean
  readonly privateSetupCompleted: boolean
}

export interface DAppExecutionModeChangeImpact {
  readonly pendingApprovalCount: number
}

export interface PersistedDAppExecutionModes {
  readonly schemaVersion: 1
  readonly privateScopes: readonly DAppExecutionModeScope[]
  readonly privateSetupScopes: readonly DAppExecutionModeScope[]
}

export interface DAppExecutionModeRepository {
  readonly read: () => Promise<unknown>
  readonly write: (value: PersistedDAppExecutionModes) => Promise<void>
  readonly clear: () => Promise<void>
}

export interface PrivateExecutionCapability {
  readonly isAvailable: (scope: DAppExecutionModeScope) => Promise<boolean>
}

const MAX_PRIVATE_SCOPES = 512
const MAX_SCOPE_ID_LENGTH = 256
const EMPTY_PERSISTED_MODES: PersistedDAppExecutionModes = Object.freeze({
  schemaVersion: 1,
  privateScopes: Object.freeze([]),
  privateSetupScopes: Object.freeze([])
})

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isScopeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_ID_LENGTH &&
    value.trim() === value
  )
}

function parseScope(value: unknown): DAppExecutionModeScope {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    (value.network !== 'mainnet' && value.network !== 'testnet') ||
    !isScopeId(value.keyDomainId) ||
    !isScopeId(value.accountId)
  ) {
    throw new Error('Invalid dApp execution mode scope')
  }
  return Object.freeze({
    network: value.network,
    keyDomainId: value.keyDomainId,
    accountId: value.accountId
  })
}

function scopeKey(scope: DAppExecutionModeScope): string {
  return JSON.stringify([scope.network, scope.keyDomainId, scope.accountId])
}

export function parseDAppExecutionModeScope(value: unknown): DAppExecutionModeScope {
  return parseScope(value)
}

export function decodePersistedDAppExecutionModes(value: unknown): PersistedDAppExecutionModes {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.privateScopes) ||
    value.privateScopes.length > MAX_PRIVATE_SCOPES ||
    !Array.isArray(value.privateSetupScopes) ||
    value.privateSetupScopes.length > MAX_PRIVATE_SCOPES
  ) {
    return EMPTY_PERSISTED_MODES
  }

  try {
    const privateScopes = value.privateScopes.map(parseScope)
    const privateSetupScopes = value.privateSetupScopes.map(parseScope)
    const privateKeys = privateScopes.map(scopeKey)
    const setupKeys = privateSetupScopes.map(scopeKey)
    if (
      new Set(privateKeys).size !== privateKeys.length ||
      new Set(setupKeys).size !== setupKeys.length ||
      privateKeys.some(key => !setupKeys.includes(key))
    ) {
      return EMPTY_PERSISTED_MODES
    }
    return Object.freeze({
      schemaVersion: 1,
      privateScopes: Object.freeze(privateScopes),
      privateSetupScopes: Object.freeze(privateSetupScopes)
    })
  } catch {
    return EMPTY_PERSISTED_MODES
  }
}

export class PrivateExecutionUnavailableError extends Error {
  constructor() {
    super('Confidential address is unavailable in this wallet build')
    this.name = 'PrivateExecutionUnavailableError'
  }
}

export class PrivateExecutionSetupRequiredError extends Error {
  constructor() {
    super('Confirm Confidential address setup before enabling Confidential mode')
    this.name = 'PrivateExecutionSetupRequiredError'
  }
}

export class DAppExecutionModeConfirmationRequiredError extends Error {
  readonly code = 'affected-operations-confirmation-required' as const

  constructor(readonly impact: DAppExecutionModeChangeImpact) {
    super(
      `${impact.pendingApprovalCount} pending dApp ${impact.pendingApprovalCount === 1 ? 'operation requires' : 'operations require'} confirmation before changing account mode`
    )
    this.name = 'DAppExecutionModeConfirmationRequiredError'
  }
}

export interface DAppExecutionModeAffectedOperations {
  readonly count: (scope: DAppExecutionModeScope) => Promise<number>
  readonly cancel: (scope: DAppExecutionModeScope) => Promise<number>
}

export interface DAppExecutionModeRequestToken {
  readonly scope: DAppExecutionModeScope
  readonly revision: number
}

export class DAppExecutionModeRequestInvalidatedError extends Error {
  constructor() {
    super('The dApp execution account changed. Submit the request again.')
    this.name = 'DAppExecutionModeRequestInvalidatedError'
  }
}

export interface DAppExecutionModeTransitionGate {
  readonly runTransition: <T>(
    scope: DAppExecutionModeScope,
    transition: (markModeChanged: () => void) => Promise<T>
  ) => Promise<T>
}

interface DAppExecutionModeRequestGateState {
  revision: number
  barrier: Promise<void> | null
}

export class DAppExecutionModeRequestGate implements DAppExecutionModeTransitionGate {
  private readonly states = new Map<string, DAppExecutionModeRequestGateState>()

  capture(scopeValue: DAppExecutionModeScope): DAppExecutionModeRequestToken {
    const scope = parseScope(scopeValue)
    return Object.freeze({ scope, revision: this.getState(scope).revision })
  }

  async waitForStable(token: DAppExecutionModeRequestToken): Promise<void> {
    const scope = parseScope(token.scope)
    if (!Number.isSafeInteger(token.revision) || token.revision < 0) {
      throw new Error('Invalid dApp execution mode request token')
    }
    const key = scopeKey(scope)
    while (this.states.get(key)?.barrier) {
      await this.states.get(key)?.barrier
    }
    if (this.getState(scope).revision !== token.revision) {
      throw new DAppExecutionModeRequestInvalidatedError()
    }
  }

  async runTransition<T>(
    scopeValue: DAppExecutionModeScope,
    transition: (markModeChanged: () => void) => Promise<T>
  ): Promise<T> {
    const scope = parseScope(scopeValue)
    const state = this.getState(scope)
    if (state.barrier) throw new Error('A dApp execution mode transition is already running')

    let releaseBarrier = () => {}
    const barrier = new Promise<void>(resolve => {
      releaseBarrier = resolve
    })
    state.barrier = barrier
    let modeChanged = false
    try {
      return await transition(() => {
        modeChanged = true
      })
    } finally {
      if (modeChanged) state.revision += 1
      state.barrier = null
      releaseBarrier()
    }
  }

  private getState(scope: DAppExecutionModeScope): DAppExecutionModeRequestGateState {
    const key = scopeKey(scope)
    let state = this.states.get(key)
    if (!state) {
      state = { revision: 0, barrier: null }
      this.states.set(key, state)
    }
    return state
  }
}

const PASSTHROUGH_TRANSITION_GATE: DAppExecutionModeTransitionGate = Object.freeze({
  async runTransition<T>(
    _scope: DAppExecutionModeScope,
    transition: (markModeChanged: () => void) => Promise<T>
  ): Promise<T> {
    return transition(() => {})
  }
})

export class DAppExecutionModeCoordinator {
  private updateQueue = Promise.resolve()

  constructor(
    private readonly repository: DAppExecutionModeRepository,
    private readonly capability: PrivateExecutionCapability
  ) {}

  async read(scopeValue: DAppExecutionModeScope): Promise<DAppExecutionModeState> {
    const scope = parseScope(scopeValue)
    await this.updateQueue
    const persisted = decodePersistedDAppExecutionModes(await this.repository.read())
    const key = scopeKey(scope)
    const mode = persisted.privateScopes.some(item => scopeKey(item) === key) ? 'private' : 'main'
    return Object.freeze({
      mode,
      privateAvailable: await this.capability.isAvailable(scope),
      privateSetupCompleted: persisted.privateSetupScopes.some(item => scopeKey(item) === key)
    })
  }

  set(
    scopeValue: DAppExecutionModeScope,
    mode: DAppExecutionMode,
    options: Readonly<{ confirmPrivateSetup?: boolean }> = {}
  ): Promise<DAppExecutionModeState> {
    const scope = parseScope(scopeValue)
    if (!DAPP_EXECUTION_MODES.includes(mode)) {
      return Promise.reject(new Error('Invalid dApp execution mode'))
    }

    return this.enqueueUpdate(async () => {
      const privateAvailable = await this.capability.isAvailable(scope)
      if (mode === 'private' && !privateAvailable) {
        throw new PrivateExecutionUnavailableError()
      }

      const persisted = decodePersistedDAppExecutionModes(await this.repository.read())
      const key = scopeKey(scope)
      const privateScopes = persisted.privateScopes.filter(item => scopeKey(item) !== key)
      const privateSetupScopes = [...persisted.privateSetupScopes]
      const currentMode =
        privateScopes.length === persisted.privateScopes.length ? 'main' : 'private'
      let privateSetupCompleted = privateSetupScopes.some(item => scopeKey(item) === key)
      if (mode === 'private' && !privateSetupCompleted) {
        if (options.confirmPrivateSetup !== true) throw new PrivateExecutionSetupRequiredError()
        if (privateSetupScopes.length >= MAX_PRIVATE_SCOPES) {
          throw new Error('Too many private execution setup scopes')
        }
        privateSetupScopes.push(scope)
        privateSetupCompleted = true
      }
      if (currentMode === mode) {
        return Object.freeze({ mode, privateAvailable, privateSetupCompleted })
      }

      if (mode === 'private') {
        if (privateScopes.length >= MAX_PRIVATE_SCOPES) {
          throw new Error('Too many private execution mode scopes')
        }
        privateScopes.push(scope)
      }
      await this.repository.write(
        Object.freeze({
          schemaVersion: 1,
          privateScopes: Object.freeze(privateScopes),
          privateSetupScopes: Object.freeze(privateSetupScopes)
        })
      )
      return Object.freeze({ mode, privateAvailable, privateSetupCompleted })
    })
  }

  removeAccount(keyDomainId: string, accountId: string): Promise<void> {
    if (!isScopeId(keyDomainId) || !isScopeId(accountId)) {
      return Promise.reject(new Error('Invalid dApp execution mode account scope'))
    }
    return this.enqueueUpdate(async () => {
      const persisted = decodePersistedDAppExecutionModes(await this.repository.read())
      const matches = (scope: DAppExecutionModeScope) =>
        scope.keyDomainId === keyDomainId && scope.accountId === accountId
      const privateScopes = persisted.privateScopes.filter(scope => !matches(scope))
      const privateSetupScopes = persisted.privateSetupScopes.filter(scope => !matches(scope))
      if (
        privateScopes.length === persisted.privateScopes.length &&
        privateSetupScopes.length === persisted.privateSetupScopes.length
      ) {
        return
      }
      await this.repository.write(
        Object.freeze({
          schemaVersion: 1,
          privateScopes: Object.freeze(privateScopes),
          privateSetupScopes: Object.freeze(privateSetupScopes)
        })
      )
    })
  }

  clear(): Promise<void> {
    return this.enqueueUpdate(() => this.repository.clear())
  }

  private enqueueUpdate<T>(update: () => Promise<T>): Promise<T> {
    const result = this.updateQueue.then(update, update)
    this.updateQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export class DAppExecutionModeTransitionCoordinator {
  private transitionQueue = Promise.resolve()

  constructor(
    private readonly modes: Pick<DAppExecutionModeCoordinator, 'read' | 'set'>,
    private readonly affectedOperations: DAppExecutionModeAffectedOperations,
    private readonly onModeChanged: (
      scope: DAppExecutionModeScope,
      state: DAppExecutionModeState
    ) => Promise<void>,
    private readonly requestGate: DAppExecutionModeTransitionGate = PASSTHROUGH_TRANSITION_GATE
  ) {}

  set(
    scopeValue: DAppExecutionModeScope,
    mode: DAppExecutionMode,
    options: Readonly<{
      confirmPrivateSetup?: boolean
      confirmAffectedOperations?: boolean
    }> = {}
  ): Promise<DAppExecutionModeState> {
    const scope = parseScope(scopeValue)
    if (!DAPP_EXECUTION_MODES.includes(mode)) {
      return Promise.reject(new Error('Invalid dApp execution mode'))
    }

    return this.enqueueTransition(() =>
      this.requestGate.runTransition(scope, async markModeChanged => {
        const previous = await this.modes.read(scope)
        if (previous.mode === mode) return previous
        if (mode === 'private' && !previous.privateAvailable) {
          throw new PrivateExecutionUnavailableError()
        }
        if (
          mode === 'private' &&
          !previous.privateSetupCompleted &&
          options.confirmPrivateSetup !== true
        ) {
          throw new PrivateExecutionSetupRequiredError()
        }

        const pendingApprovalCount = await this.affectedOperations.count(scope)
        if (pendingApprovalCount > 0 && options.confirmAffectedOperations !== true) {
          throw new DAppExecutionModeConfirmationRequiredError(
            Object.freeze({ pendingApprovalCount })
          )
        }
        if (pendingApprovalCount > 0) {
          const cancelled = await this.affectedOperations.cancel(scope)
          if (cancelled < pendingApprovalCount) {
            throw new Error('Unable to cancel every affected dApp operation')
          }
        }

        const state = await this.modes.set(
          scope,
          mode,
          options.confirmPrivateSetup === true ? { confirmPrivateSetup: true } : undefined
        )
        markModeChanged()
        await this.onModeChanged(scope, state)
        return state
      })
    )
  }

  private enqueueTransition<T>(transition: () => Promise<T>): Promise<T> {
    const result = this.transitionQueue.then(transition, transition)
    this.transitionQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
