import { after, before, test } from 'node:test'
import { expect } from '@playwright/test'
import { UR } from '@ngraveio/bc-ur'
import {
  currentQrStep,
  setCreateSessionDependencies,
  useCreateSessionStore
} from '../../../src/popup/multisig/create-session-store'
import type { DkgPort } from '../../../src/core/multisig/dkg-port'
import type { VaultGroupOpenRequest } from '../../../src/core/multisig/vault-group-rpc'
import type { VaultWasm } from '../../../src/core/multisig/dkg-protocol'
import {
  createVaultDkgRpcHandler,
  type VaultDkgRpcHandler
} from '../../../src/core/multisig/dkg-rpc'
import type { MultisigThreshold } from '../../../src/core/multisig/types'
import { installLockEnv } from './helpers/storage-env'
import { TEST_MNEMONIC, createInProcessDkgPort, loadVaultWasm } from './helpers/vault-wasm'
import { useMultisigGroupStore } from '../../../src/popup/multisig/group-store'
import {
  DEFAULT_MOCK_SETTINGS,
  MOCK_GUARDIANS,
  readMockSettings,
  writeMockSettings
} from '../../../src/popup/multisig/mock/mock-settings'
import { MockPhone } from '../../../src/popup/multisig/mock/mock-phone'
import { createEnvelopeFactory, deviceId } from '../../../src/core/multisig/messages'
import type { DeviceSlot, SessionPhase } from '../../../src/core/multisig/types'
import { encodeCborByteString, encodeEnvelopeUR } from '../../../src/lib/multisig-ur'
import {
  MULTISIG_GROUPS_STORAGE_KEY,
  multisigGroupScopeKey,
  readMultisigGroup,
  type MultisigGroupScope
} from '../../../src/lib/multisig-group-storage'
import { openVaultRecord, type SealedVaultRecord } from '../../../src/core/multisig/vault-record'
import type { VaultGroupSaveRequest } from '../../../src/core/multisig/vault-group-rpc'
import { useToastStore } from '../../../src/store/toast-store'

const SCOPE: MultisigGroupScope = { network: 'mainnet', walletId: 'wallet-1', accountId: 'acc-1' }
const OWNER_NAME = 'My browser'

// Node has no `chrome` global; the store persists through chrome.storage.local, so an in-memory
// stand-in is installed for the whole file. Values are structured-cloned like the real area.
const host = globalThis as { chrome?: unknown }
const originalChrome = host.chrome
const storageArea = new Map<string, unknown>()
const keysOf = (keys: string | string[]): string[] => (Array.isArray(keys) ? keys : [keys])
host.chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) =>
        Object.fromEntries(
          keysOf(keys)
            .filter(key => storageArea.has(key))
            .map(key => [key, structuredClone(storageArea.get(key))])
        ),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items))
          storageArea.set(key, structuredClone(value))
      },
      remove: async (keys: string | string[]) => {
        for (const key of keysOf(keys)) storageArea.delete(key)
      }
    }
  }
}

// The store writes through the multisig storage lock, which Node's `navigator` lacks.
const restoreLocks = installLockEnv()

const cryptoHost = globalThis.crypto as { randomUUID?: () => string }
if (typeof cryptoHost.randomUUID !== 'function') {
  let counter = 0
  cryptoHost.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
}

// Phones answer through setTimeout(0), so a flow only needs a few macrotask turns to settle.
// Node has no Bluetooth chooser, so the cases use the simulated one unless they stub the browser's.
writeMockSettings({ ...DEFAULT_MOCK_SETTINGS, delayMs: 0, chooser: 'simulated' })

// The ceremony runs on the real wallet WASM: the extension's share through an in-process copy of
// the Worker's handler, the phones through the same module.
let wasm: VaultWasm
let handler: VaultDkgRpcHandler
let basePort: DkgPort
let restoreDependencies = () => {}
// The sealed records the in-process port's save has stored, by account scope key.
const saved = new Map<string, SealedVaultRecord>()

before(async () => {
  wasm = await loadVaultWasm()
  handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  basePort = createInProcessDkgPort(handler, saved)
  restoreDependencies = setCreateSessionDependencies({
    dkgPort: basePort,
    loadPhoneVault: async () => wasm
  })
})

after(() => {
  restoreDependencies()
  restoreLocks()
  if (originalChrome === undefined) delete host.chrome
  else host.chrome = originalChrome
})

const store = useCreateSessionStore

// Polls by time rather than by turn count: a DKG round spans WASM calls and WebCrypto digests.
const WAIT_LIMIT_MS = 3_000

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

// Runs a Bluetooth ceremony to ACTIVATED on the store and returns the fingerprint it derived.
async function runBluetoothCeremony(
  threshold: MultisigThreshold,
  scope: MultisigGroupScope = SCOPE
): Promise<string> {
  store.getState().start(scope, threshold, 'ble', OWNER_NAME)
  const slots: (2 | 3)[] = threshold === '2-of-2' ? [2] : [2, 3]
  for (const slot of slots) await pairOverBluetooth(slot)
  store.getState().dispatch({ type: 'CONTINUE' })
  await waitUntil(() => phase() === 'KEYSET_VERIFIED', 'KEYSET_VERIFIED')
  const fingerprint = store.getState().session?.finalFingerprint
  if (!fingerprint) throw new Error('expected a fingerprint at KEYSET_VERIFIED')
  store.getState().dispatch({ type: 'FINGERPRINT_CONFIRMED', stage: 'final' })
  await waitUntil(() => phase() === 'ACTIVATED', 'ACTIVATED')
  return fingerprint
}

async function expectAbortedForVerification(): Promise<void> {
  await waitUntil(() => phase() === 'ABORTED', 'ABORTED')
  expect(store.getState().session?.abortReason).toBe('verification_failed')
  await waitUntil(() => handler.sessionCount === 0, 'the Worker session to close')
}

function connection(slot: DeviceSlot) {
  return store.getState().session?.devices.find(device => device.slot === slot)?.connection
}

function phase(): SessionPhase | undefined {
  return store.getState().session?.phase
}

// Every case ends with reset() even when an assertion fails, so no 60 s code-expiry or 120 s
// step timer is left to keep the test process alive.
async function withFreshStore(run: () => Promise<void> | void): Promise<void> {
  storageArea.clear()
  saved.clear()
  store.getState().reset()
  try {
    await run()
  } finally {
    store.getState().reset()
  }
}

// What the mock phones receive and when they are torn down while `action` runs, in order.
function phoneTraffic(action: () => void): string[] {
  const traffic: string[] = []
  const { receive, dispose } = MockPhone.prototype
  MockPhone.prototype.receive = function (this: MockPhone, envelope, emit) {
    traffic.push(envelope.message_type)
    receive.call(this, envelope, emit)
  }
  MockPhone.prototype.dispose = function (this: MockPhone) {
    traffic.push('dispose')
    dispose.call(this)
  }
  try {
    action()
  } finally {
    MockPhone.prototype.receive = receive
    MockPhone.prototype.dispose = dispose
  }
  return traffic
}

async function pairOverBluetooth(slot: 2 | 3): Promise<void> {
  store.getState().dispatch({ type: 'PAIR_START', slot })
  expect(store.getState().chooser?.slot).toBe(slot)
  const { model } = MOCK_GUARDIANS[slot]
  store.getState().resolveChooser({ status: 'selected', id: `phone-${slot}`, name: model })
  expect(store.getState().chooser).toBeNull()
  await waitUntil(() => connection(slot) === 'connected', `slot ${slot} to connect`)
}

function toastTitles(): string[] {
  return useToastStore.getState().toasts.map(entry => entry.title)
}

// Stands in for the browser's chooser while `run` executes; `requestDevice` plays the user.
async function withBrowserChooser(
  requestDevice: (() => Promise<unknown>) | null,
  run: () => Promise<void>
): Promise<void> {
  const settings = readMockSettings()
  writeMockSettings({ ...settings, chooser: 'native' })
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: requestDevice ? { requestDevice } : undefined
  })
  useToastStore.setState({ toasts: [] })
  try {
    await run()
  } finally {
    delete (navigator as { bluetooth?: unknown }).bluetooth
    useToastStore.setState({ toasts: [] })
    writeMockSettings(settings)
  }
}

test.describe('multisig create-session store', () => {
  test('Bluetooth 2-of-3 pairs, runs the ceremony, activates and persists the group', async () => {
    // What storage held when the record was saved: the group must not be stored before it.
    const groupsAtSave: unknown[] = []
    const restore = setCreateSessionDependencies({
      dkgPort: {
        ...basePort,
        save: request => {
          groupsAtSave.push(storageArea.get(MULTISIG_GROUPS_STORAGE_KEY))
          return basePort.save(request)
        }
      }
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-3', 'ble', OWNER_NAME)
        const started = store.getState().session
        expect(started?.phase).toBe('PAIRING')
        expect(started?.devices[0].device).toEqual({
          slot: 1,
          role: 'owner',
          name: OWNER_NAME,
          model: 'MacBook',
          platform: 'extension'
        })

        await pairOverBluetooth(2)
        await pairOverBluetooth(3)

        store.getState().dispatch({ type: 'CONTINUE' })
        await waitUntil(() => phase() === 'KEYSET_VERIFIED', 'KEYSET_VERIFIED')
        expect(currentQrStep(store.getState())).toBeNull()
        const finalFingerprint = store.getState().session?.finalFingerprint
        expect(finalFingerprint).toMatch(/^[0-9a-f]{64}$/)

        store.getState().dispatch({ type: 'FINGERPRINT_CONFIRMED', stage: 'final' })
        await waitUntil(() => phase() === 'ACTIVATED', 'ACTIVATED')
        expect(store.getState().pendingScan).toBeNull()
        expect(store.getState().pendingDisplay).toBeNull()

        const groupId = store.getState().session?.groupId
        await waitUntil(async () => (await readMultisigGroup(SCOPE)) !== null, 'the stored group')
        const stored = await readMultisigGroup(SCOPE)
        expect(stored?.groupId).toBe(groupId)
        expect(stored?.threshold).toBe('2-of-3')
        expect(stored?.transportKind).toBe('ble')
        expect(stored?.devices.map(device => device.slot)).toEqual([1, 2, 3])
        expect(stored?.createdAt).toBeGreaterThan(0)
        expect(stored?.fingerprint).toBe(finalFingerprint)
        expect(useMultisigGroupStore.getState().getGroup(SCOPE)).toEqual(stored)
        await waitUntil(() => handler.sessionCount === 0, 'the Worker session to close')

        expect(groupsAtSave).toEqual([undefined])
        const record = saved.get(multisigGroupScopeKey(SCOPE))
        if (!record) throw new Error('expected a saved vault record')
        expect(record.groupId).toBe(groupId)
        expect(record.network).toBe('mainnet')
        const opened = await openVaultRecord(record, TEST_MNEMONIC)
        expect(opened.header.fingerprint).toBe(finalFingerprint)
      })
    } finally {
      restore()
    }
  })

  test('a failed save aborts with save_failed and stores no group', async () => {
    const restore = setCreateSessionDependencies({
      dkgPort: {
        ...basePort,
        save: async () => {
          throw new Error('storage full')
        }
      }
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        store.getState().dispatch({ type: 'CONTINUE' })
        await waitUntil(() => phase() === 'KEYSET_VERIFIED', 'KEYSET_VERIFIED')
        store.getState().dispatch({ type: 'FINGERPRINT_CONFIRMED', stage: 'final' })
        await waitUntil(() => phase() === 'ABORTED', 'ABORTED')
        expect(store.getState().session?.abortReason).toBe('save_failed')
        await waitUntil(() => handler.sessionCount === 0, 'the Worker session to close')
        expect(await readMultisigGroup(SCOPE)).toBeNull()
        expect(storageArea.has(MULTISIG_GROUPS_STORAGE_KEY)).toBe(false)
        expect(saved.size).toBe(0)
      })
    } finally {
      restore()
    }
  })

  test('a save answered after a reset does not activate the next session', async () => {
    const held: { request: VaultGroupSaveRequest; resolve: () => void }[] = []
    const restore = setCreateSessionDependencies({
      dkgPort: {
        ...basePort,
        save: request =>
          new Promise<void>(resolve => {
            held.push({ request, resolve })
          })
      }
    })
    // Runs a 2-of-2 ceremony up to the point where its save is held.
    async function startSaving(): Promise<void> {
      const pending = held.length
      store.getState().dispatch({ type: 'CONTINUE' })
      await waitUntil(() => phase() === 'KEYSET_VERIFIED', 'KEYSET_VERIFIED')
      store.getState().dispatch({ type: 'FINGERPRINT_CONFIRMED', stage: 'final' })
      await waitUntil(() => held.length === pending + 1, 'the save request')
      expect(store.getState().session?.savingRecord).toBe(true)
    }
    // Gives a late answer every chance to arrive before checking that it was dropped.
    async function settle(): Promise<void> {
      for (let turn = 0; turn < 10; turn += 1) await new Promise(r => setTimeout(r, 0))
    }
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        await startSaving()
        expect(held[0].request.scope).toEqual(SCOPE)
        expect(held[0].request.groupId).toBe(store.getState().session?.groupId)
        store.getState().reset()

        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        const next = store.getState().session
        held[0].resolve()
        await settle()
        expect(store.getState().session).toBe(next)
        expect(phase()).toBe('PAIRING')

        // The reducer alone would drop an answer that reaches a pairing session, so the next
        // check lands one on a session that is itself waiting for its own save.
        await startSaving()
        store.getState().reset()
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        await startSaving()
        held[1].resolve()
        await settle()
        expect(phase()).toBe('KEYSET_VERIFIED')
        expect(store.getState().session?.savingRecord).toBe(true)

        // Its own answer still activates it.
        held[2].resolve()
        await waitUntil(() => phase() === 'ACTIVATED', 'ACTIVATED')
      })
    } finally {
      restore()
    }
  })

  test('Bluetooth 2-of-2 and 3-of-3 activate, and two runs give different fingerprints', async () => {
    await withFreshStore(async () => {
      const first = await runBluetoothCeremony('2-of-2')
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      await waitUntil(() => handler.sessionCount === 0, 'the first Worker session to close')

      const second = await runBluetoothCeremony('3-of-3')
      expect(second).toMatch(/^[0-9a-f]{64}$/)
      expect(second).not.toBe(first)
      await waitUntil(() => handler.sessionCount === 0, 'the second Worker session to close')
    })
  })

  test('a testnet account completes the ceremony on testnet', async () => {
    const opens: VaultGroupOpenRequest[] = []
    const restore = setCreateSessionDependencies({
      dkgPort: {
        ...basePort,
        open: request => {
          opens.push(request)
          return basePort.open(request)
        }
      }
    })
    try {
      await withFreshStore(async () => {
        const testnet: MultisigGroupScope = { ...SCOPE, network: 'testnet' }
        const fingerprint = await runBluetoothCeremony('2-of-2', testnet)
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(opens).toEqual([
          {
            participants: 2,
            threshold: 2,
            mainnet: false,
            scope: testnet,
            groupId: expect.any(String)
          }
        ])
      })
    } finally {
      restore()
    }
  })

  test('the DKG opens for the session scope and group', async () => {
    const opens: VaultGroupOpenRequest[] = []
    const restore = setCreateSessionDependencies({
      dkgPort: {
        ...basePort,
        open: request => {
          opens.push(request)
          return basePort.open(request)
        }
      }
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        store.getState().dispatch({ type: 'CONTINUE' })
        await waitUntil(() => opens.length === 1, 'the DKG open request')
        const [request] = opens
        expect(request.scope).toEqual(SCOPE)
        expect(request.groupId).toBe(store.getState().session?.groupId)
        expect(request.groupId).toEqual(expect.any(String))
      })
    } finally {
      restore()
    }
  })

  test('a failing DKG call aborts with verification_failed', async () => {
    const restore = setCreateSessionDependencies({
      dkgPort: {
        ...basePort,
        acceptRound1: async () => {
          throw new Error('worker exploded')
        }
      }
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        store.getState().dispatch({ type: 'CONTINUE' })
        await expectAbortedForVerification()
      })
    } finally {
      restore()
    }
  })

  test('a lost Worker session aborts the ceremony', async () => {
    // The session was opened on one Worker; by round 1 a restarted Worker no longer knows it.
    const restarted = createInProcessDkgPort(createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC))
    const restore = setCreateSessionDependencies({
      dkgPort: { ...basePort, acceptRound1: request => restarted.acceptRound1(request) }
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        store.getState().dispatch({ type: 'CONTINUE' })
        await expectAbortedForVerification()
      })
    } finally {
      restore()
    }
  })

  test('a phone that cannot load its wasm aborts the ceremony', async () => {
    const restore = setCreateSessionDependencies({
      loadPhoneVault: () => Promise.reject(new Error('no wasm for phones'))
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        store.getState().dispatch({ type: 'CONTINUE' })
        await expectAbortedForVerification()
      })
    } finally {
      restore()
    }
  })

  test('a DKG session opened after the user left is closed', async () => {
    let resolveOpen: (value: { sessionId: string }) => void = () => {}
    const deferred = new Promise<{ sessionId: string }>(resolve => {
      resolveOpen = resolve
    })
    const restore = setCreateSessionDependencies({
      dkgPort: { ...basePort, open: () => deferred }
    })
    try {
      await withFreshStore(async () => {
        store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
        await pairOverBluetooth(2)
        store.getState().dispatch({ type: 'CONTINUE' })
        expect(store.getState().session?.dkgSessionId).toBeNull()
        store.getState().reset()
      })
      // The Worker answers only now, to a session nobody is waiting for.
      const opened = await basePort.open({
        participants: 2,
        threshold: 2,
        mainnet: true,
        scope: SCOPE,
        groupId: 'orphan-group'
      })
      expect(handler.sessionCount).toBe(1)
      resolveOpen(opened)
      await waitUntil(() => handler.sessionCount === 0, 'the orphan session to close')
    } finally {
      restore()
    }
  })

  test('reset during the ceremony closes the open DKG session', async () => {
    await withFreshStore(async () => {
      store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)
      await pairOverBluetooth(2)
      store.getState().dispatch({ type: 'CONTINUE' })
      await waitUntil(() => store.getState().session?.dkgSessionId !== null, 'the DKG session id')
      expect(handler.sessionCount).toBe(1)
      store.getState().reset()
      await waitUntil(() => handler.sessionCount === 0, 'the Worker session to close')
    })
  })

  test('QR 2-of-2 walks the four codes and activates', async () => {
    await withFreshStore(async () => {
      store.getState().start(SCOPE, '2-of-2', 'qr', OWNER_NAME)

      store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
      expect(store.getState().pendingDisplay?.messageType).toBe('PAIR_INVITE')
      expect(store.getState().pendingDisplay?.expiresAt).toBeGreaterThan(Date.now())
      expect(currentQrStep(store.getState())?.step.kind).toBe('show')
      expect(currentQrStep(store.getState())?.counter).toEqual({ current: 1, total: 4 })

      store.getState().markPhoneScanned(2)
      const replyScan = store.getState().pendingScan
      expect(replyScan?.messageType).toBe('PAIR_RESPONSE')
      expect(store.getState().pendingDisplay).toBeNull()
      expect(currentQrStep(store.getState())?.counter).toEqual({ current: 2, total: 4 })

      // A second tap on "Phone scanned" must not re-arm the scan.
      store.getState().markPhoneScanned(2)
      expect(store.getState().pendingScan).toBe(replyScan)

      store.getState().simulateScan()
      expect(connection(2)).toBe('connected')
      expect(store.getState().pendingScan).toBeNull()

      store.getState().dispatch({ type: 'CONTINUE' })
      expect(store.getState().pendingDisplay?.messageType).toBe('DKG_R2_INBOX')
      expect(currentQrStep(store.getState())?.counter).toEqual({ current: 3, total: 4 })

      store.getState().markPhoneScanned(2)
      expect(store.getState().pendingScan?.messageType).toBe('DKG_FINAL')
      expect(currentQrStep(store.getState())?.counter).toEqual({ current: 4, total: 4 })

      store.getState().simulateScan()
      expect(phase()).toBe('KEYSET_VERIFIED')
      expect(currentQrStep(store.getState())).toBeNull()

      store.getState().dispatch({ type: 'FINGERPRINT_CONFIRMED', stage: 'final' })
      expect(phase()).toBe('ACTIVATED')
      expect(store.getState().pendingScan).toBeNull()
      expect(store.getState().pendingDisplay).toBeNull()
      await waitUntil(async () => (await readMultisigGroup(SCOPE)) !== null, 'the stored group')
    })
  })

  test('camera scans are decoded and accepted only once', async () => {
    await withFreshStore(() => {
      store.getState().start(SCOPE, '2-of-2', 'qr', OWNER_NAME)
      store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
      store.getState().markPhoneScanned(2)

      const session = store.getState().session
      if (!session) throw new Error('expected a session')
      const fromPhone = createEnvelopeFactory({
        groupId: session.groupId,
        sessionId: session.sessionId,
        senderId: deviceId(2)
      })
      const reply = encodeEnvelopeUR(
        fromPhone('PAIR_RESPONSE', deviceId(1), { device: MOCK_GUARDIANS[2] })
      )

      const notJson = new UR(encodeCborByteString(Buffer.from('not json')), 'bytes')
      expect(store.getState().ingestScan(notJson)).toBe('ignored')
      expect(store.getState().ingestScan(reply)).toBe('accepted')
      expect(connection(2)).toBe('connected')
      expect(store.getState().pendingScan).toBeNull()
      expect(store.getState().ingestScan(reply)).toBe('ignored')
    })
  })

  test('switching transport restarts a started pairing without exposing the abort', async () => {
    await withFreshStore(async () => {
      store.getState().start(SCOPE, '2-of-3', 'ble', OWNER_NAME)
      await pairOverBluetooth(2)
      const before = store.getState().session

      const phases: (SessionPhase | undefined)[] = []
      const unsubscribe = store.subscribe(state => phases.push(state.session?.phase))
      let traffic: string[] = []
      try {
        traffic = phoneTraffic(() => store.getState().switchTransport('qr'))
      } finally {
        unsubscribe()
      }
      // The paired phone hears the abort on the old transport before that transport goes.
      expect(traffic).toEqual(['SESSION_ABORT', 'dispose'])

      const after = store.getState().session
      expect(phases).not.toContain('ABORTED')
      expect(after?.phase).toBe('PAIRING')
      expect(after?.transportKind).toBe('qr')
      expect(after?.threshold).toBe('2-of-3')
      expect(after?.sessionId).not.toBe(before?.sessionId)
      expect(after?.devices[0].device?.name).toBe(OWNER_NAME)
      expect(after?.devices.slice(1).map(device => device.connection)).toEqual(['empty', 'empty'])
      expect(store.getState().scope).toEqual(SCOPE)

      // The new session runs on the QR driver.
      store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
      expect(store.getState().pendingDisplay?.messageType).toBe('PAIR_INVITE')
    })
  })

  test('reset tells a connected phone the setup ended before the transport goes', async () => {
    await withFreshStore(async () => {
      store.getState().start(SCOPE, '2-of-3', 'ble', OWNER_NAME)
      await pairOverBluetooth(2)

      expect(phoneTraffic(() => store.getState().reset())).toEqual(['SESSION_ABORT', 'dispose'])
      expect(store.getState().session).toBeNull()
      expect(store.getState().scope).toBeNull()
    })
  })

  test('switching transport before any pairing keeps the session and swaps the driver', async () => {
    await withFreshStore(() => {
      store.getState().start(SCOPE, '2-of-2', 'qr', OWNER_NAME)
      const before = store.getState().session

      store.getState().switchTransport('ble')

      const after = store.getState().session
      expect(after?.sessionId).toBe(before?.sessionId)
      expect(after?.transportKind).toBe('ble')
      store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
      expect(store.getState().chooser?.slot).toBe(2)
      expect(store.getState().pendingDisplay).toBeNull()
    })
  })

  test('one Bluetooth device cannot fill two guardian slots', async () => {
    const answers = ['same-device', 'same-device', 'other-device']
    const requestDevice = async () => ({ id: answers.shift(), name: 'Headphones' })

    await withFreshStore(() =>
      withBrowserChooser(requestDevice, async () => {
        store.getState().start(SCOPE, '2-of-3', 'ble', OWNER_NAME)

        store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
        await waitUntil(() => connection(2) === 'connected', 'slot 2 to connect')

        store.getState().dispatch({ type: 'PAIR_START', slot: 3 })
        await waitUntil(() => connection(3) === 'empty', 'the repeat device to be refused')
        expect(toastTitles()).toEqual(['Device already added'])

        store.getState().dispatch({ type: 'PAIR_START', slot: 3 })
        await waitUntil(() => connection(3) === 'connected', 'slot 3 to connect')
      })
    )
  })

  test('a device freed by a cancelled pairing can be picked again', async () => {
    const requestDevice = async () => ({ id: 'same-device', name: 'Headphones' })

    await withFreshStore(() =>
      withBrowserChooser(requestDevice, async () => {
        store.getState().start(SCOPE, '2-of-3', 'ble', OWNER_NAME)
        const settings = readMockSettings()
        const nextResponse = { ...settings.nextResponse, 2: 'timeout' as const }
        writeMockSettings({ ...settings, nextResponse })

        store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
        await waitUntil(() => connection(2) === 'code_wait', 'slot 2 to wait for its code')
        store.getState().dispatch({ type: 'PAIR_CANCEL', slot: 2 })

        store.getState().dispatch({ type: 'PAIR_START', slot: 3 })
        await waitUntil(() => connection(3) === 'connected', 'slot 3 to connect')
        expect(toastTitles()).toEqual([])
      })
    )
  })

  test('a closed chooser is silent but an unusable Bluetooth is reported', async () => {
    const rejectWith = (message: string) => async () => {
      throw new DOMException(message, 'NotFoundError')
    }
    const cases = [
      {
        requestDevice: rejectWith('User cancelled the requestDevice() chooser.'),
        toasts: []
      },
      {
        requestDevice: rejectWith('Bluetooth adapter not available.'),
        toasts: ['Bluetooth unavailable']
      },
      { requestDevice: null, toasts: ['Bluetooth unavailable'] }
    ]

    for (const { requestDevice, toasts } of cases) {
      await withFreshStore(() =>
        withBrowserChooser(requestDevice, async () => {
          store.getState().start(SCOPE, '2-of-2', 'ble', OWNER_NAME)

          store.getState().dispatch({ type: 'PAIR_START', slot: 2 })
          expect(connection(2)).toBe('choosing')
          await waitUntil(() => connection(2) === 'empty', 'the slot to reset')

          expect(toastTitles()).toEqual(toasts)
        })
      )
    }
  })
})
