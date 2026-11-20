import { before, test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createVaultDkgRpcHandler,
  isVaultDkgMethod,
  type VaultDkgMethod,
  type VaultDkgRpcHandler,
  type VaultDkgSchema
} from '../../../src/core/multisig/dkg-rpc'
import type { VaultWasm } from '../../../src/core/multisig/dkg-protocol'
import {
  parseSealedVaultRecord,
  openVaultRecord,
  type SealedVaultRecord
} from '../../../src/core/multisig/vault-record'
import { buildRoster } from '../../../src/core/multisig/roster'
import { generateDeviceIdentity } from '../../../src/core/multisig/identity'
import { createEnvelopeSigner, signEnvelope } from '../../../src/core/multisig/envelope-signing'
import type { MultisigEnvelope } from '../../../src/core/multisig/messages'
import { base64ToBytes, bytesToBase64 } from '../../../src/lib/bytes'
import { Phone, callVaultDkg, runRounds, type Round2Complete } from './helpers/raw-phone'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'

let wasm: VaultWasm

before(async () => {
  wasm = await loadVaultWasm()
})

const call = callVaultDkg

const WALLET_ID = 'wallet-1'
const GROUP_ID = '11111111-2222-4333-8444-555555555555'
const OPEN_2_OF_3 = {
  participants: 3,
  threshold: 2,
  mainnet: true,
  ownerWalletId: WALLET_ID,
  groupId: GROUP_ID
} as const

async function authenticatedSetup(
  shape: { participants: 2 | 3; threshold: 2 | 3 } = { participants: 3, threshold: 2 }
) {
  const identities = await Promise.all(
    Array.from({ length: shape.participants }, () => generateDeviceIdentity())
  )
  const outerSessionId = 'outer-session-1'
  const roster = buildRoster({
    groupId: GROUP_ID,
    threshold: shape.threshold,
    identities: new Map(identities.map((id, slot) => [slot, bytesToBase64(id.publicKey)]))
  })
  const signers = identities.map((id, slot) =>
    createEnvelopeSigner({
      groupId: GROUP_ID,
      sessionId: outerSessionId,
      senderId: `device-${slot + 1}`,
      signingKey: id.signingKeys.privateKey
    })
  )
  const open = {
    ...OPEN_2_OF_3,
    ...shape,
    outerSessionId,
    binding: {
      accountId: 'reserved-account',
      birthdayHeight: 321,
      rosterVersion: 1 as const,
      roster
    }
  }
  const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  const { sessionId } = await call(handler, 'vault.dkg.open', open)
  const phones = Array.from(
    { length: shape.participants - 1 },
    (_, i) => new Phone(wasm, shape, i + 1, sessionId)
  )
  return { handler, sessionId, outerSessionId, open, phones, signers, identities }
}

test('v2 refuses opening without an explicit signed outer session binding', async () => {
  const identity = await generateDeviceIdentity()
  const identity2 = await generateDeviceIdentity()
  const roster = buildRoster({
    groupId: GROUP_ID,
    threshold: 2,
    identities: new Map([
      [0, bytesToBase64(identity.publicKey)],
      [1, bytesToBase64(identity2.publicKey)]
    ])
  })
  const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  await expect(
    call(handler, 'vault.dkg.open', {
      ...OPEN_2_OF_3,
      participants: 2,
      binding: { accountId: 'reserved-account', birthdayHeight: 321, rosterVersion: 1, roster }
    })
  ).rejects.toThrow('Invalid vault DKG request')
})

test('v2 rejects unsigned contributions even when the inner WASM envelope is valid', async () => {
  const { handler, sessionId, phones } = await authenticatedSetup()
  await expect(
    call(handler, 'vault.dkg.acceptRound1', {
      sessionId,
      senderSlot: 1,
      envelope: phones[0].round1()
    })
  ).rejects.toThrow()
  expect(handler.sessionCount).toBe(0)
})

test('malformed signed payload is refused without reflecting its raw content', async () => {
  const { handler, sessionId, phones, signers, identities } = await authenticatedSetup()
  const envelope = phones[0].round1()
  const valid = await signers[1].next('DKG_R1', 'device-1', { envelope })
  const signedEnvelope = await signEnvelope(identities[1].signingKeys.privateKey, {
    ...valid,
    encrypted_payload: 'synthetic-payload-marker'
  })
  await expect(
    call(handler, 'vault.dkg.acceptRound1', { sessionId, senderSlot: 1, envelope, signedEnvelope })
  ).rejects.toThrow('Signed DKG inner envelope mismatch')
})

test('v2 rejects forged outer identity, scope, routing, type and replay before accepting contributions', async () => {
  for (const mutation of [
    'signature',
    'identity',
    'group',
    'session',
    'recipient',
    'sender',
    'round',
    'type',
    'inner',
    'replay',
    'concurrent-replay'
  ]) {
    const { handler, sessionId, phones, signers } = await authenticatedSetup()
    const envelope = phones[0].round1()
    const signed = await signers[1].next('DKG_R1', 'device-1', { envelope })
    let signedEnvelope: MultisigEnvelope = signed
    if (mutation === 'signature')
      signedEnvelope = { ...signed, authentication_data: bytesToBase64(new Uint8Array(64)) }
    if (mutation === 'identity')
      signedEnvelope = await createEnvelopeSigner({
        groupId: GROUP_ID,
        sessionId: signed.session_id,
        senderId: 'device-2',
        signingKey: (await generateDeviceIdentity()).signingKeys.privateKey
      }).next('DKG_R1', 'device-1', { envelope })
    if (mutation === 'group') signedEnvelope = { ...signed, group_id: 'other' }
    if (mutation === 'session') signedEnvelope = { ...signed, session_id: 'other' }
    if (mutation === 'recipient') signedEnvelope = { ...signed, recipient_id: 'device-3' }
    if (mutation === 'sender') signedEnvelope = { ...signed, sender_id: 'device-3' }
    if (mutation === 'round') signedEnvelope = { ...signed, round: 2 }
    if (mutation === 'type')
      signedEnvelope = await signers[1].next('DKG_R2_BATCH', 'device-1', { envelope })
    if (mutation === 'inner')
      signedEnvelope = await signers[1].next('DKG_R1', 'device-1', { envelope: 'AAEC' })
    const request = { sessionId, senderSlot: 1, envelope, signedEnvelope }
    if (mutation === 'concurrent-replay') {
      const results = await Promise.allSettled([
        call(handler, 'vault.dkg.acceptRound1', request),
        call(handler, 'vault.dkg.acceptRound1', request)
      ])
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      expect(handler.sessionCount).toBe(0)
      continue
    }
    if (mutation === 'replay') await call(handler, 'vault.dkg.acceptRound1', request)
    await expect(call(handler, 'vault.dkg.acceptRound1', request)).rejects.toThrow()
    expect(handler.sessionCount).toBe(0)
  }
})

test('v2 cannot advance round two without every authentic matching round-one echo', async () => {
  for (const failure of ['missing', 'hash', 'signature', 'replay']) {
    const { handler, sessionId, phones, signers } = await authenticatedSetup({
      participants: 2,
      threshold: 2
    })
    const envelope = phones[0].round1()
    const r1 = await call(handler, 'vault.dkg.acceptRound1', {
      sessionId,
      senderSlot: 1,
      envelope,
      signedEnvelope: await signers[1].next('DKG_R1', 'device-1', { envelope })
    })
    if (!r1.complete) throw new Error('round1 incomplete')
    if (failure !== 'missing') {
      let signedEnvelope = await signers[1].next('DKG_R1_ECHO', 'device-1', {
        round1Hash: failure === 'hash' ? '0'.repeat(64) : r1.round1Hash
      })
      if (failure === 'signature')
        signedEnvelope = {
          ...signedEnvelope,
          authentication_data: bytesToBase64(new Uint8Array(64))
        }
      const request = { sessionId, signedEnvelope }
      if (failure === 'replay') await call(handler, 'vault.dkg.confirmRound1', request)
      await expect(call(handler, 'vault.dkg.confirmRound1', request)).rejects.toThrow()
    } else {
      const inner = phones[0].round2(r1.bundles['1'])
      await expect(
        call(handler, 'vault.dkg.acceptRound2', {
          sessionId,
          senderSlot: 1,
          envelope: inner,
          signedEnvelope: await signers[1].next('DKG_R2_BATCH', 'device-1', { envelope: inner })
        })
      ).rejects.toThrow('round 1 confirmations are incomplete')
    }
    expect(handler.sessionCount).toBe(0)
  }
})

for (const shape of [
  { participants: 2, threshold: 2 },
  { participants: 3, threshold: 2 },
  { participants: 3, threshold: 3 }
] as const) {
  test(`v2 authenticates ${shape.threshold}-of-${shape.participants} and requires all signed final approvals`, async () => {
    const { handler, sessionId, outerSessionId, phones, signers, identities } =
      await authenticatedSetup(shape)
    const r2 = await runRounds(wasm, handler, shape, sessionId, phones, (slot, type, payload) =>
      signers[slot].next(type, 'device-1', payload)
    )
    const confirmations: MultisigEnvelope[] = []
    for (const phone of phones) {
      expect(
        phone.finish(r2.inboxes[String(phone.slot)], r2.sealedQsk[String(phone.slot)], true)
      ).toBe(r2.fingerprint)
      confirmations.push(
        await signers[phone.slot].next('DKG_FINAL', 'device-1', { fingerprint: r2.fingerprint })
      )
    }
    const request = { record: r2.record, ownerWalletId: WALLET_ID }
    expect(
      (await call(handler, 'vault.record.summary', request)).authenticated?.creationConfirmed
    ).not.toBe(true)
    const wrongContexts = await Promise.all(
      [
        { group_id: 'other' },
        { session_id: 'other' },
        { sender_id: 'device-1' },
        { recipient_id: 'device-3' },
        { round: 2 },
        { message_type: 'DKG_R1' as const },
        { sequence: 0 }
      ].map(patch =>
        signEnvelope(identities[1].signingKeys.privateKey, { ...confirmations[0], ...patch })
      )
    )
    for (const bad of [
      [],
      [...confirmations, confirmations[0]],
      ...(confirmations.length === 2 ? [[confirmations[0], confirmations[0]]] : []),
      ...wrongContexts.map(envelope => [envelope, ...confirmations.slice(1)]),
      confirmations.map((e, i) =>
        i === 0 ? { ...e, authentication_data: bytesToBase64(new Uint8Array(64)) } : e
      ),
      confirmations.map((e, i) => (i === 0 ? { ...e, session_id: 'other' } : e)),
      [
        await signers[1].next('DKG_FINAL', 'device-1', { fingerprint: '0'.repeat(64) }),
        ...confirmations.slice(1)
      ]
    ]) {
      await expect(
        call(handler, 'vault.record.summary', {
          ...request,
          creationEvidence: { outerSessionId, confirmations: bad }
        })
      ).rejects.toThrow('Vault record cannot be opened')
    }
    const summary = await call(handler, 'vault.record.summary', {
      ...request,
      creationEvidence: { outerSessionId, confirmations }
    })
    expect(summary.authenticated?.creationConfirmed).toBe(true)
    await call(handler, 'vault.dkg.close', { sessionId })
  })
}

/** Runs a whole ceremony of the given shape through the handler and returns the final answer. */
async function runCeremony(
  handler: VaultDkgRpcHandler,
  open: VaultDkgSchema['vault.dkg.open']['request']
): Promise<{ sessionId: string; r2: Round2Complete }> {
  const { sessionId } = await call(handler, 'vault.dkg.open', open)
  return { sessionId, r2: await runRounds(wasm, handler, open, sessionId) }
}

/** The same record with one ciphertext byte flipped, so its tag no longer verifies. */
function tampered(record: SealedVaultRecord): SealedVaultRecord {
  const ciphertext = base64ToBytes(record.ciphertext)
  ciphertext[0] ^= 1
  return { ...record, ciphertext: bytesToBase64(ciphertext) }
}

test.describe('multisig dkg rpc handler', () => {
  test('freezes a validated binding before DKG and seals the authenticated v2 roster', async () => {
    const { handler, sessionId, open, phones, signers } = await authenticatedSetup()
    const { binding, outerSessionId } = open
    const roster = binding.roster
    for (const patch of [
      { birthdayHeight: -1 },
      { accountId: '' },
      { roster: { ...roster, groupId: 'wrong' } },
      { rosterVersion: 2 }
    ]) {
      await expect(
        call(handler, 'vault.dkg.open', {
          ...OPEN_2_OF_3,
          outerSessionId,
          binding: { ...binding, ...patch }
        })
      ).rejects.toThrow('Invalid vault DKG request')
    }
    binding.birthdayHeight = 999
    binding.accountId = 'changed-after-open'
    roster.participants[0].identityPublicKey = roster.participants[1].identityPublicKey
    const r2 = await runRounds(
      wasm,
      handler,
      OPEN_2_OF_3,
      sessionId,
      phones,
      (slot, type, payload) => signers[slot].next(type, 'device-1', payload)
    )
    const opened = await openVaultRecord(r2.record, TEST_MNEMONIC)
    try {
      expect(opened.header).toMatchObject({
        version: 2,
        accountId: 'reserved-account',
        ownerWalletId: WALLET_ID,
        birthdayHeight: 321,
        rosterVersion: 1
      })
      expect(
        opened.header.version === 2 && opened.header.roster.participants[0].identityPublicKey
      ).not.toBe(roster.participants[0].identityPublicKey)
      await expect(
        call(handler, 'vault.record.summary', {
          record: r2.record,
          ownerWalletId: 'same-seed-other-wallet'
        })
      ).rejects.toThrow('Vault record cannot be opened')
    } finally {
      opened.share.fill(0)
    }
  })
  test('names its session and record methods', () => {
    for (const method of [
      'vault.dkg.open',
      'vault.dkg.acceptRound1',
      'vault.dkg.acceptRound2',
      'vault.dkg.confirmRound1',
      'vault.dkg.close',
      'vault.record.summary'
    ]) {
      expect(isVaultDkgMethod(method)).toBe(true)
    }
    expect(isVaultDkgMethod('vault.dkg.nope')).toBe(false)
    expect(isVaultDkgMethod('mnemonic.validate')).toBe(false)
  })

  test('runs a 2-of-3 ceremony through JSON-shaped calls', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { sessionId } = await call(handler, 'vault.dkg.open', OPEN_2_OF_3)
    expect(base64ToBytes(sessionId)).toHaveLength(16)
    expect(handler.sessionCount).toBe(1)
    const phones = [1, 2].map(slot => new Phone(wasm, OPEN_2_OF_3, slot, sessionId))

    const [first, second] = phones
    expect(
      await call(handler, 'vault.dkg.acceptRound1', {
        sessionId,
        senderSlot: first.slot,
        envelope: first.round1()
      })
    ).toEqual({ complete: false })
    const r1 = await call(handler, 'vault.dkg.acceptRound1', {
      sessionId,
      senderSlot: second.slot,
      envelope: second.round1()
    })
    if (!r1.complete) throw new Error('round 1 should be complete')
    expect(Object.keys(r1.bundles).sort()).toEqual(['1', '2'])
    for (const phone of phones) {
      expect(r1.round1Hash).toBe(await phone.echo(r1.bundles[String(phone.slot)]))
    }

    let r2: VaultDkgSchema['vault.dkg.acceptRound2']['response'] = { complete: false }
    for (const phone of phones) {
      r2 = await call(handler, 'vault.dkg.acceptRound2', {
        sessionId,
        senderSlot: phone.slot,
        envelope: phone.round2(r1.bundles[String(phone.slot)])
      })
    }
    if (!r2.complete) throw new Error('round 2 should be complete')
    expect(r2.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    for (const phone of phones) {
      const slot = String(phone.slot)
      expect(phone.finish(r2.inboxes[slot], r2.sealedQsk[slot], true)).toBe(r2.fingerprint)
    }

    expect(await call(handler, 'vault.dkg.close', { sessionId })).toBe(true)
    expect(handler.sessionCount).toBe(0)
  })

  test('refuses malformed requests', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { sessionId } = await call(handler, 'vault.dkg.open', OPEN_2_OF_3)
    const badOpens = [
      { ...OPEN_2_OF_3, participants: 4 },
      { ...OPEN_2_OF_3, threshold: '2' },
      { ...OPEN_2_OF_3, mainnet: 'yes' },
      { ...OPEN_2_OF_3, extra: 1 }
    ]
    for (const payload of badOpens) {
      await expect(call(handler, 'vault.dkg.open', payload)).rejects.toThrow(
        'Invalid vault DKG request'
      )
    }
    const badAccepts = [
      { sessionId, senderSlot: 1, envelope: 'not base64!' },
      { sessionId, senderSlot: 1.5, envelope: 'AAEC' },
      { sessionId, senderSlot: 1 }
    ]
    for (const payload of badAccepts) {
      await expect(call(handler, 'vault.dkg.acceptRound1', payload)).rejects.toThrow(
        'Invalid vault DKG request'
      )
    }
    await expect(
      call(handler, 'vault.dkg.acceptRound1', {
        sessionId: bytesToBase64(new Uint8Array(16)),
        senderSlot: 1,
        envelope: 'AAEC'
      })
    ).rejects.toThrow('Unknown vault DKG session')
    await expect(handler.handle('vault.dkg.nope' as VaultDkgMethod, {})).rejects.toThrow(
      'Invalid vault DKG request'
    )
    expect(handler.sessionCount).toBe(1)
  })

  test('drops a session after a failed call', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const shape = { participants: 2, threshold: 2 } as const
    const { sessionId } = await call(handler, 'vault.dkg.open', {
      ...OPEN_2_OF_3,
      ...shape
    })
    const phone = new Phone(wasm, shape, 1, sessionId)
    const r1 = await call(handler, 'vault.dkg.acceptRound1', {
      sessionId,
      senderSlot: 1,
      envelope: phone.round1()
    })
    if (!r1.complete) throw new Error('round 1 should be complete')
    const tampered = base64ToBytes(phone.round2(r1.bundles['1']))
    tampered[tampered.length - 1] ^= 1
    await expect(
      call(handler, 'vault.dkg.acceptRound2', {
        sessionId,
        senderSlot: 1,
        envelope: bytesToBase64(tampered)
      })
    ).rejects.toThrow()
    expect(handler.sessionCount).toBe(0)
    await expect(
      call(handler, 'vault.dkg.acceptRound1', { sessionId, senderSlot: 1, envelope: 'AAEC' })
    ).rejects.toThrow('Unknown vault DKG session')
  })

  test('open with sessionId returns that id and refuses to open it twice', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const sessionId = bytesToBase64(new Uint8Array(16).fill(7))
    const opened = await call(handler, 'vault.dkg.open', { ...OPEN_2_OF_3, sessionId })
    expect(opened.sessionId).toBe(sessionId)
    await expect(call(handler, 'vault.dkg.open', { ...OPEN_2_OF_3, sessionId })).rejects.toThrow(
      'Vault DKG session already exists'
    )
    expect(handler.sessionCount).toBe(1)
    await call(handler, 'vault.dkg.close', { sessionId })
  })

  test('open rejects a sessionId that is not 16 bytes', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    for (const sessionId of [bytesToBase64(new Uint8Array(15)), 'not base64!', '']) {
      await expect(call(handler, 'vault.dkg.open', { ...OPEN_2_OF_3, sessionId })).rejects.toThrow(
        'Invalid vault DKG request'
      )
    }
    expect(handler.sessionCount).toBe(0)
  })

  test('open refuses a non-canonical spelling of an open session id', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA=='
    await call(handler, 'vault.dkg.open', { ...OPEN_2_OF_3, sessionId })
    for (const spelling of ['AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAB==']) {
      await expect(
        call(handler, 'vault.dkg.open', { ...OPEN_2_OF_3, sessionId: spelling })
      ).rejects.toThrow('Invalid vault DKG request')
    }
    expect(handler.sessionCount).toBe(1)
    await call(handler, 'vault.dkg.close', { sessionId })
    expect(handler.sessionCount).toBe(0)
  })

  test('a session idles out after 30 minutes, not 10', async () => {
    let now = 0
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC, {
      now: () => now,
      schedule: () => () => {}
    })
    const probe = (sessionId: string) =>
      call(handler, 'vault.dkg.acceptRound1', { sessionId, senderSlot: 1, envelope: 'AAEC' })
    const stillKnown = async (sessionId: string) => {
      // A live session rejects the garbage envelope for its own reason, never as unknown.
      const error = await probe(sessionId).then(
        () => null,
        (e: unknown) => e as Error
      )
      return error !== null && error.message !== 'Unknown vault DKG session'
    }
    const first = (await call(handler, 'vault.dkg.open', OPEN_2_OF_3)).sessionId
    now = 29 * 60_000
    expect(await stillKnown(first)).toBe(true)

    // Opened at 29 minutes; 31 minutes of idleness later it is gone.
    const second = (await call(handler, 'vault.dkg.open', OPEN_2_OF_3)).sessionId
    now = 29 * 60_000 + 31 * 60_000
    await expect(probe(second)).rejects.toThrow('Unknown vault DKG session')
  })

  test('expires idle sessions and evicts the oldest beyond the cap', async () => {
    let now = 0
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC, {
      now: () => now,
      maxSessions: 2,
      idleMs: 1_000
    })
    const open = () => call(handler, 'vault.dkg.open', OPEN_2_OF_3)
    const a = (await open()).sessionId
    now = 10
    const b = (await open()).sessionId
    now = 20
    const c = (await open()).sessionId
    expect(handler.sessionCount).toBe(2)
    const probe = (sessionId: string) =>
      call(handler, 'vault.dkg.acceptRound1', { sessionId, senderSlot: 1, envelope: 'AAEC' })
    await expect(probe(a)).rejects.toThrow('Unknown vault DKG session')
    expect(handler.sessionCount).toBe(2)

    now = 2_000
    await expect(probe(b)).rejects.toThrow('Unknown vault DKG session')
    expect(handler.sessionCount).toBe(0)
    await expect(probe(c)).rejects.toThrow('Unknown vault DKG session')
  })

  test('closes an abandoned session when its idle timer fires', async () => {
    // A tab closed mid-ceremony never sends another vault call, so the Worker has to notice on
    // its own: every open or use arms a timer, and the timer alone closes the session.
    const timers: { fn: () => void; delayMs: number }[] = []
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC, {
      idleMs: 1_000,
      schedule: (fn, delayMs) => {
        // Like a real timer, one that has fired or been cancelled is gone.
        const timer = {
          delayMs,
          fn: () => {
            remove()
            fn()
          }
        }
        const remove = () => {
          const index = timers.indexOf(timer)
          if (index !== -1) timers.splice(index, 1)
        }
        timers.push(timer)
        return remove
      }
    })
    const { sessionId } = await call(handler, 'vault.dkg.open', OPEN_2_OF_3)
    expect(timers.map(timer => timer.delayMs)).toEqual([1_000])

    // A real use re-arms the timer instead of adding a second one.
    const phone = new Phone(wasm, OPEN_2_OF_3, 1, sessionId)
    await call(handler, 'vault.dkg.acceptRound1', {
      sessionId,
      senderSlot: 1,
      envelope: phone.round1()
    })
    expect(timers).toHaveLength(1)
    expect(handler.sessionCount).toBe(1)

    timers[0].fn()
    expect(handler.sessionCount).toBe(0)
    expect(timers).toHaveLength(0)

    // Closing explicitly disarms the timer.
    const second = await call(handler, 'vault.dkg.open', OPEN_2_OF_3)
    expect(timers).toHaveLength(1)
    await call(handler, 'vault.dkg.close', { sessionId: second.sessionId })
    expect(timers).toHaveLength(0)
  })

  test('close is idempotent', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { sessionId } = await call(handler, 'vault.dkg.open', OPEN_2_OF_3)
    expect(await call(handler, 'vault.dkg.close', { sessionId })).toBe(true)
    expect(await call(handler, 'vault.dkg.close', { sessionId })).toBe(true)
    expect(handler.sessionCount).toBe(0)
  })

  test('open requires an owner wallet id and a group id', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { ownerWalletId: _ownerWalletId, ...withoutWallet } = OPEN_2_OF_3
    const { groupId: _groupId, ...withoutGroup } = OPEN_2_OF_3
    const badOpens = [
      withoutWallet,
      withoutGroup,
      // The Offscreen relay treats a `walletId` key as a wallet RPC, so the old name is refused.
      { ...withoutWallet, walletId: WALLET_ID },
      { ...OPEN_2_OF_3, ownerWalletId: 'a b' },
      { ...OPEN_2_OF_3, groupId: 'a:b' },
      { ...OPEN_2_OF_3, scope: { walletId: WALLET_ID } }
    ]
    for (const payload of badOpens) {
      await expect(call(handler, 'vault.dkg.open', payload)).rejects.toThrow(
        'Invalid vault DKG request'
      )
    }
    expect(handler.sessionCount).toBe(0)
  })

  test('the completing round-2 response carries a sealed record', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { sessionId, r2 } = await runCeremony(handler, OPEN_2_OF_3)
    expect(parseSealedVaultRecord(r2.record)).not.toBeNull()
    expect(r2.record.groupId).toBe(OPEN_2_OF_3.groupId)
    expect(r2.record.network).toBe('mainnet')
    await call(handler, 'vault.dkg.close', { sessionId })
  })

  test('vault.record.summary opens a record this handler sealed', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { r2 } = await runCeremony(handler, OPEN_2_OF_3)
    const sessions = handler.sessionCount
    expect(sessions).toBe(1)
    const summary = await call(handler, 'vault.record.summary', {
      record: r2.record,
      ownerWalletId: WALLET_ID
    })
    expect(summary).toEqual({
      fingerprint: r2.fingerprint,
      address: expect.any(String),
      participants: OPEN_2_OF_3.participants,
      threshold: OPEN_2_OF_3.threshold
    })
    expect(wasm.Keyset.address_is_shielded_only(summary.address)).toBe(true)
    expect(handler.sessionCount).toBe(sessions)
  })

  test('vault.record.summary gives one generic error', async () => {
    const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const { sessionId, r2 } = await runCeremony(handler, OPEN_2_OF_3)
    await call(handler, 'vault.dkg.close', { sessionId })

    await expect(
      call(handler, 'vault.record.summary', {
        record: tampered(r2.record),
        ownerWalletId: WALLET_ID
      })
    ).rejects.toThrow(/^Vault record cannot be opened$/)

    const locked = createVaultDkgRpcHandler(wasm, () => {
      throw new Error('Wallet credential session is locked')
    })
    await expect(
      call(locked, 'vault.record.summary', { record: r2.record, ownerWalletId: WALLET_ID })
    ).rejects.toThrow(/^Vault record cannot be opened$/)

    await expect(
      call(handler, 'vault.record.summary', { record: {}, ownerWalletId: 'w' })
    ).rejects.toThrow('Invalid vault DKG request')
    await expect(
      call(handler, 'vault.record.summary', {
        record: r2.record,
        ownerWalletId: WALLET_ID,
        extra: 1
      })
    ).rejects.toThrow('Invalid vault DKG request')
    expect(handler.sessionCount).toBe(0)
  })
})
