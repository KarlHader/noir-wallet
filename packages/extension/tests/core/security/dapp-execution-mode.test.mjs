import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  DAppExecutionModeConfirmationRequiredError,
  DAppExecutionModeCoordinator,
  DAppExecutionModeRequestGate,
  DAppExecutionModeRequestInvalidatedError,
  DAppExecutionModeTransitionCoordinator,
  PrivateExecutionSetupRequiredError,
  PrivateExecutionUnavailableError,
  decodePersistedDAppExecutionModes
} from '../../../src/core/dapp/dapp-execution-mode.ts'

const mainnetAccount = Object.freeze({
  network: 'mainnet',
  keyDomainId: 'wallet-1',
  accountId: 'account-1'
})

function repository(initial) {
  let value = initial
  let writes = 0
  return {
    port: {
      async read() {
        return structuredClone(value)
      },
      async write(next) {
        writes += 1
        await Promise.resolve()
        value = structuredClone(next)
      },
      async clear() {
        writes += 1
        await Promise.resolve()
        value = undefined
      }
    },
    value: () => value,
    writes: () => writes
  }
}

test.describe('dApp execution mode coordinator', () => {
  test('defaults every account and network to Main mode', async () => {
    const state = repository(undefined)
    const coordinator = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => false
    })

    await expect(coordinator.read(mainnetAccount)).resolves.toEqual({
      mode: 'main',
      privateAvailable: false,
      privateSetupCompleted: false
    })
    await expect(coordinator.read({ ...mainnetAccount, network: 'testnet' })).resolves.toEqual({
      mode: 'main',
      privateAvailable: false,
      privateSetupCompleted: false
    })
    expect(state.writes()).toBe(0)
  })

  test('persists Private mode by network and account and removes it when returning to Main', async () => {
    const state = repository(undefined)
    const coordinator = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })

    await expect(
      coordinator.set(mainnetAccount, 'private', { confirmPrivateSetup: true })
    ).resolves.toEqual({
      mode: 'private',
      privateAvailable: true,
      privateSetupCompleted: true
    })
    await expect(coordinator.read(mainnetAccount)).resolves.toEqual({
      mode: 'private',
      privateAvailable: true,
      privateSetupCompleted: true
    })
    await expect(coordinator.read({ ...mainnetAccount, accountId: 'account-2' })).resolves.toEqual({
      mode: 'main',
      privateAvailable: true,
      privateSetupCompleted: false
    })

    await coordinator.set(mainnetAccount, 'main')
    expect(state.value()).toEqual({
      schemaVersion: 1,
      privateScopes: [],
      privateSetupScopes: [mainnetAccount]
    })
  })

  test('requires a persisted first-use confirmation before enabling Private mode', async () => {
    const state = repository(undefined)
    const coordinator = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })

    await expect(coordinator.set(mainnetAccount, 'private')).rejects.toBeInstanceOf(
      PrivateExecutionSetupRequiredError
    )
    expect(state.writes()).toBe(0)

    await coordinator.set(mainnetAccount, 'private', { confirmPrivateSetup: true })
    await coordinator.set(mainnetAccount, 'main')
    await expect(coordinator.set(mainnetAccount, 'private')).resolves.toMatchObject({
      mode: 'private',
      privateSetupCompleted: true
    })
  })

  test('refuses Private mode before the complete PEA capability is installed', async () => {
    const state = repository(undefined)
    const coordinator = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => false
    })

    await expect(coordinator.set(mainnetAccount, 'private')).rejects.toBeInstanceOf(
      PrivateExecutionUnavailableError
    )
    expect(state.writes()).toBe(0)
  })

  test('fails closed to Main when persisted mode data is malformed or duplicated', () => {
    expect(decodePersistedDAppExecutionModes({ schemaVersion: 1, privateScopes: [{}] })).toEqual({
      schemaVersion: 1,
      privateScopes: [],
      privateSetupScopes: []
    })
    expect(
      decodePersistedDAppExecutionModes({
        schemaVersion: 1,
        privateScopes: [mainnetAccount, mainnetAccount],
        privateSetupScopes: [mainnetAccount]
      })
    ).toEqual({ schemaVersion: 1, privateScopes: [], privateSetupScopes: [] })
  })

  test('serializes concurrent updates so one account cannot overwrite another', async () => {
    const state = repository(undefined)
    const coordinator = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })

    await Promise.all([
      coordinator.set(mainnetAccount, 'private', { confirmPrivateSetup: true }),
      coordinator.set({ ...mainnetAccount, accountId: 'account-2' }, 'private', {
        confirmPrivateSetup: true
      })
    ])

    expect(state.value()).toEqual({
      schemaVersion: 1,
      privateScopes: [mainnetAccount, { ...mainnetAccount, accountId: 'account-2' }],
      privateSetupScopes: [mainnetAccount, { ...mainnetAccount, accountId: 'account-2' }]
    })
  })

  test('removes both network projections for one Account and clears reset state', async () => {
    const testnetAccount = { ...mainnetAccount, network: 'testnet' }
    const retainedAccount = { ...mainnetAccount, accountId: 'account-2' }
    const state = repository({
      schemaVersion: 1,
      privateScopes: [mainnetAccount, testnetAccount, retainedAccount],
      privateSetupScopes: [mainnetAccount, testnetAccount, retainedAccount]
    })
    const coordinator = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })

    await coordinator.removeAccount(mainnetAccount.keyDomainId, mainnetAccount.accountId)
    expect(state.value()).toEqual({
      schemaVersion: 1,
      privateScopes: [retainedAccount],
      privateSetupScopes: [retainedAccount]
    })

    await coordinator.clear()
    expect(state.value()).toBeUndefined()
  })
})

test.describe('dApp execution mode transition coordinator', () => {
  test('requires confirmation before cancelling pending approvals and changing mode', async () => {
    const state = repository(undefined)
    const modes = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })
    let pendingApprovalCount = 2
    let notifications = 0
    const transitions = new DAppExecutionModeTransitionCoordinator(
      modes,
      {
        count: async () => pendingApprovalCount,
        cancel: async () => {
          const cancelled = pendingApprovalCount
          pendingApprovalCount = 0
          return cancelled
        }
      },
      async () => {
        notifications += 1
      }
    )

    await expect(
      transitions.set(mainnetAccount, 'private', { confirmPrivateSetup: true })
    ).rejects.toMatchObject({
      code: 'affected-operations-confirmation-required',
      impact: { pendingApprovalCount: 2 }
    })
    expect(state.writes()).toBe(0)
    expect(pendingApprovalCount).toBe(2)

    await expect(
      transitions.set(mainnetAccount, 'private', {
        confirmPrivateSetup: true,
        confirmAffectedOperations: true
      })
    ).resolves.toMatchObject({ mode: 'private' })
    expect(state.writes()).toBe(1)
    expect(pendingApprovalCount).toBe(0)
    expect(notifications).toBe(1)
  })

  test('does not cancel operations when the requested mode is already active', async () => {
    const state = repository(undefined)
    const modes = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })
    await modes.set(mainnetAccount, 'private', { confirmPrivateSetup: true })
    let cancellations = 0
    const transitions = new DAppExecutionModeTransitionCoordinator(
      modes,
      {
        count: async () => 1,
        cancel: async () => {
          cancellations += 1
          return 1
        }
      },
      async () => {}
    )

    await expect(transitions.set(mainnetAccount, 'private')).resolves.toMatchObject({
      mode: 'private'
    })
    expect(cancellations).toBe(0)
  })

  test('keeps the previous mode when affected approvals cannot all be cancelled', async () => {
    const state = repository(undefined)
    const modes = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })
    const transitions = new DAppExecutionModeTransitionCoordinator(
      modes,
      {
        count: async () => 2,
        cancel: async () => 1
      },
      async () => {}
    )

    await expect(
      transitions.set(mainnetAccount, 'private', {
        confirmPrivateSetup: true,
        confirmAffectedOperations: true
      })
    ).rejects.toThrow('Unable to cancel every affected dApp operation')
    await expect(modes.read(mainnetAccount)).resolves.toMatchObject({ mode: 'main' })
    expect(state.writes()).toBe(0)
  })

  test('exports a stable confirmation error type', () => {
    expect(
      new DAppExecutionModeConfirmationRequiredError({ pendingApprovalCount: 1 })
    ).toMatchObject({
      name: 'DAppExecutionModeConfirmationRequiredError',
      code: 'affected-operations-confirmation-required'
    })
  })

  test('invalidates a captured dApp request only after a mode change commits', async () => {
    const state = repository(undefined)
    const modes = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })
    const gate = new DAppExecutionModeRequestGate()
    const transitions = new DAppExecutionModeTransitionCoordinator(
      modes,
      { count: async () => 0, cancel: async () => 0 },
      async () => {},
      gate
    )
    const token = gate.capture(mainnetAccount)

    await transitions.set(mainnetAccount, 'private', { confirmPrivateSetup: true })

    await expect(gate.waitForStable(token)).rejects.toBeInstanceOf(
      DAppExecutionModeRequestInvalidatedError
    )
  })

  test('releases waiting requests unchanged when a transition only requests confirmation', async () => {
    const state = repository(undefined)
    const modes = new DAppExecutionModeCoordinator(state.port, {
      isAvailable: async () => true
    })
    const gate = new DAppExecutionModeRequestGate()
    let releaseCount
    const countStarted = new Promise(resolve => {
      releaseCount = resolve
    })
    let allowCount
    const countBlocked = new Promise(resolve => {
      allowCount = resolve
    })
    const transitions = new DAppExecutionModeTransitionCoordinator(
      modes,
      {
        count: async () => {
          releaseCount()
          await countBlocked
          return 1
        },
        cancel: async () => 1
      },
      async () => {},
      gate
    )
    const token = gate.capture(mainnetAccount)
    const transition = transitions.set(mainnetAccount, 'private', {
      confirmPrivateSetup: true
    })
    await countStarted

    let requestReleased = false
    const waitingRequest = gate.waitForStable(token).then(() => {
      requestReleased = true
    })
    await Promise.resolve()
    expect(requestReleased).toBe(false)

    allowCount()
    await expect(transition).rejects.toBeInstanceOf(DAppExecutionModeConfirmationRequiredError)
    await waitingRequest
    expect(requestReleased).toBe(true)
  })

  test('does not block a request captured for another Account', async () => {
    const gate = new DAppExecutionModeRequestGate()
    let releaseTransition
    const transitionBlocked = new Promise(resolve => {
      releaseTransition = resolve
    })
    let transitionStarted
    const started = new Promise(resolve => {
      transitionStarted = resolve
    })
    const transition = gate.runTransition(mainnetAccount, async markModeChanged => {
      transitionStarted()
      await transitionBlocked
      markModeChanged()
    })
    await started

    const otherToken = gate.capture({ ...mainnetAccount, accountId: 'account-2' })
    await expect(gate.waitForStable(otherToken)).resolves.toBeUndefined()

    releaseTransition()
    await transition
  })
})
