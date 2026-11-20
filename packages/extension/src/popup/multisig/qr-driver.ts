import type { CreateSessionEvent } from '@/core/multisig/create-session'
import type { CreateSessionEffect, QrDisplayItem } from '@/core/multisig/create-session-shared'
import { multisigDebug } from '@/core/multisig/debug-log'
import type { SessionDriver } from '@/core/multisig/driver'
import { createEnvelopeSigner, envelopePayloadHash } from '@/core/multisig/envelope-signing'
import type { DeviceIdentity } from '@/core/multisig/identity'
import { createInboundGate } from '@/core/multisig/inbound-gate'
import { deviceId, type MultisigEnvelope, type MultisigMessageType } from '@/core/multisig/messages'
import { QR_DISPLAY_TTL_MS, type DeviceSlot } from '@/core/multisig/types'
import { bytesToBase64 } from '@/lib/bytes'

type Dispatch = (event: CreateSessionEvent) => void

export interface TimeHooks {
  now(): number
  schedule(fn: () => void, delayMs: number): () => void
}

const realTimeHooks: TimeHooks = {
  now: () => Date.now(),
  schedule(fn, delayMs) {
    const id = setTimeout(fn, delayMs)
    // A 30-minute idle timer must not keep a Node process alive on its own.
    ;(id as { unref?: () => void }).unref?.()
    return () => clearTimeout(id)
  }
}

export type QrDisplay = {
  stepKey: string
  slots: readonly DeviceSlot[]
  messageTypes: readonly MultisigMessageType[]
  envelopes: readonly MultisigEnvelope[]
}

export type QrScanRequest = { slots: readonly DeviceSlot[]; messageType: MultisigMessageType }

export type ScanOutcome = 'accepted' | 'duplicate' | 'duplicate_identity' | 'ignored' | 'rejected'

export interface QrDriver extends SessionDriver {
  deliverScan(envelope: MultisigEnvelope): Promise<ScanOutcome>
  currentDisplay(): QrDisplay | null
}

export interface QrDriverOptions {
  session: { groupId: string; sessionId: string }
  identity: DeviceIdentity
  slots: readonly DeviceSlot[]
  onDisplay(display: QrDisplay): void
  onAwaitScan(scan: QrScanRequest): void
  hooks?: TimeHooks
  idleMs?: number
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

/**
 * Real QR transport: signs the codes the session shows and passes every scanned code through the
 * inbound gate before the session sees it.
 */
export function createQrDriver(options: QrDriverOptions): QrDriver {
  const hooks = options.hooks ?? realTimeHooks
  const idleMs = options.idleMs ?? QR_DISPLAY_TTL_MS
  const signer = createEnvelopeSigner({
    groupId: options.session.groupId,
    sessionId: options.session.sessionId,
    senderId: deviceId(1),
    signingKey: options.identity.signingKeys.privateKey
  })
  const gate = createInboundGate({
    groupId: options.session.groupId,
    sessionId: options.session.sessionId,
    ownIdentityPublicKey: bytesToBase64(options.identity.publicKey),
    slots: options.slots
  })
  // A re-shown code must be byte-identical, or a phone that already scanned it would see a new
  // sequence and reject the original as a replay.
  const cache = new Map<string, MultisigEnvelope>()
  // Bumped by disconnect, so a sign that started before it cannot repopulate the slot.
  const slotEpochs = new Map<DeviceSlot, number>()
  const signing = new Set<string>()
  let queue: Promise<void> = Promise.resolve()
  let displayed: QrDisplay | null = null
  // Scans arrive from the store outside execute, so they report through the dispatch it last
  // handed in; the store passes the same one every time.
  let lastDispatch: Dispatch | null = null
  // The replies the session is waiting for. Anything else never reaches the gate, which would
  // otherwise record its sequence for a message the session then drops.
  let awaited: QrScanRequest | null = null
  let cancelIdle: (() => void) | null = null
  let disposed = false

  const epochOf = (slot: DeviceSlot) => slotEpochs.get(slot) ?? 0

  function resetIdle(): void {
    cancelIdle?.()
    cancelIdle = hooks.schedule(() => {
      cancelIdle = null
      if (!disposed) lastDispatch?.({ type: 'STEP_TIMEOUT' })
    }, idleMs)
  }

  async function sign(item: QrDisplayItem): Promise<MultisigEnvelope> {
    // The payload is part of the key, so a step re-showing a type with new content signs anew.
    const payloadHash = envelopePayloadHash(JSON.stringify(item.payload ?? {}))
    const key = `${item.slot}:${item.messageType}:${payloadHash}`
    const cached = cache.get(key)
    if (cached) return cached
    const epoch = epochOf(item.slot)
    const envelope = await signer.next(item.messageType, deviceId(item.slot), item.payload)
    if (epoch === epochOf(item.slot)) cache.set(key, envelope)
    multisigDebug('envelope', {
      direction: 'out',
      messageType: item.messageType,
      slot: item.slot,
      sequence: envelope.sequence
    })
    return envelope
  }

  function display(stepKey: string, items: readonly QrDisplayItem[]): void {
    resetIdle()
    if (signing.has(stepKey)) return
    signing.add(stepKey)
    const epochs = items.map(item => epochOf(item.slot))
    const stale = () =>
      disposed || items.some((item, index) => epochOf(item.slot) !== epochs[index])
    // Signed one after another across displays, so sequence numbers follow item order.
    const job = async () => {
      try {
        const envelopes: MultisigEnvelope[] = []
        for (const item of items) {
          if (stale()) return
          envelopes.push(await sign(item))
        }
        if (stale()) return
        displayed = {
          stepKey,
          slots: unique(items.map(item => item.slot)),
          messageTypes: unique(items.map(item => item.messageType)),
          envelopes
        }
        options.onDisplay(displayed)
      } finally {
        signing.delete(stepKey)
      }
    }
    // A failed sign leaves nothing a phone could scan, so the session ends rather than idling out;
    // the catch also keeps the queue usable for later codes.
    queue = queue.then(job).catch(() => {
      multisigDebug('display_failed', { step: stepKey })
      if (!disposed) lastDispatch?.({ type: 'DKG_FAILED' })
    })
  }

  function disconnect(slot: DeviceSlot): void {
    gate.forgetPeer(slot)
    if (awaited?.slots.includes(slot)) {
      awaited = { ...awaited, slots: awaited.slots.filter(each => each !== slot) }
    }
    slotEpochs.set(slot, epochOf(slot) + 1)
    for (const key of cache.keys()) {
      if (key.startsWith(`${slot}:`)) cache.delete(key)
    }
    if (displayed?.slots.includes(slot)) displayed = null
  }

  async function deliverScan(envelope: MultisigEnvelope): Promise<ScanOutcome> {
    const trace = {
      direction: 'in',
      messageType: envelope.message_type,
      sequence: envelope.sequence
    }
    if (disposed || !lastDispatch) {
      multisigDebug('scan', { ...trace, result: 'ignored' })
      return 'ignored'
    }
    // An abort from a paired phone ends the session whatever step it is on.
    const wanted =
      envelope.message_type === 'SESSION_ABORT' ||
      (awaited !== null &&
        envelope.message_type === awaited.messageType &&
        awaited.slots.some(slot => deviceId(slot) === envelope.sender_id))
    if (!wanted) {
      multisigDebug('scan', { ...trace, result: 'ignored', reason: 'not_awaited' })
      return 'ignored'
    }
    const verdict = await gate.check(envelope)
    const dispatch = lastDispatch
    if (disposed || !dispatch) {
      multisigDebug('scan', { ...trace, result: 'ignored' })
      return 'ignored'
    }
    switch (verdict.kind) {
      case 'accept':
        resetIdle()
        dispatch({ type: 'MESSAGE_RECEIVED', slot: verdict.slot, envelope, at: hooks.now() })
        multisigDebug('scan', { ...trace, slot: verdict.slot, result: 'accepted' })
        return 'accepted'
      case 'duplicate':
        multisigDebug('scan', { ...trace, slot: verdict.slot, result: 'duplicate' })
        return 'duplicate'
      case 'foreign': {
        // The store decides which slot a doubled identity resets, so nothing is dispatched.
        const outcome = verdict.reason === 'duplicate_identity' ? 'duplicate_identity' : 'ignored'
        multisigDebug('scan', { ...trace, result: outcome, reason: verdict.reason })
        return outcome
      }
      case 'invalid':
        dispatch({ type: 'MESSAGE_REJECTED', slot: verdict.slot, reason: verdict.reason })
        multisigDebug('scan', {
          ...trace,
          slot: verdict.slot,
          result: 'rejected',
          reason: verdict.reason
        })
        return 'rejected'
    }
  }

  return {
    kind: 'qr',
    execute(effect: CreateSessionEffect, dispatch) {
      if (disposed) return
      lastDispatch = dispatch
      switch (effect.type) {
        case 'display':
          display(effect.stepKey, effect.items)
          break
        case 'awaitScan':
          resetIdle()
          awaited = { slots: effect.slots, messageType: effect.messageType }
          options.onAwaitScan(awaited)
          break
        case 'disconnect':
          disconnect(effect.slot)
          break
        // Bluetooth effects never reach a QR session; the store runs persistence and the Worker.
        case 'requestDevice':
        case 'issueCode':
        case 'sendTo':
        case 'awaitFrom':
        case 'persistGroup':
        case 'dkgOpen':
        case 'dkgAcceptRound1':
        case 'dkgAcceptRound2':
        case 'dkgClose':
        case 'saveVaultRecord':
          break
      }
    },
    deliverScan,
    currentDisplay: () => displayed,
    dispose() {
      if (disposed) return
      disposed = true
      cancelIdle?.()
      cancelIdle = null
      cache.clear()
      displayed = null
      lastDispatch = null
      awaited = null
    }
  }
}
