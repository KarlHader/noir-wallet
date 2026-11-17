import { before, test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DkgCoordinatorSession,
  type AcceptOutcome,
  type Round1Outcome,
  type Round2Outcome
} from '../../../src/core/multisig/dkg-coordinator'
import { SecretBin, round1Hash, type VaultWasm } from '../../../src/core/multisig/dkg-protocol'
import { openVaultRecord } from '../../../src/core/multisig/vault-record'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '../../../src/lib/bytes'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'

type Shape = { participants: 2 | 3; threshold: 2 | 3 }

const SHAPES: readonly Shape[] = [
  { participants: 2, threshold: 2 },
  { participants: 3, threshold: 2 },
  { participants: 3, threshold: 3 }
]

let wasm: VaultWasm

const WALLET_ID = 'wallet-1'
const GROUP_ID = 'group-1'

function openSession(
  shape: Shape,
  mainnet: boolean,
  bin?: SecretBin,
  resolveMnemonic: (walletId: string) => string = () => TEST_MNEMONIC,
  groupId: string = GROUP_ID
): DkgCoordinatorSession {
  return DkgCoordinatorSession.open(
    wasm,
    { ...shape, mainnet, walletId: WALLET_ID, groupId },
    resolveMnemonic,
    bin
  )
}

before(async () => {
  wasm = await loadVaultWasm()
})

/**
 * One phone, driven through the raw WASM API only, the way the real app will drive it. Nothing
 * here reaches into the coordinator: every exchange is a Uint8Array.
 */
type Dkg = InstanceType<VaultWasm['Dkg']>

class TestPhone {
  private readonly dkg: Dkg
  private dkg1: ReturnType<Dkg['part1']> | null = null
  private dkg2: ReturnType<Dkg['part2']> | null = null
  private broadcasts: InstanceType<VaultWasm['MessageSet']> | null = null
  private dkg3: ReturnType<Dkg['part3']> | null = null

  constructor(
    shape: Shape,
    readonly slot: number,
    private readonly sessionId: Uint8Array
  ) {
    this.dkg = new wasm.Dkg(shape.participants, shape.threshold, slot, sessionId)
  }

  round1(): Uint8Array {
    this.dkg1 = this.dkg.part1()
    return this.round1Envelope(1)
  }

  /** The same round-1 contribution wrapped again, with another sequence number. */
  round1Envelope(sequence: number): Uint8Array {
    if (!this.dkg1) throw new Error('round1() first')
    return this.dkg1.broadcast_envelope(this.sessionId, sequence, this.slot)
  }

  echo(bundleEnvelope: Uint8Array): Promise<string> {
    const payload = wasm.EnvelopeCodec.decode(bundleEnvelope)[6] as Uint8Array
    return round1Hash(wasm.MessageSet.from_bytes(payload).to_bytes())
  }

  round2(bundleEnvelope: Uint8Array): Uint8Array {
    if (!this.dkg1) throw new Error('round1() first')
    const payload = wasm.EnvelopeCodec.decode(bundleEnvelope)[6] as Uint8Array
    this.broadcasts = wasm.MessageSet.from_bytes(payload)
    this.dkg2 = this.dkg.part2(this.dkg1.secret(), this.broadcasts)
    return this.dkg2.outgoing_envelope(this.sessionId, 2, this.slot)
  }

  finish(inboxEnvelope: Uint8Array, sealedQsk: Uint8Array, mainnet: boolean): string {
    if (!this.dkg2 || !this.broadcasts) throw new Error('round2() first')
    const payload = wasm.EnvelopeCodec.decode(inboxEnvelope)[6] as Uint8Array
    const incoming = wasm.MessageSet.from_bytes(payload)
    const dkg3 = this.dkg.part3(this.dkg2.secret(), this.broadcasts, incoming)
    this.dkg3 = dkg3
    const statics = dkg3.statics()
    const coordinatorKey = statics.get(0)
    if (!coordinatorKey) throw new Error('no coordinator static key')
    const qsk = wasm.Sealed.open(
      dkg3.static_secret(),
      coordinatorKey,
      wasm.Sealed.prologue(statics),
      sealedQsk
    )
    return bytesToHex(wasm.Keyset.derive(dkg3.group_verifying_key(), qsk, mainnet, 0)[4])
  }

  /** The group's public key package as this phone computed it, independently of the coordinator. */
  publicKeyPackage(): Uint8Array {
    if (!this.dkg3) throw new Error('finish() first')
    return this.dkg3.public_key_package()
  }
}

/** Remembers every array the coordinator hands over, so a test can check what was wiped when. */
class RecordingBin extends SecretBin {
  readonly recorded: Uint8Array[] = []

  override keep(bytes: Uint8Array): Uint8Array {
    this.recorded.push(bytes)
    return super.keep(bytes)
  }
}

// Sizes of the coordinator's key package and of its ShareBackup bytes in this WASM build. The
// backup embeds the group id, so its size holds for a UUID group id like the ones sessions use.
const KEY_PACKAGE_BYTES = 134
const SHARE_BACKUP_BYTES = 252
const UUID_GROUP_ID = '11111111-2222-4333-8444-555555555555'

function phonesFor(shape: Shape, sessionId: Uint8Array): TestPhone[] {
  const phones: TestPhone[] = []
  for (let slot = 1; slot < shape.participants; slot += 1) {
    phones.push(new TestPhone(shape, slot, sessionId))
  }
  return phones
}

function complete<T>(outcome: AcceptOutcome<T>): T {
  if (!outcome.complete) throw new Error('expected a complete round')
  return outcome
}

async function runRound1(session: DkgCoordinatorSession, phones: TestPhone[]) {
  let outcome: AcceptOutcome<Round1Outcome> = { complete: false }
  for (const phone of phones) outcome = await session.acceptRound1(phone.slot, phone.round1())
  return complete(outcome)
}

async function runRound2(
  session: DkgCoordinatorSession,
  phones: TestPhone[],
  round1: Round1Outcome
) {
  let outcome: AcceptOutcome<Round2Outcome> = { complete: false }
  for (const phone of phones) {
    const bundle = round1.bundles.get(phone.slot)
    if (!bundle) throw new Error(`no bundle for slot ${phone.slot}`)
    outcome = await session.acceptRound2(phone.slot, phone.round2(bundle))
  }
  return complete(outcome)
}

test.describe('multisig dkg coordinator', () => {
  test('open adopts a caller-supplied session id', () => {
    const id = wasm.EnvelopeCodec.new_session_id()
    const session = DkgCoordinatorSession.open(
      wasm,
      { participants: 2, threshold: 2, mainnet: true, walletId: WALLET_ID, groupId: GROUP_ID },
      () => TEST_MNEMONIC,
      undefined,
      id
    )
    expect(bytesToBase64(session.sessionId)).toBe(bytesToBase64(id))
    session.close()
  })

  test('open rejects a 15-byte session id', () => {
    expect(() =>
      DkgCoordinatorSession.open(
        wasm,
        { participants: 2, threshold: 2, mainnet: true, walletId: WALLET_ID, groupId: GROUP_ID },
        () => TEST_MNEMONIC,
        undefined,
        new Uint8Array(15)
      )
    ).toThrow('session id must be 16 bytes')
  })

  test('completes every supported mode and agrees with every phone', async () => {
    for (const shape of SHAPES) {
      const session = openSession(shape, true)
      const phones = phonesFor(shape, session.sessionId)

      const r1 = await runRound1(session, phones)
      expect([...r1.bundles.keys()]).toEqual(phones.map(phone => phone.slot))
      for (const phone of phones) {
        expect(r1.round1Hash).toBe(await phone.echo(r1.bundles.get(phone.slot)!))
      }

      const r2 = await runRound2(session, phones, r1)
      expect(r2.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      for (const phone of phones) {
        const inbox = r2.inboxes.get(phone.slot)!
        const sealed = r2.sealedQsk.get(phone.slot)!
        expect(phone.finish(inbox, sealed, true)).toBe(r2.fingerprint)
      }
      session.close()
    }
  })

  test('reports incomplete until every phone has sent', async () => {
    const shape = SHAPES[1]
    const session = openSession(shape, true)
    const [first] = phonesFor(shape, session.sessionId)
    expect(await session.acceptRound1(first.slot, first.round1())).toEqual({ complete: false })
    session.close()
  })

  test('refuses an envelope from another session', async () => {
    const shape = SHAPES[0]
    const session = openSession(shape, true)
    const stranger = new TestPhone(shape, 1, wasm.EnvelopeCodec.new_session_id())
    await expect(session.acceptRound1(1, stranger.round1())).rejects.toThrow()
    expect(session.closed).toBe(true)
    const [phone] = phonesFor(shape, session.sessionId)
    await expect(session.acceptRound1(1, phone.round1())).rejects.toThrow('DKG session is closed')
  })

  test('refuses a second round-1 envelope from the same phone', async () => {
    const shape = SHAPES[1]
    const session = openSession(shape, true)
    const [phone] = phonesFor(shape, session.sessionId)
    await session.acceptRound1(phone.slot, phone.round1())
    await expect(session.acceptRound1(phone.slot, phone.round1Envelope(5))).rejects.toThrow()
    expect(session.closed).toBe(true)
  })

  test('refuses an envelope whose sender is not the transport slot', async () => {
    const shape = SHAPES[1]
    const session = openSession(shape, true)
    const [phone] = phonesFor(shape, session.sessionId)
    await expect(session.acceptRound1(2, phone.round1())).rejects.toThrow()
    expect(session.closed).toBe(true)
  })

  test('refuses round 2 before round 1 is complete', async () => {
    const shape = SHAPES[1]
    const session = openSession(shape, true)
    const [phone] = phonesFor(shape, session.sessionId)
    await session.acceptRound1(phone.slot, phone.round1())
    await expect(session.acceptRound2(phone.slot, phone.round1Envelope(2))).rejects.toThrow(
      /round 1/
    )
    expect(session.closed).toBe(true)
  })

  test('refuses a tampered round-2 package', async () => {
    const shape = SHAPES[0]
    const session = openSession(shape, true)
    const phones = phonesFor(shape, session.sessionId)
    const r1 = await runRound1(session, phones)
    const envelope = phones[0].round2(r1.bundles.get(1)!)
    envelope[envelope.length - 1] ^= 1
    await expect(session.acceptRound2(1, envelope)).rejects.toThrow()
    expect(session.closed).toBe(true)
  })

  test('returns no key material', async () => {
    const shape = SHAPES[0]
    const session = openSession(shape, false)
    const phones = phonesFor(shape, session.sessionId)
    const r1 = await runRound1(session, phones)
    expect(Object.keys(r1).sort()).toEqual(['bundles', 'complete', 'round1Hash'])
    const r2 = await runRound2(session, phones, r1)
    // The share leaves only inside the sealed record.
    expect(Object.keys(r2).sort()).toEqual([
      'complete',
      'fingerprint',
      'inboxes',
      'record',
      'sealedQsk'
    ])
    expect(Object.keys(r2.record).sort()).toEqual([
      'ciphertext',
      'groupId',
      'iv',
      'network',
      'salt',
      'version'
    ])
    session.close()
  })

  test('wipes every retained secret on close', async () => {
    const shape = SHAPES[1]
    const bin = new SecretBin()
    const session = openSession(shape, true, bin)
    const phones = phonesFor(shape, session.sessionId)
    const r1 = await runRound1(session, phones)
    await runRound2(session, phones, r1)
    expect(bin.size).toBeGreaterThanOrEqual(4)
    expect(bin.isWiped()).toBe(false)
    expect(session.closed).toBe(false)
    session.close()
    expect(bin.isWiped()).toBe(true)
    expect(session.closed).toBe(true)
    session.close()
    await expect(session.acceptRound1(1, phones[0].round1Envelope(9))).rejects.toThrow(
      'DKG session is closed'
    )
  })

  for (const shape of SHAPES) {
    test(`round 2 seals this ceremony's share and keys (${shape.threshold}-of-${shape.participants})`, async () => {
      const session = openSession(shape, false)
      const phones = phonesFor(shape, session.sessionId)
      const r1 = await runRound1(session, phones)
      const r2 = await runRound2(session, phones, r1)
      for (const phone of phones) {
        phone.finish(r2.inboxes.get(phone.slot)!, r2.sealedQsk.get(phone.slot)!, false)
      }

      const { header, share } = await openVaultRecord(r2.record, TEST_MNEMONIC)
      expect(header).toMatchObject({
        version: 1,
        groupId: GROUP_ID,
        network: 'testnet',
        ...shape,
        rosterSlot: 0,
        fingerprint: r2.fingerprint
      })
      const ak = hexToBytes(header.groupVerifyingKey)
      expect(() => wasm.ShareBackup.from_bytes(share, ak, 0).free()).not.toThrow()
      for (const phone of phones) {
        expect(header.publicKeyPackage).toBe(bytesToBase64(phone.publicKeyPackage()))
      }
      expect(bytesToHex(wasm.Keyset.fingerprint_from_fvk(base64ToBytes(header.fvk), false))).toBe(
        r2.fingerprint
      )
      expect(wasm.Keyset.ufvk_matches_ak(header.ufvk, ak)).toBe(true)
      expect(wasm.Keyset.address_is_shielded_only(header.address)).toBe(true)
      session.close()
    })
  }

  test('a wallet without a mnemonic fails round 2 and voids the session', async () => {
    const shape = SHAPES[0]
    const session = openSession(shape, true, undefined, () => {
      throw new Error('Wallet credential session is locked')
    })
    const phones = phonesFor(shape, session.sessionId)
    const r1 = await runRound1(session, phones)
    await expect(runRound2(session, phones, r1)).rejects.toThrow(
      'Wallet credential session is locked'
    )
    expect(session.closed).toBe(true)
  })

  test('the share and key package are wiped once round 2 returns', async () => {
    const shape = SHAPES[1]
    const bin = new RecordingBin()
    const session = openSession(shape, true, bin, () => TEST_MNEMONIC, UUID_GROUP_ID)
    const phones = phonesFor(shape, session.sessionId)
    const r1 = await runRound1(session, phones)
    await runRound2(session, phones, r1)
    expect(session.closed).toBe(false)
    const sensitive = bin.recorded.filter(
      bytes => bytes.length === SHARE_BACKUP_BYTES || bytes.length === KEY_PACKAGE_BYTES
    )
    expect(sensitive.map(bytes => bytes.length).sort()).toEqual([
      KEY_PACKAGE_BYTES,
      SHARE_BACKUP_BYTES
    ])
    for (const bytes of sensitive) expect(bytes.every(byte => byte === 0)).toBe(true)
    // Only those two: the session's other secrets live until close.
    expect(bin.isWiped()).toBe(false)
    session.close()
  })

  test('closing during the final round-2 call rejects it', async () => {
    const shape = SHAPES[0]
    const session = openSession(shape, true)
    const [phone] = phonesFor(shape, session.sessionId)
    const r1 = await runRound1(session, [phone])
    const lastEnvelope = phone.round2(r1.bundles.get(phone.slot)!)
    const pending = session.acceptRound2(phone.slot, lastEnvelope)
    session.close()
    await expect(pending).rejects.toThrow('DKG session is closed')
    expect(session.closed).toBe(true)
  })
})
