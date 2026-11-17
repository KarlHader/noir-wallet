import { after, before, test } from 'node:test'
import { expect } from '@playwright/test'
import {
  currentQrStep,
  setCreateSessionDependencies,
  useCreateSessionStore,
  type PendingQrDisplay
} from '../../../src/popup/multisig/create-session-store'
import { scanMarked, type CreateSessionEffect } from '../../../src/core/multisig/create-session'
import { parseDkgFinalPayload } from '../../../src/core/multisig/dkg-protocol'
import { formatFingerprint } from '../../../src/core/multisig/fingerprint'
import {
  createVaultDkgRpcHandler,
  type VaultDkgRpcHandler
} from '../../../src/core/multisig/dkg-rpc'
import type { DkgPort } from '../../../src/core/multisig/dkg-port'
import type { MultisigEnvelope } from '../../../src/core/multisig/messages'
import type { QrStep } from '../../../src/core/multisig/qr-plan'
import type { DeviceSlot, MultisigThreshold, VerifyStage } from '../../../src/core/multisig/types'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'
import {
  multisigGroupScopeKey,
  readMultisigGroup,
  type MultisigGroupScope
} from '../../../src/lib/multisig-group-storage'
import { createEnvelopesUREncoder } from '../../../src/lib/multisig-ur'
import { createQrDriver } from '../../../src/popup/multisig/qr-driver'
import {
  DEFAULT_MOCK_SETTINGS,
  writeMockSettings
} from '../../../src/popup/multisig/mock/mock-settings'
import { createQrMockHooks } from '../../../src/popup/multisig/mock/qr-mock-hooks'
import {
  QrReferencePhone,
  type PhoneStage
} from '../../../src/popup/multisig/mock/qr-reference-phone'
import { SPEC_SEED, identityFromSeed } from './helpers/identity'
import { installStorageEnv } from './helpers/storage-env'
import { TEST_MNEMONIC, createInProcessDkgPort, loadVaultWasm } from './helpers/vault-wasm'

const SCOPE: MultisigGroupScope = { network: 'mainnet', walletId: 'wallet-1', accountId: 'acc-1' }
const OWNER_NAME = 'My browser'

const storage = installStorageEnv()

const cryptoHost = globalThis.crypto as { randomUUID?: () => string }
if (typeof cryptoHost.randomUUID !== 'function') {
  let counter = 0
  cryptoHost.randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
}

// The reference phones answer at once; the panel's delay only paces the Bluetooth mock.
writeMockSettings({ ...DEFAULT_MOCK_SETTINGS, delayMs: 0, qrPhones: 'simulated' })

/** A code the page showed, sized the way the QR component renders it. */
interface CodeSize {
  stepKey: string
  messageTypes: readonly string[]
  envelopes: number
  bytes: number
  frames: number
}

// Orders saves against displays without reading the clock: each records the next tick.
let tick = 0
let handler: VaultDkgRpcHandler
let basePort: DkgPort
let closeCalls = 0
const saved = new Map<string, SealedVaultRecord>()
const saveTicks: number[] = []
const driverEffects: CreateSessionEffect['type'][] = []
const scannedEnvelopes: MultisigEnvelope[] = []
// Every reference phone the hooks created, so its stage can be read at the end.
const phones = new Set<QrReferencePhone>()
let restoreDependencies = () => {}
let restorePhoneSpy = () => {}

before(async () => {
  const wasm = await loadVaultWasm()
  handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  basePort = createInProcessDkgPort(handler, saved)
  const dkgPort: DkgPort = {
    ...basePort,
    close: request => {
      closeCalls += 1
      return basePort.close(request)
    },
    // Ticked once the record is stored, before the store sees the save resolve: a share shown
    // before this point was visible while nothing was on disk.
    save: request =>
      basePort.save(request).then(result => {
        saveTicks.push(++tick)
        return result
      })
  }
  restoreDependencies = setCreateSessionDependencies({
    dkgPort,
    loadPhoneVault: loadVaultWasm,
    loadIdentity: () => identityFromSeed(SPEC_SEED),
    createQrMock: createQrMockHooks,
    // The same real driver, observed: what the reducer asks of it and what the phones hand it.
    createQrDriver: options => {
      const driver = createQrDriver(options)
      return {
        ...driver,
        execute: (effect, dispatch) => {
          driverEffects.push(effect.type)
          driver.execute(effect, dispatch)
        },
        deliverScan: envelope => {
          scannedEnvelopes.push(envelope)
          return driver.deliverScan(envelope)
        }
      }
    }
  })
  // The hooks keep their phones private; the first scan of each one registers it here.
  const { scan } = QrReferencePhone.prototype
  QrReferencePhone.prototype.scan = function (this: QrReferencePhone, content) {
    phones.add(this)
    return scan.call(this, content)
  }
  restorePhoneSpy = () => {
    QrReferencePhone.prototype.scan = scan
  }
})

after(() => {
  restorePhoneSpy()
  restoreDependencies()
  storage.restore()
})

const store = useCreateSessionStore

// The Worker handler and the phones compute on the real WASM and WebCrypto, so progress is polled
// turn by turn rather than awaited on a fixed delay.
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  { timeoutMs = 20_000 }: { timeoutMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function session() {
  const current = store.getState().session
  if (!current) throw new Error('expected a session')
  return current
}

function connection(slot: DeviceSlot) {
  return session().devices.find(device => device.slot === slot)?.connection
}

function showsType(type: string): boolean {
  return store.getState().pendingDisplay?.messageTypes.includes(type as never) ?? false
}

// Every case ends with reset() even when an assertion fails, so no code-expiry or step timer
// outlives it.
async function withFreshStore(run: () => Promise<void>): Promise<void> {
  storage.store.clear()
  saved.clear()
  saveTicks.length = 0
  driverEffects.length = 0
  scannedEnvelopes.length = 0
  phones.clear()
  closeCalls = 0
  store.getState().reset()
  try {
    await run()
  } finally {
    store.getState().reset()
  }
}

// Pairing as the pages drive it: Bluetooth first, then the QR segment once the identity is there.
async function startQrSession(threshold: MultisigThreshold): Promise<void> {
  store.getState().start(SCOPE, threshold, 'ble', OWNER_NAME)
  await until(() => store.getState().identity.status === 'ready', 'the identity')
  store.getState().switchTransport('qr')
}

async function showInvite(slot: DeviceSlot): Promise<PendingQrDisplay> {
  store.getState().dispatch({ type: 'PAIR_START', slot })
  await until(
    () =>
      showsType('PAIR_INVITE') && store.getState().pendingDisplay?.slots.includes(slot) === true,
    `the invite for device ${slot}`
  )
  const invite = store.getState().pendingDisplay
  if (!invite) throw new Error('expected the invite')
  return invite
}

async function startQrPairing(): Promise<PendingQrDisplay> {
  await startQrSession('2-of-2')
  return showInvite(2)
}

async function scanReply(slot: DeviceSlot = 2): Promise<void> {
  store.getState().markPhoneScanned(slot)
  await until(() => store.getState().pendingScan?.slots.includes(slot) === true, 'the reply scan')
  await store.getState().simulateScan(slot)
}

/** Invite, reply and identity check for each phone in turn, then the roster lock. */
async function pairPhones(threshold: MultisigThreshold, slots: readonly DeviceSlot[]) {
  await startQrSession(threshold)
  for (const slot of slots) {
    await showInvite(slot)
    await scanReply(slot)
    await until(() => connection(slot) === 'identity_check', `the identity check of ${slot}`)
    store.getState().confirmIdentity(slot)
    expect(connection(slot)).toBe('connected')
  }
  store.getState().dispatch({ type: 'CONTINUE' })
}

function isMarked(slot: DeviceSlot, step: Extract<QrStep, { kind: 'scan' }>): boolean {
  const device = session().devices.find(entry => entry.slot === slot)
  return device !== undefined && scanMarked(device, step.messageType)
}

interface CeremonyOptions {
  /** The order the phones' codes are scanned in on a scan step; the plan's order by default. */
  scanOrder?: (step: Extract<QrStep, { kind: 'scan' }>) => readonly DeviceSlot[]
  /** Runs on a verify step before the owner confirms it. */
  beforeVerify?: (stage: VerifyStage) => Promise<void>
  /** Leaves the ceremony on the first step this matches, without acting on it. */
  stopAt?: (step: QrStep) => boolean
}

/**
 * Plays every ceremony step the way the pages and the dev panel do, until activation or the step
 * `stopAt` picks. Returns the verify stages the owner confirmed, in order.
 */
async function driveCeremony(options: CeremonyOptions = {}): Promise<VerifyStage[]> {
  const confirmed: VerifyStage[] = []
  while (session().phase !== 'ACTIVATED') {
    await until(
      () => currentQrStep(store.getState()) !== null || session().phase === 'ABORTED',
      'the next ceremony step'
    )
    expect(session().abortReason).toBeNull()
    const index = session().qrCeremonyIndex
    const step = currentQrStep(store.getState())?.step
    if (!step) throw new Error('expected a ceremony step')
    if (options.stopAt?.(step)) return confirmed
    if (step.kind === 'show') {
      await until(() => step.messageTypes.every(type => showsType(type)), `the ${step.title} code`)
      for (const slot of step.slots) store.getState().markPhoneScanned(slot)
    } else if (step.kind === 'scan') {
      const order = options.scanOrder?.(step) ?? step.slots
      for (const [position, slot] of order.entries()) {
        await store.getState().simulateScan(slot)
        // Each phone's code is taken in before the next is scanned, so the order is the one given.
        if (position < order.length - 1) {
          await until(() => isMarked(slot, step), `${step.title} from device ${slot}`)
        }
      }
    } else {
      await options.beforeVerify?.(step.stage)
      store.getState().dispatch({ type: 'FINGERPRINT_CONFIRMED', stage: step.stage })
      confirmed.push(step.stage)
    }
    await until(
      () =>
        session().qrCeremonyIndex !== index ||
        session().phase === 'ACTIVATED' ||
        session().phase === 'ABORTED',
      `the step after ${step.title}`
    )
  }
  return confirmed
}

function codeSize(display: PendingQrDisplay): CodeSize {
  const content = display.envelopes.length === 1 ? display.envelopes[0] : display.envelopes
  return {
    stepKey: display.stepKey,
    messageTypes: display.messageTypes,
    envelopes: display.envelopes.length,
    bytes: JSON.stringify(content).length,
    frames: createEnvelopesUREncoder(display.envelopes).fragmentsLength
  }
}

test('QR 2-of-2 completes end to end on real wasm', async () => {
  await withFreshStore(async () => {
    const sizes = new Map<string, CodeSize>()
    // Written from the subscription, so kept in an object the compiler does not narrow.
    const seen: { sharesShownAt: number | null; phoneStageAtActivation: PhoneStage | null } = {
      sharesShownAt: null,
      phoneStageAtActivation: null
    }
    const unsubscribe = store.subscribe(state => {
      const display = state.pendingDisplay
      if (display && !sizes.has(display.stepKey)) sizes.set(display.stepKey, codeSize(display))
      if (seen.sharesShownAt === null && display?.messageTypes.includes('DKG_R2_INBOX')) {
        seen.sharesShownAt = ++tick
      }
      // The store disposes the phones right after it publishes the activation.
      if (seen.phoneStageAtActivation === null && state.session?.phase === 'ACTIVATED') {
        seen.phoneStageAtActivation = [...phones][0]?.stage ?? null
      }
    })
    try {
      const invite = await startQrPairing()
      // Re-entering the invite page shows the invite again, byte for byte.
      store.getState().dispatch({ type: 'QR_INVITE_SHOWN', slot: 2 })
      await until(() => store.getState().pendingDisplay !== invite, 'the invite again')
      expect(JSON.stringify(store.getState().pendingDisplay?.envelopes[0])).toBe(
        JSON.stringify(invite.envelopes[0])
      )

      await scanReply()
      await until(() => connection(2) === 'identity_check', 'the identity check')
      store.getState().confirmIdentity(2)
      expect(connection(2)).toBe('connected')
      store.getState().dispatch({ type: 'CONTINUE' })

      expect(await driveCeremony()).toEqual(['final'])

      const finished = session()
      expect(finished.phase).toBe('ACTIVATED')
      const fingerprint = finished.finalFingerprint
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)

      await until(async () => (await readMultisigGroup(SCOPE)) !== null, 'the stored group')
      expect((await readMultisigGroup(SCOPE))?.fingerprint).toBe(fingerprint)

      // The share was on disk before any phone could see its own.
      expect(saved.has(multisigGroupScopeKey(SCOPE))).toBe(true)
      expect(saveTicks).toHaveLength(1)
      expect(saveTicks[0]).toBeLessThan(seen.sharesShownAt ?? 0)

      // QR has no channel back to the phones, so nothing is ever sent.
      expect(driverEffects).not.toContain('sendTo')
      expect(new Set(driverEffects)).toEqual(new Set(['display', 'awaitScan']))

      expect(
        [...sizes.values()]
          .filter(size => size.stepKey.startsWith('ceremony:'))
          .map(size => [size.messageTypes.join('+'), size.envelopes])
      ).toEqual([
        ['ROSTER_LOCK', 1],
        ['DKG_R1_BUNDLE', 1],
        ['DKG_R1_CERT', 1],
        ['DKG_R2_INBOX+KEYSET_SETUP', 2]
      ])
      for (const size of sizes.values()) expect(size.frames).toBeGreaterThanOrEqual(1)

      expect(phones.size).toBe(1)
      expect(seen.phoneStageAtActivation).toBe('done')
      const finals = scannedEnvelopes.filter(envelope => envelope.message_type === 'DKG_FINAL')
      expect(finals).toHaveLength(1)
      expect(parseDkgFinalPayload(JSON.parse(finals[0].encrypted_payload))?.fingerprint).toBe(
        fingerprint
      )

      // Activation releases the Worker's session: the share now lives in the sealed record.
      await until(() => handler.sessionCount === 0, 'the Worker session to close')
    } finally {
      unsubscribe()
    }
  })
})

test('a phone reject during pairing aborts with phone_rejected', async () => {
  await withFreshStore(async () => {
    await startQrPairing()
    await scanReply()
    await until(() => connection(2) === 'identity_check', 'the identity check')
    // The phone's owner refuses on the phone. Only a phone whose reply registered its identity can
    // abort: an abort from an unregistered sender cannot be verified, so the gate ignores it.
    const [phone] = phones
    phone.rejectIdentity()
    await store.getState().simulateScan(2)
    expect(session().phase).toBe('ABORTED')
    expect(session().abortReason).toBe('phone_rejected')
    expect(closeCalls).toBe(0)
    expect(saved.size).toBe(0)
    expect(await readMultisigGroup(SCOPE)).toBeNull()
  })
})

test('rejecting the identity check aborts and leaves no Worker session', async () => {
  await withFreshStore(async () => {
    await startQrPairing()
    await scanReply()
    await until(() => connection(2) === 'identity_check', 'the identity check')
    store.getState().dispatch({ type: 'IDENTITY_REJECTED', slot: 2 })
    expect(session().phase).toBe('ABORTED')
    expect(session().abortReason).toBe('fingerprint_mismatch')
    // The roster was never locked, so no Worker session was opened and none needs closing.
    expect(closeCalls).toBe(0)
    expect(handler.sessionCount).toBe(0)
    expect(driverEffects).not.toContain('sendTo')
  })
})

for (const threshold of ['2-of-3', '3-of-3'] as const) {
  test(`QR ${threshold} completes with roster and round-1 checks, scans accepted in any order`, async () => {
    await withFreshStore(async () => {
      const sizes = new Map<string, CodeSize>()
      const seen: { phoneStagesAtActivation: PhoneStage[] | null } = {
        phoneStagesAtActivation: null
      }
      const unsubscribe = store.subscribe(state => {
        const display = state.pendingDisplay
        if (display && !sizes.has(display.stepKey)) sizes.set(display.stepKey, codeSize(display))
        // The store disposes the phones right after it publishes the activation.
        if (seen.phoneStagesAtActivation === null && state.session?.phase === 'ACTIVATED') {
          seen.phoneStagesAtActivation = [...phones].map(phone => phone.stage)
        }
      })
      try {
        await pairPhones(threshold, [2, 3])
        const shownRoster: string[] = []
        const confirmed = await driveCeremony({
          // Device 3 first: the Worker takes round 1 in whatever order the codes arrive.
          scanOrder: step => (step.messageType === 'DKG_R1' ? [3, 2] : step.slots),
          beforeVerify: async stage => {
            if (stage !== 'roster') return
            // Each phone checked the lock it scanned before its own screen shows the hash.
            await Promise.all([...phones].map(phone => phone.settled()))
            const rosterHash = session().roster?.rosterHash ?? ''
            shownRoster.push(formatFingerprint(rosterHash))
            expect(phones.size).toBe(2)
            for (const phone of phones) expect(phone.rosterHashSeen()).toBe(rosterHash)
          }
        })
        expect(confirmed).toEqual(['roster', 'r1', 'final'])
        // The roster page shows six groups of the hash both phones recomputed on their own.
        expect(shownRoster).toHaveLength(1)
        expect(shownRoster[0]).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){5}$/)

        const finished = session()
        expect(finished.phase).toBe('ACTIVATED')
        expect(finished.ownerConfirmed.r1).toBe(true)
        expect(finished.ownerConfirmed.final).toBe(true)
        await until(async () => (await readMultisigGroup(SCOPE)) !== null, 'the stored group')
        expect((await readMultisigGroup(SCOPE))?.fingerprint).toBe(finished.finalFingerprint)
        expect(saveTicks).toHaveLength(1)
        expect(driverEffects).not.toContain('sendTo')

        expect(
          [...sizes.values()]
            .filter(size => size.stepKey.startsWith('ceremony:'))
            .map(size => [size.messageTypes.join('+'), size.envelopes])
        ).toEqual([
          ['ROSTER_LOCK', 2],
          ['DKG_R1_BUNDLE', 2],
          ['DKG_R1_CERT', 2],
          ['DKG_R2_INBOX+KEYSET_SETUP', 4]
        ])
        // A code holds at most 8 envelopes. One code shared by both phones stays practical to scan
        // up to about 3 KB and 15 animated frames; a step past that needs one code per phone.
        for (const size of sizes.values()) {
          expect(size.envelopes, `${size.stepKey} envelopes`).toBeLessThanOrEqual(8)
          expect(size.bytes, `${size.stepKey} bytes`).toBeLessThanOrEqual(3000)
          expect(size.frames, `${size.stepKey} frames`).toBeLessThanOrEqual(15)
        }

        expect(seen.phoneStagesAtActivation).toEqual(['done', 'done'])
        const finals = scannedEnvelopes.filter(envelope => envelope.message_type === 'DKG_FINAL')
        expect(finals.map(envelope => envelope.sender_id).sort()).toEqual(['device-2', 'device-3'])
        await until(() => handler.sessionCount === 0, 'the Worker session to close')
      } finally {
        unsubscribe()
      }
    })
  })
}

test('one phone rejecting the roster check aborts the whole session', async () => {
  await withFreshStore(async () => {
    const shown = new Set<string>()
    const unsubscribe = store.subscribe(state => {
      for (const type of state.pendingDisplay?.messageTypes ?? []) shown.add(type)
    })
    try {
      await pairPhones('2-of-3', [2, 3])
      await driveCeremony({ stopAt: step => step.kind === 'verify' && step.stage === 'roster' })
      expect(handler.sessionCount).toBe(1)
      // A phone cannot report a mismatch over QR; its owner tells the extension's owner, who
      // rejects here.
      store.getState().dispatch({ type: 'FINGERPRINT_REJECTED', stage: 'roster' })
      expect(session().phase).toBe('ABORTED')
      expect(session().abortReason).toBe('fingerprint_mismatch')
      await until(() => handler.sessionCount === 0, 'the Worker session to close')
      expect(closeCalls).toBe(1)
      expect(saved.size).toBe(0)
      expect(await readMultisigGroup(SCOPE)).toBeNull()
      expect(shown.has('DKG_R2_INBOX')).toBe(false)
      expect(driverEffects).not.toContain('sendTo')
    } finally {
      unsubscribe()
    }
  })
})
