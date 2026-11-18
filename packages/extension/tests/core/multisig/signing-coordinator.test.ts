import { createProtocolOnlySigningWasm } from './helpers/signing-worker'
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sha256 } from '@noble/hashes/sha2'
import { loadWalletWasm, TEST_MNEMONIC, type WalletWasmModule } from './helpers/vault-wasm'
import { Phone, runRounds, type Shape } from './helpers/raw-phone'
import { identityFromSeed } from './helpers/identity'
import { createVaultDkgRpcHandler } from '../../../src/core/multisig/dkg-rpc'
import { openVaultRecord } from '../../../src/core/multisig/vault-record'
import { buildRoster } from '../../../src/core/multisig/roster'
import { createEnvelopeSigner, verifyEnvelope } from '../../../src/core/multisig/envelope-signing'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '../../../src/lib/bytes'
import * as signing from '../../../src/core/multisig/signing-coordinator'
import {
  parseSignPayload,
  parseSignEnvelopePayload
} from '../../../src/core/multisig/sign-protocol'

let wasm: WalletWasmModule
let fixture: Uint8Array
before(async () => {
  wasm = await loadWalletWasm()
  // Unmodified synthetic bytes from the WASM repository's
  // crates/pczt-signer-core/tests/fixtures/ironwood_1action.hex; pinned below by its upstream sighash.
  fixture = hexToBytes(
    (await readFile(new URL('./fixtures/ironwood_1action.hex', import.meta.url), 'utf8')).trim()
  )
})

async function rig(shape: Shape = { participants: 2, threshold: 2 }, selectedSlots = [0, 1]) {
  const handler = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  const { sessionId } = await handler.handle('vault.dkg.open', {
    ...shape,
    ownerWalletId: 'wallet-1',
    groupId: 'group-1',
    mainnet: false
  })
  const phones = Array.from(
    { length: shape.participants - 1 },
    (_, i) => new Phone(wasm, shape, i + 1, sessionId)
  )
  const r2 = await runRounds(wasm, handler, shape, sessionId, phones)
  for (const phone of phones)
    phone.finish(r2.inboxes[String(phone.slot)], r2.sealedQsk[String(phone.slot)], false)
  const opened = await openVaultRecord(r2.record, TEST_MNEMONIC)
  const backup = wasm.ShareBackup.from_bytes(
    opened.share,
    hexToBytes(opened.header.groupVerifyingKey),
    0
  )
  const keyPackage = backup.key_package()
  backup.free()
  opened.share.fill(0)
  const identities = await Promise.all(
    Array.from({ length: shape.participants }, (_, i) =>
      identityFromSeed(new Uint8Array(32).fill(i + 1))
    )
  )
  const roster = buildRoster({
    groupId: 'group-1',
    threshold: shape.threshold,
    identities: new Map(identities.map((id, i) => [i, bytesToBase64(id.publicKey)]))
  })
  const markers: string[] = []
  const scope = {
    walletId: 'wallet-1',
    accountId: 'multi-1',
    network: 'testnet' as const,
    groupId: 'group-1',
    rosterVersion: 1
  }
  let time = 100
  const options: signing.SigningCoordinatorOptions = {
    scope,
    binding: {
      ...scope,
      reviewId: 'review-1',
      pcztDigest: bytesToHex(sha256(fixture)),
      sessionId: bytesToBase64(wasm.EnvelopeCodec.new_session_id()),
      expiresAt: 300100,
      selectedSlots
    },
    roster,
    identity: identities[0],
    keyPackage,
    publicKeyPackage: base64ToBytes(opened.header.publicKeyPackage),
    groupVerifyingKey: hexToBytes(opened.header.groupVerifyingKey),
    pczt: fixture,
    transport: 'qr',
    persistNoncePhase: async phase => {
      markers.push(phase)
    },
    now: () => time
  }
  const cryptoBoundaryWasm = createProtocolOnlySigningWasm(wasm)
  const senders = identities.map((id, slot) =>
    createEnvelopeSigner({
      groupId: scope.groupId,
      sessionId: options.binding.sessionId,
      senderId: `device-${slot + 1}`,
      signingKey: id.signingKeys.privateKey
    })
  )
  const signers = new Map<number, InstanceType<typeof wasm.Signer>>()
  const reply = async (
    slot: number,
    type: 'SIGN_COMMITMENTS' | 'SIGN_SHARE' | 'SIGN_REJECT',
    inner: Uint8Array
  ) => senders[slot].next(type, 'device-1', { envelope: bytesToBase64(inner) })
  return {
    options,
    cryptoBoundaryWasm,
    identities,
    markers,
    advanceTime: (n: number) => {
      time += n
    },
    reply,
    async commitments(outbound: import('../../../src/core/multisig/messages').MultisigEnvelope[]) {
      return Promise.all(
        outbound.map(async envelope => {
          const slot = Number(envelope.recipient_id.slice(7)) - 1
          const signer = new wasm.Signer(
            base64ToBytes(options.binding.sessionId),
            slot,
            shape.participants,
            phones[slot - 1].keyPackage()
          )
          signers.set(slot, signer)
          return reply(
            slot,
            'SIGN_COMMITMENTS',
            signer.init(parseSignEnvelopePayload(JSON.parse(envelope.encrypted_payload))!)
          )
        })
      )
    },
    async shares(outbound: import('../../../src/core/multisig/messages').MultisigEnvelope[]) {
      return Promise.all(
        outbound.map(async envelope => {
          const slot = Number(envelope.recipient_id.slice(7)) - 1
          const signer = signers.get(slot)!
          const payload = parseSignPayload(JSON.parse(envelope.encrypted_payload))!
          signer.payload(payload.envelope)
          signer.approve()
          return reply(slot, 'SIGN_SHARE', signer.share())
        })
      )
    }
  }
}

async function completeSession(r: Awaited<ReturnType<typeof rig>>) {
  const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  let step = await session.start()
  for (const reply of await r.commitments(step.outbound)) step = await session.ingest(reply)
  for (const reply of await r.shares(step.outbound)) step = await session.ingest(reply)
  return session
}

test('the real PCZT fixture is admitted and its sighash stays pinned', () => {
  wasm.PcztTools.check(fixture)
  assert.equal(
    bytesToHex(wasm.PcztTools.shielded_sighash(fixture)),
    '4b61072777d3c452120cceaa472a2e82d28a0387b4dd49e17f06dd606f6d1f9c'
  )
})

for (const [participants, threshold, selected] of [
  [2, 2, [0, 1]],
  [3, 2, [0, 1]],
  [3, 2, [0, 2]],
  [3, 3, [0, 1, 2]]
] as const) {
  test(`real threshold engine signs ${threshold}/${participants} with ${selected} (PCZT adapter boundary)`, async () => {
    const r = await rig({ participants, threshold }, [...selected])
    const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
    const started = await session.start()
    assert.deepEqual(r.markers, ['created', 'committed'])
    for (const envelope of started.outbound)
      assert(await verifyEnvelope(envelope, r.identities[0].publicKey.slice(1, 33)))
    const commitments = await r.commitments(started.outbound)
    let step = started
    for (const envelope of commitments) step = await session.ingest(envelope)
    assert.deepEqual(r.markers, ['created', 'committed', 'consumed'])
    const shares = await r.shares(step.outbound)
    for (const envelope of shares) step = await session.ingest(envelope)
    assert.equal(step.status.phase, 'signed')
    assert.deepEqual(step.status.sharedSlots, [...selected])
    assert(session.takeSignedPczt() instanceof Uint8Array)
    assert.equal(session.takeSignedPczt(), null)
    const result = await session.reportResult('broadcast', new Uint8Array(32).fill(3))
    assert(result.every(envelope => envelope.message_type === 'SIGN_RESULT'))
    session.cancel()
  })
}

test('signer selection must include extension exactly once and match threshold', async () => {
  for (const selected of [[1, 2], [0, 0], [0], [0, 1, 2]]) {
    const r = await rig({ participants: 3, threshold: 2 }, selected)
    await assert.rejects(signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options))
    assert.deepEqual(r.markers, [])
  }
})

test('scope or reviewed PCZT changes are refused before any nonce', async () => {
  const r = await rig()
  for (const options of [
    { ...r.options, scope: { ...r.options.scope, accountId: 'other' } },
    { ...r.options, binding: { ...r.options.binding, pcztDigest: '0'.repeat(64) } }
  ])
    await assert.rejects(signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, options))
  await assert.rejects(signing.SigningCoordinatorSession.open(wasm, r.options)) // real fixture has different ak
  assert.deepEqual(r.markers, [])
})

test('each durable marker failure burns the session without releasing the next material', async () => {
  for (const failed of ['created', 'committed', 'consumed']) {
    const r = await rig()
    r.options.persistNoncePhase = async phase => {
      r.markers.push(phase)
      if (phase === failed) throw new Error('storage unavailable')
    }
    const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
    if (failed !== 'consumed') await assert.rejects(session.start())
    else {
      const start = await session.start()
      const [commitment] = await r.commitments(start.outbound)
      await assert.rejects(session.ingest(commitment))
    }
    assert.equal(session.status().phase, 'aborted')
    assert.equal(session.takeSignedPczt(), null)
  }
})

test('concurrent identical replies are idempotent and altered replay burns the session', async () => {
  const r = await rig()
  const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  const [commitment] = await r.commitments((await session.start()).outbound)
  const steps = await Promise.all([session.ingest(commitment), session.ingest(commitment)])
  assert.deepEqual(steps[0].outbound, steps[1].outbound)
  assert.deepEqual(r.markers, ['created', 'committed', 'consumed'])
  await assert.rejects(session.ingest({ ...commitment, encrypted_payload: '{}' }))
  assert.equal(session.status().phase, 'aborted')
})

test('late replies and cancellation while persistence waits cannot produce a share', async () => {
  const r = await rig()
  const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  const [commitment] = await r.commitments((await session.start()).outbound)
  r.advanceTime(300001)
  await assert.rejects(session.ingest(commitment))
  assert.equal(session.status().phase, 'aborted')
  const other = await rig()
  let release!: () => void
  other.options.persistNoncePhase = async () =>
    new Promise<void>(resolve => {
      release = resolve
    })
  const cancelled = await signing.SigningCoordinatorSession.open(
    other.cryptoBoundaryWasm,
    other.options
  )
  const pending = cancelled.start()
  await new Promise(resolve => setImmediate(resolve))
  cancelled.cancel()
  release()
  await assert.rejects(pending)
  assert.equal(cancelled.status().phase, 'aborted')
})

test('signing payload bounds differ from DKG and preserve both siblings', () => {
  assert.equal(parseSignPayload({ envelope: 'AA==', pczt: 'AA==' })?.pczt.length, 1)
  assert.equal(parseSignPayload({ envelope: 'AA==' }), null)
  assert.equal(parseSignPayload({ envelope: 'AA==', pczt: 'A'.repeat(262148) }), null)
  assert.equal(parseSignPayload({ envelope: 'A', pczt: 'AA==' }), null)
})

test('an authenticated refusal ends the whole fixed selection', async () => {
  const r = await rig({ participants: 3, threshold: 2 }, [0, 2])
  const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  await session.start()
  const reject = wasm.EnvelopeCodec.buildSignReject(
    base64ToBytes(r.options.binding.sessionId),
    2,
    wasm.EnvelopeCodec.coordinator_slot,
    1,
    1,
    ''
  )
  const step = await session.ingest(await r.reply(2, 'SIGN_REJECT', reject))
  assert.equal(step.status.phase, 'aborted')
  assert.deepEqual(r.markers, ['created', 'committed'])
  assert.equal(session.takeSignedPczt(), null)
})

test('outer identity cannot conceal a mismatched inner sender or session', async () => {
  for (const innerMismatch of ['sender', 'session']) {
    const r = await rig()
    const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
    const [commitment] = await r.commitments((await session.start()).outbound)
    const inner = parseSignEnvelopePayload(JSON.parse(commitment.encrypted_payload))!
    const tuple = wasm.EnvelopeCodec.readSigning(inner)
    const wrong = wasm.EnvelopeCodec.buildSigning(
      tuple[0],
      innerMismatch === 'sender' ? 0 : tuple[2],
      tuple[3],
      tuple[4],
      innerMismatch === 'session' ? new Uint8Array(16) : tuple[5],
      tuple[6]
    )
    await assert.rejects(session.ingest(await r.reply(1, 'SIGN_COMMITMENTS', wrong)))
    assert.equal(session.status().phase, 'aborted')
  }
})

test('inputs are copied before the first await, including roster and secret bytes', async () => {
  const r = await rig()
  r.options.pczt = fixture.slice()
  const opening = signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  r.options.pczt.fill(0)
  r.options.keyPackage.fill(0)
  r.options.publicKeyPackage.fill(0)
  r.options.binding.selectedSlots = [1, 2]
  r.options.roster.participants[1].identityPublicKey =
    r.options.roster.participants[0].identityPublicKey
  const session = await opening
  assert.equal((await session.start()).outbound.length, 1)
  session.cancel()
})

test('oversized BLE carrier is refused before consuming the extension share', async () => {
  const r = await rig()
  r.options.transport = 'ble'
  r.options.pczt = new Uint8Array(60000)
  r.options.binding.pcztDigest = bytesToHex(sha256(r.options.pczt))
  const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  const [commitment] = await r.commitments((await session.start()).outbound)
  await assert.rejects(session.ingest(commitment))
  assert.deepEqual(r.markers, ['created', 'committed'])
  assert.equal(session.status().phase, 'aborted')
})

test('signed outcome survives signing expiry and unknown submission never becomes a failure result', async () => {
  const r = await rig()
  r.options.transport = 'ble'
  const session = await completeSession(r)
  assert.deepEqual(await session.reportResult('unknown'), [])
  r.advanceTime(300001)
  const results = await session.reportResult('broadcast', new Uint8Array(32).fill(8))
  assert.equal(results.length, 1)
  const inner = parseSignEnvelopePayload(JSON.parse(results[0].encrypted_payload))!
  const decoded = wasm.EnvelopeCodec.readSignResult(inner)
  assert.equal(decoded[0], 254)
  assert.equal(decoded[3], 0)
  session.cancel()
  assert.equal(session.status().phase, 'signed')
})

test('untrusted outer context never advances beyond committed', async () => {
  for (const change of [
    { group_id: 'another-group' },
    { session_id: 'another-session' },
    { sender_id: 'device-3' },
    { recipient_id: 'device-2' },
    { authentication_data: bytesToBase64(new Uint8Array(64)) },
    { round: 3 }
  ]) {
    const r = await rig()
    const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
    const [commitment] = await r.commitments((await session.start()).outbound)
    await assert.rejects(session.ingest({ ...commitment, ...change }))
    assert.deepEqual(r.markers, ['created', 'committed'])
    assert.equal(session.status().phase, 'aborted')
  }
})

test('invalid native tuple shapes burn the session instead of trusting generated any[]', async () => {
  const r = await rig()
  const session = await signing.SigningCoordinatorSession.open(
    {
      ...r.cryptoBoundaryWasm,
      Coordinator: class extends wasm.Coordinator {
        override init_all() {
          return [[1, 'not bytes']]
        }
      }
    },
    r.options
  )
  await assert.rejects(session.start())
  assert.equal(session.status().phase, 'aborted')
})

test('expiry callback burns the active round without waiting for another request', async () => {
  const r = await rig()
  let expire!: () => void
  r.options.schedule = callback => {
    expire = callback
    return () => {}
  }
  const session = await signing.SigningCoordinatorSession.open(r.cryptoBoundaryWasm, r.options)
  await session.start()
  expire()
  assert.equal(session.status().phase, 'aborted')
  assert.equal(session.takeSignedPczt(), null)
})

test('closing while signing a result carrier cannot emit a late result', async () => {
  const r = await rig()
  r.options.transport = 'ble'
  const session = await completeSession(r)
  const pending = session.reportResult('broadcast', new Uint8Array(32).fill(4))
  await Promise.resolve()
  session.cancel()
  await assert.rejects(pending)
  assert.equal(session.status().phase, 'signed')
})
