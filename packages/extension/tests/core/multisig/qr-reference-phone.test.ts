import { test } from 'node:test'
import { expect } from '@playwright/test'
import { DkgCoordinatorSession } from '../../../src/core/multisig/dkg-coordinator'
import type {
  PairInvitePayload,
  RosterLockPayload,
  VaultWasm
} from '../../../src/core/multisig/dkg-protocol'
import { createEnvelopeSigner, verifyEnvelope } from '../../../src/core/multisig/envelope-signing'
import { parseIdentityPublicKey } from '../../../src/core/multisig/identity'
import { deviceId, type MultisigEnvelope } from '../../../src/core/multisig/messages'
import { buildRoster, type RosterManifest } from '../../../src/core/multisig/roster'
import { base64ToBytes, bytesToBase64 } from '../../../src/lib/bytes'
import {
  DEFAULT_MOCK_SETTINGS,
  MOCK_GUARDIANS,
  writeMockSettings
} from '../../../src/popup/multisig/mock/mock-settings'
import { QrReferencePhone } from '../../../src/popup/multisig/mock/qr-reference-phone'
import { identityFromSeed } from './helpers/identity'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'

const GROUP = '11111111-2222-4333-8444-555555555555'
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DKG_SESSION_BYTES = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const DKG_SESSION_ID = bytesToBase64(DKG_SESSION_BYTES)

const extension = await identityFromSeed(new Uint8Array(32).fill(0x11))
const stranger = await identityFromSeed(new Uint8Array(32).fill(0x44))
const EXTENSION_KEY = bytesToBase64(extension.publicKey)

function signerFor(signingKey: CryptoKey = extension.signingKeys.privateKey) {
  return createEnvelopeSigner({
    groupId: GROUP,
    sessionId: SESSION,
    senderId: deviceId(1),
    signingKey
  })
}

function invitePayload(): PairInvitePayload {
  return {
    identityPublicKey: EXTENSION_KEY,
    device: { name: 'Owner', model: 'Chrome', platform: 'extension' },
    dkgSessionId: DKG_SESSION_ID,
    participants: 2,
    threshold: 2,
    rosterSlot: 1,
    mainnet: false
  }
}

async function rosterFor(phone: QrReferencePhone, slot0 = EXTENSION_KEY): Promise<RosterManifest> {
  return buildRoster({
    groupId: GROUP,
    threshold: 2,
    identities: new Map([
      [0, slot0],
      [1, await phone.identityPublicKey()]
    ])
  })
}

function lockPayload(
  roster: RosterManifest,
  overrides: Partial<RosterLockPayload> = {}
): Record<string, unknown> {
  const { participants, threshold, rosterSlot, mainnet } = invitePayload()
  return {
    dkgSessionId: DKG_SESSION_ID,
    participants,
    threshold,
    rosterSlot,
    mainnet,
    roster,
    ...overrides
  }
}

/** A phone that has scanned a valid invite, and the signer that keeps talking to it. */
async function invitedPhone(loadVault: () => Promise<VaultWasm> = loadVaultWasm) {
  const signer = signerFor()
  const phone = new QrReferencePhone(2, loadVault)
  const invite = await signer.next('PAIR_INVITE', deviceId(2), invitePayload())
  expect(await phone.scan(invite)).toBe('processed')
  return { phone, signer, invite }
}

async function confirmedPhone(loadVault?: () => Promise<VaultWasm>) {
  const setup = await invitedPhone(loadVault)
  setup.phone.confirmIdentity()
  await setup.phone.settled()
  expect(setup.phone.stage).toBe('identity_confirmed')
  return setup
}

function payloadOf(envelope: MultisigEnvelope | null): Record<string, unknown> {
  if (!envelope) throw new Error('expected a reply code')
  return JSON.parse(envelope.encrypted_payload) as Record<string, unknown>
}

async function expectSignedBy(phone: QrReferencePhone, envelope: MultisigEnvelope) {
  const key = parseIdentityPublicKey(await phone.identityPublicKey())
  if (!key) throw new Error('phone identity is malformed')
  expect(await verifyEnvelope(envelope, key.ed25519)).toBe(true)
  expect(envelope.sender_id).toBe(deviceId(2))
  expect(envelope.recipient_id).toBe(deviceId(1))
  expect(envelope.group_id).toBe(GROUP)
  expect(envelope.session_id).toBe(SESSION)
}

async function expectAborted(phone: QrReferencePhone, envelope: MultisigEnvelope) {
  expect(await phone.scan(envelope)).toBe('aborted')
  expect(phone.stage).toBe('failed')
  expect(phone.nextCode()).toBeNull()
}

test.describe('multisig QR reference phone', () => {
  test.afterEach(() => {
    writeMockSettings(DEFAULT_MOCK_SETTINGS)
  })

  test('refuses an array before the invite and answers a valid invite with a signed PAIR_RESPONSE', async () => {
    const signer = signerFor()
    const phone = new QrReferencePhone(2, loadVaultWasm)
    const invite = await signer.next('PAIR_INVITE', deviceId(2), invitePayload())

    expect(await phone.scan([invite])).toBe('rejected_code')
    expect(phone.stage).toBe('idle')
    expect(phone.nextCode()).toBeNull()

    expect(await phone.scan(invite)).toBe('processed')
    expect(phone.stage).toBe('invited')
    const reply = phone.nextCode()
    expect(reply?.message_type).toBe('PAIR_RESPONSE')
    expect(reply?.sequence).toBe(1)
    await expectSignedBy(phone, reply!)
    expect(payloadOf(reply)).toEqual({
      identityPublicKey: await phone.identityPublicKey(),
      device: MOCK_GUARDIANS[2]
    })
    expect(base64ToBytes(await phone.identityPublicKey())).toHaveLength(65)
    phone.dispose()
  })

  test('a code not addressed to this phone is not_for_me and does not abort', async () => {
    const { phone, signer } = await invitedPhone()
    const reply = phone.nextCode()
    const other = await signer.next('PAIR_INVITE', deviceId(3), {
      ...invitePayload(),
      rosterSlot: 2,
      participants: 3
    })

    expect(await phone.scan(other)).toBe('not_for_me')
    expect(await phone.scan([other, other])).toBe('not_for_me')
    expect(phone.stage).toBe('invited')
    expect(phone.nextCode()).toBe(reply)

    // A malformed entry rejects the whole code, still without ending the ceremony.
    const broken = { ...other, sequence: -1 }
    expect(await phone.scan([other, broken])).toBe('rejected_code')
    expect(phone.stage).toBe('invited')
    phone.dispose()
  })

  test('scanning the same code twice is duplicate and yields the same reply bytes', async () => {
    const { phone, signer, invite } = await confirmedPhone()
    const pairResponse = phone.nextCode()
    expect(await phone.scan(invite)).toBe('duplicate')
    expect(phone.nextCode()).toBe(pairResponse)
    expect(phone.stage).toBe('identity_confirmed')

    const lock = await signer.next('ROSTER_LOCK', deviceId(2), lockPayload(await rosterFor(phone)))
    expect(await phone.scan(lock)).toBe('processed')
    const round1 = phone.nextCode()
    expect(round1?.message_type).toBe('DKG_R1')
    const round1Json = JSON.stringify(round1)

    expect(await phone.scan(lock)).toBe('duplicate')
    expect(JSON.stringify(phone.nextCode())).toBe(round1Json)
    // Re-scanning an older code shows the reply that code got back then.
    expect(await phone.scan(invite)).toBe('duplicate')
    expect(phone.nextCode()).toBe(pairResponse)
    expect(await phone.scan([lock, lock])).toBe('duplicate')
    expect(JSON.stringify(phone.nextCode())).toBe(round1Json)
    expect(phone.stage).toBe('ceremony')

    // Same sequence, different content: a replay, so the ceremony ends.
    const altered = { ...lock, authentication_data: invite.authentication_data }
    await expectAborted(phone, altered)
    phone.dispose()
  })

  test('ROSTER_LOCK before identity confirmation aborts', async () => {
    const { phone, signer } = await invitedPhone()
    const lock = await signer.next('ROSTER_LOCK', deviceId(2), lockPayload(await rosterFor(phone)))
    await expectAborted(phone, lock)
    // Once failed, nothing brings the phone back.
    phone.confirmIdentity()
    await phone.settled()
    expect(phone.stage).toBe('failed')
    expect(await phone.scan(lock)).toBe('aborted')
    phone.dispose()
  })

  test('ROSTER_LOCK with a mismatched session parameter, a swapped slot-0 identity or a wrong rosterHash aborts', async () => {
    const mismatched = await confirmedPhone()
    await expectAborted(
      mismatched.phone,
      await mismatched.signer.next(
        'ROSTER_LOCK',
        deviceId(2),
        lockPayload(await rosterFor(mismatched.phone), { mainnet: true })
      )
    )

    const swapped = await confirmedPhone()
    const swappedRoster = await rosterFor(swapped.phone, bytesToBase64(stranger.publicKey))
    await expectAborted(
      swapped.phone,
      await swapped.signer.next('ROSTER_LOCK', deviceId(2), lockPayload(swappedRoster))
    )

    const rehashed = await confirmedPhone()
    const wrongHash = { ...(await rosterFor(rehashed.phone)), rosterHash: '0'.repeat(64) }
    await expectAborted(
      rehashed.phone,
      await rehashed.signer.next('ROSTER_LOCK', deviceId(2), lockPayload(wrongHash))
    )

    const ownSwapped = await confirmedPhone()
    const notMine = buildRoster({
      groupId: GROUP,
      threshold: 2,
      identities: new Map([
        [0, EXTENSION_KEY],
        [1, bytesToBase64(stranger.publicKey)]
      ])
    })
    await expectAborted(
      ownSwapped.phone,
      await ownSwapped.signer.next('ROSTER_LOCK', deviceId(2), lockPayload(notMine))
    )

    for (const setup of [mismatched, swapped, rehashed, ownSwapped]) setup.phone.dispose()
  })

  test('a tampered signature from the extension aborts', async () => {
    const forged = new QrReferencePhone(2, loadVaultWasm)
    const invite = await signerFor().next('PAIR_INVITE', deviceId(2), invitePayload())
    const flipped = invite.authentication_data.startsWith('A') ? 'B' : 'A'
    await expectAborted(forged, {
      ...invite,
      authentication_data: flipped + invite.authentication_data.slice(1)
    })
    forged.dispose()

    // After the invite, only the identity pinned there may sign; a valid stranger signature fails.
    const { phone } = await confirmedPhone()
    const impostor = signerFor(stranger.signingKeys.privateKey)
    await impostor.next('PAIR_INVITE', deviceId(2), invitePayload())
    const lock = await impostor.next(
      'ROSTER_LOCK',
      deviceId(2),
      lockPayload(await rosterFor(phone))
    )
    await expectAborted(phone, lock)
    phone.dispose()
  })

  test('walks the ceremony on real wasm and ends with DKG_FINAL carrying a 64-hex fingerprint', async () => {
    const wasm = await loadVaultWasm()
    const session = DkgCoordinatorSession.open(
      wasm,
      { participants: 2, threshold: 2, mainnet: false, walletId: 'wallet-1', groupId: GROUP },
      () => TEST_MNEMONIC,
      undefined,
      DKG_SESSION_BYTES
    )
    const { phone, signer } = await confirmedPhone()
    try {
      const lock = await signer.next(
        'ROSTER_LOCK',
        deviceId(2),
        lockPayload(await rosterFor(phone))
      )
      expect(await phone.scan(lock)).toBe('processed')
      expect(phone.stage).toBe('ceremony')
      const round1 = phone.nextCode()!
      expect(round1.message_type).toBe('DKG_R1')
      await expectSignedBy(phone, round1)
      const r1 = await session.acceptRound1(1, base64ToBytes(payloadOf(round1).envelope as string))
      if (!r1.complete) throw new Error('round 1 should be complete')

      const bundle = await signer.next('DKG_R1_BUNDLE', deviceId(2), {
        envelope: bytesToBase64(r1.bundles.get(1)!)
      })
      expect(await phone.scan(bundle)).toBe('processed')
      const echo = phone.nextCode()!
      expect(echo.message_type).toBe('DKG_R1_ECHO')
      expect(payloadOf(echo)).toEqual({ round1Hash: r1.round1Hash })

      expect(await phone.scan(await signer.next('DKG_R1_CERT', deviceId(2), {}))).toBe('processed')
      const batch = phone.nextCode()!
      expect(batch.message_type).toBe('DKG_R2_BATCH')
      const r2 = await session.acceptRound2(1, base64ToBytes(payloadOf(batch).envelope as string))
      if (!r2.complete) throw new Error('round 2 should be complete')

      const shares = [
        await signer.next('DKG_R2_INBOX', deviceId(2), {
          envelope: bytesToBase64(r2.inboxes.get(1)!)
        }),
        await signer.next('KEYSET_SETUP', deviceId(2), {
          sealedQsk: bytesToBase64(r2.sealedQsk.get(1)!)
        })
      ]
      expect(await phone.scan(shares)).toBe('processed')
      expect(phone.stage).toBe('done')
      const final = phone.nextCode()!
      expect(final.message_type).toBe('DKG_FINAL')
      await expectSignedBy(phone, final)
      expect(final.sequence).toBeGreaterThan(batch.sequence)
      const { fingerprint } = payloadOf(final)
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(fingerprint).toBe(r2.fingerprint)
    } finally {
      session.close()
      phone.dispose()
    }
  })

  test('reject answers with SESSION_ABORT', async () => {
    writeMockSettings({
      ...DEFAULT_MOCK_SETTINGS,
      nextResponse: { 1: 'approve', 2: 'reject', 3: 'approve' }
    })
    const { phone, invite } = await invitedPhone()
    const abort = phone.nextCode()
    expect(abort?.message_type).toBe('SESSION_ABORT')
    expect(abort?.encrypted_payload).toBe('{}')
    await expectSignedBy(phone, abort!)
    expect(phone.stage).toBe('failed')
    expect(await phone.scan(invite)).toBe('aborted')
    expect(phone.nextCode()).toBe(abort)
    phone.dispose()

    // The setting applies once; the owner refusing the identity on the phone also aborts.
    const refusing = await invitedPhone()
    expect(refusing.phone.nextCode()?.message_type).toBe('PAIR_RESPONSE')
    refusing.phone.rejectIdentity()
    await refusing.phone.settled()
    expect(refusing.phone.stage).toBe('failed')
    const refusal = refusing.phone.nextCode()
    expect(refusal?.message_type).toBe('SESSION_ABORT')
    await expectSignedBy(refusing.phone, refusal!)
    refusing.phone.dispose()
  })

  test('dispose during a pending step leaves the phone disposed and frees the DKG', async () => {
    const wasm = await loadVaultWasm()
    let dkgsCreated = 0
    class CountingDkg extends wasm.Dkg {
      constructor(...args: ConstructorParameters<VaultWasm['Dkg']>) {
        super(...args)
        dkgsCreated += 1
      }
    }
    const counted: VaultWasm = { ...wasm, Dkg: CountingDkg }
    let release: () => void = () => {}
    let loadStarted: () => void = () => {}
    const started = new Promise<void>(resolve => (loadStarted = resolve))
    const loadVault = () => {
      loadStarted()
      return new Promise<VaultWasm>(resolve => (release = () => resolve(counted)))
    }

    const { phone, signer } = await confirmedPhone(loadVault)
    const lock = await signer.next('ROSTER_LOCK', deviceId(2), lockPayload(await rosterFor(phone)))
    const pending = phone.scan(lock)
    await started
    phone.dispose()
    release()
    expect(await pending).toBe('aborted')
    await phone.settled()
    expect(phone.stage).toBe('disposed')
    expect(phone.nextCode()).toBeNull()
    expect(dkgsCreated).toBe(0)
    expect(await phone.scan(lock)).toBe('aborted')

    // Disposed while the invite's signature check is still running.
    const fresh = new QrReferencePhone(2, loadVaultWasm)
    const invite = await signerFor().next('PAIR_INVITE', deviceId(2), invitePayload())
    const inviting = fresh.scan(invite)
    await new Promise(resolve => setImmediate(resolve))
    fresh.dispose()
    expect(await inviting).toBe('aborted')
    expect(fresh.stage).toBe('disposed')
    expect(fresh.nextCode()).toBeNull()
  })
})
