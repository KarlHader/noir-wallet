import { before, test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DkgCoordinatorSession,
  type AcceptOutcome,
  type Round1Outcome,
  type Round2Outcome
} from '../../../src/core/multisig/dkg-coordinator'
import { SecretBin, type VaultWasm } from '../../../src/core/multisig/dkg-protocol'
import { base64ToBytes, bytesToBase64 } from '../../../src/lib/bytes'
import { MockPhoneDkg } from '../../../src/popup/multisig/mock/mock-phone-dkg'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'

type Shape = { participants: 2 | 3; threshold: 2 | 3 }

let wasm: VaultWasm

before(async () => {
  wasm = await loadVaultWasm()
})

interface Phone {
  roster: number
  dkg: MockPhoneDkg
}

function complete<T>(outcome: AcceptOutcome<T>): T {
  if (!outcome.complete) throw new Error('expected a complete round')
  return outcome
}

function b64(map: ReadonlyMap<number, Uint8Array>, slot: number): string {
  const bytes = map.get(slot)
  if (!bytes) throw new Error(`nothing for slot ${slot}`)
  return bytesToBase64(bytes)
}

function openCeremony(shape: Shape, mainnet: boolean, bins: SecretBin[] = []) {
  const session = DkgCoordinatorSession.open(
    wasm,
    { ...shape, mainnet, walletId: 'wallet-1', groupId: 'group-1' },
    () => TEST_MNEMONIC
  )
  const dkgSessionId = bytesToBase64(session.sessionId)
  const phones: Phone[] = []
  for (let roster = 1; roster < shape.participants; roster += 1) {
    phones.push({ roster, dkg: new MockPhoneDkg(wasm, bins[roster - 1]) })
  }
  return { session, dkgSessionId, phones }
}

async function runRound1(
  session: DkgCoordinatorSession,
  dkgSessionId: string,
  phones: Phone[],
  shape: Shape,
  mainnet: boolean
): Promise<Round1Outcome> {
  let outcome: AcceptOutcome<Round1Outcome> = { complete: false }
  for (const phone of phones) {
    const reply = phone.dkg.rosterLock({
      dkgSessionId,
      participants: shape.participants,
      threshold: shape.threshold,
      rosterSlot: phone.roster,
      mainnet
    })
    outcome = await session.acceptRound1(phone.roster, base64ToBytes(reply.envelope))
  }
  return complete(outcome)
}

async function runRound2(
  session: DkgCoordinatorSession,
  phones: Phone[],
  r1: Round1Outcome
): Promise<Round2Outcome> {
  let outcome: AcceptOutcome<Round2Outcome> = { complete: false }
  for (const phone of phones) {
    const echo = await phone.dkg.round1Bundle({ envelope: b64(r1.bundles, phone.roster) })
    expect(echo.round1Hash).toBe(r1.round1Hash)
  }
  for (const phone of phones) {
    const reply = phone.dkg.round1Cert()
    outcome = await session.acceptRound2(phone.roster, base64ToBytes(reply.envelope))
  }
  return complete(outcome)
}

async function fullCeremony(shape: Shape, mainnet: boolean, bins: SecretBin[] = []) {
  const { session, dkgSessionId, phones } = openCeremony(shape, mainnet, bins)
  const r1 = await runRound1(session, dkgSessionId, phones, shape, mainnet)
  const r2 = await runRound2(session, phones, r1)
  for (const phone of phones) {
    phone.dkg.round2Inbox({ envelope: b64(r2.inboxes, phone.roster) })
    const final = phone.dkg.keysetSetup({ sealedQsk: b64(r2.sealedQsk, phone.roster) })
    expect(final.fingerprint).toBe(r2.fingerprint)
  }
  session.close()
  return { phones, r2 }
}

const TWO_OF_THREE: Shape = { participants: 3, threshold: 2 }
const TWO_OF_TWO: Shape = { participants: 2, threshold: 2 }

test.describe('multisig mock phone dkg', () => {
  test('two simulated phones and the coordinator agree on one fingerprint', async () => {
    const { r2 } = await fullCeremony(TWO_OF_THREE, true)
    expect(r2.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a testnet ceremony agrees on the testnet fingerprint', async () => {
    const { r2 } = await fullCeremony(TWO_OF_TWO, false)
    expect(r2.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses a coordinator envelope from another session, for another phone or out of order', async () => {
    const { session, dkgSessionId, phones } = openCeremony(TWO_OF_THREE, true)
    const r1 = await runRound1(session, dkgSessionId, phones, TWO_OF_THREE, true)
    const [first, second] = phones
    const bundleFor1 = r1.bundles.get(1)!
    const payloadFor1 = wasm.EnvelopeCodec.decode(bundleFor1)[6] as Uint8Array
    const dkgR1Bundle = wasm.EnvelopeCodec.msg_type('dkgR1Bundle')
    const coordinator = wasm.EnvelopeCodec.coordinator_slot

    // Out of order: a round-2 step before the bundle.
    expect(() => second.dkg.round1Cert()).toThrow()

    // Another session's bundle, with this phone's own payload inside.
    const foreign = wasm.EnvelopeCodec.build(
      dkgR1Bundle,
      1,
      coordinator,
      1,
      1,
      wasm.EnvelopeCodec.new_session_id(),
      payloadFor1
    )
    const stranger = new MockPhoneDkg(wasm)
    stranger.rosterLock({ dkgSessionId, ...TWO_OF_THREE, rosterSlot: 1, mainnet: true })
    await expect(stranger.round1Bundle({ envelope: bytesToBase64(foreign) })).rejects.toThrow()

    // The bundle addressed to the other phone.
    await expect(second.dkg.round1Bundle({ envelope: bytesToBase64(bundleFor1) })).rejects.toThrow()

    // The real bundle is accepted; a later coordinator envelope must carry a higher sequence.
    await first.dkg.round1Bundle({ envelope: bytesToBase64(bundleFor1) })
    const cert = first.dkg.round1Cert()
    expect(cert.envelope.length).toBeGreaterThan(0)
    const bundleSequence = wasm.EnvelopeCodec.decode(bundleFor1)[4] as number
    const stale = wasm.EnvelopeCodec.build(
      wasm.EnvelopeCodec.msg_type('dkgR2Inbox'),
      2,
      coordinator,
      1,
      bundleSequence,
      session.sessionId,
      new Uint8Array(payloadFor1)
    )
    expect(() => first.dkg.round2Inbox({ envelope: bytesToBase64(stale) })).toThrow(/out-of-order/)
    session.close()
  })

  test('refuses a round-1 bundle that changed its own broadcast', async () => {
    const { session, dkgSessionId, phones } = openCeremony(TWO_OF_THREE, true)
    const r1 = await runRound1(session, dkgSessionId, phones, TWO_OF_THREE, true)
    const original = wasm.MessageSet.from_bytes(
      wasm.EnvelopeCodec.decode(r1.bundles.get(1)!)[6] as Uint8Array
    )
    const tampered = new wasm.MessageSet()
    for (const slot of original.slots()) {
      // Slot 1 is shown slot 2's contribution under its own number.
      tampered.set(slot, original.get(slot === 1 ? 2 : slot)!)
    }
    const relay = new wasm.DkgRelay(session.sessionId, TWO_OF_THREE.participants)
    const envelope = relay.bundle(1, 1, tampered)
    await expect(
      phones[0].dkg.round1Bundle({ envelope: bytesToBase64(envelope) })
    ).rejects.toThrow()
    session.close()
  })

  test('refuses a sealed qsk meant for the other phone', async () => {
    const { session, dkgSessionId, phones } = openCeremony(TWO_OF_THREE, true)
    const r1 = await runRound1(session, dkgSessionId, phones, TWO_OF_THREE, true)
    const r2 = await runRound2(session, phones, r1)
    const [first] = phones
    first.dkg.round2Inbox({ envelope: b64(r2.inboxes, 1) })
    expect(() => first.dkg.keysetSetup({ sealedQsk: b64(r2.sealedQsk, 2) })).toThrow()
    session.close()
  })

  test('wipes its secrets on dispose', async () => {
    const bins = [new SecretBin(), new SecretBin()]
    const { phones } = await fullCeremony(TWO_OF_THREE, true, bins)
    for (const bin of bins) {
      expect(bin.size).toBeGreaterThanOrEqual(3)
      expect(bin.isWiped()).toBe(false)
    }
    for (const phone of phones) phone.dkg.dispose()
    for (const bin of bins) expect(bin.isWiped()).toBe(true)
    expect(() => phones[0].dkg.round1Cert()).toThrow()
    phones[0].dkg.dispose()
  })
})
