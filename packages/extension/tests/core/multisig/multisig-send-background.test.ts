import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMultisigSendHandler,
  type MultisigSendDeps
} from '../../../src/background/multisig-send'
import { createSigningJournal } from '../../../src/lib/multisig-signing-storage'
import {
  createMultisigTransactionJournal,
  recordFinalizationReceipt,
  recordProtectedSnapshotVerified,
  recordDurableFinalization
} from '../../../src/lib/multisig-transaction-storage'
import { signingIntentBinding } from '../../../src/core/multisig/signing-journal'
import { installStorageEnv } from './helpers/storage-env'
import { createEnvelopeFactory } from '../../../src/core/multisig/messages'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'
import { readFile } from 'node:fs/promises'
import { createSigningWorkerRpcHandler } from '../../../src/core/multisig/signing-worker-rpc'
import { loadVaultWasm } from './helpers/vault-wasm'
import { parseVaultSendPrepare, parseVaultSendAuthority } from '../../../src/core/multisig/send-rpc'
import { CredentialSessionHost } from '../../../src/infrastructure/keyring/session/credential-session-host'
import { realReviewFixture, createProtocolOnlySigningWasm } from './helpers/signing-worker'
import { base64ToBytes, bytesToBase64 } from '../../../src/lib/bytes'
import { createEnvelopeSigner } from '../../../src/core/multisig/envelope-signing'
import { parseSignEnvelopePayload } from '../../../src/core/multisig/sign-protocol'
import { buildRoster } from '../../../src/core/multisig/roster'
import { generateDeviceIdentity } from '../../../src/core/multisig/identity'
import { createMultisigTransactionController } from '../../../src/background/multisig-transaction'
import { projectMultisigActivity } from '../../../src/background/multisig-activity'

const NOW = 1_800_000_000_000
const scope = { walletId: 'w', accountId: 'a', network: 'testnet' as const }
const draft = {
  scope,
  groupId: 'group',
  rosterVersion: 1 as const,
  to: 'utest1synthetic',
  amountZats: '1000',
  memo: 'memo',
  marginalFeeZats: 5000,
  feeQuoteId: 'quote',
  selectedSlots: [0, 2],
  transport: 'qr' as const
}
const binding = {
  ...scope,
  groupId: 'group',
  rosterVersion: 1,
  reviewId: 'review',
  pcztDigest: 'ab'.repeat(32),
  sessionId: 'AAAAAAAAAAAAAAAAAAAAAA==',
  selectedSlots: [0, 2],
  expiresAt: NOW + 300_000
}
const authority = { walletId: 'w', reviewId: 'review', sessionId: binding.sessionId }
const fixture = JSON.parse(
  await readFile(new URL('./fixtures/vault-record-v1.json', import.meta.url), 'utf8')
).record
let env: ReturnType<typeof installStorageEnv>
beforeEach(() => {
  env = installStorageEnv()
})
afterEach(() => {
  env.restore()
})

test('send scope identifiers follow the account domain rather than transport token limits', () => {
  const walletId = 'wallet:' + 'w'.repeat(400),
    accountId = 'account:' + 'a'.repeat(400)
  const parsed = parseVaultSendPrepare({ ...draft, scope: { ...scope, walletId, accountId } })
  assert.equal(parsed.scope.walletId, walletId)
  assert.equal(parsed.scope.accountId, accountId)
  assert.equal(parseVaultSendAuthority({ ...authority, walletId }).walletId, walletId)
  assert.throws(() =>
    parseVaultSendPrepare({ ...draft, scope: { ...scope, accountId: 'a'.repeat(513) } })
  )
})

function setup() {
  let available = false,
    now = NOW,
    failClose = false,
    failInvalidate = false
  let pending = 0
  let bindCalls = 0
  const calls: string[] = []
  const journal = createSigningJournal()
  const record: SealedVaultRecord = {
    ...fixture,
    version: 2,
    network: scope.network,
    accountId: scope.accountId,
    ownerWalletId: 'w',
    groupId: 'group'
  }
  const state = {
    network: 'testnet',
    activeWalletId: 'w',
    activeAccountId: 'a',
    unlocked: true,
    source: { kind: 'frost-vault', version: 1, groupId: 'group', network: 'testnet' }
  }
  const response = () => ({
    binding,
    status: {
      sessionId: binding.sessionId,
      phase: pending < 3 ? 'created' : 'commitments',
      selectedSlots: [0, 2],
      committedSlots: [],
      sharedSlots: []
    },
    outbound: [],
    ...(pending < 3
      ? {
          persistence: {
            ackId: `ack-${pending}`,
            phase: ['created', 'committed', 'consumed'][pending]
          }
        }
      : {})
  })
  const deps: MultisigSendDeps = {
    now: () => now,
    journal,
    transactions: createMultisigTransactionJournal(),
    withScope: async (_scope, run) => run(),
    readWalletState: async () => ({
      network: state.network as 'testnet',
      activeWalletId: state.activeWalletId,
      activeAccountId: state.activeAccountId,
      wallets: [{ id: 'w', software: true, accounts: [{ id: 'a', source: state.source }] }]
    }),
    isUnlocked: async () => state.unlocked,
    bindCredential: async () => {
      bindCalls += 1
      return true
    },
    getCredentialBinding: async () => ({
      kind: 'credential' as const,
      keyDomainId: 'w',
      credentialGenerationId: 'generation-1',
      globalUnlockEpoch: 'unlock-1'
    }),
    readRecord: async () => record,
    readGroup: async () => ({
      groupId: 'group',
      threshold: '2-of-3',
      fingerprint: 'ab'.repeat(32),
      transportKind: 'qr',
      devices: [],
      createdAt: NOW,
      mock: false
    }),
    readCreationReady: async () => true,
    getFeeQuote: async () => ({
      id: 'quote',
      standardMarginalFeeZats: 5000,
      expiresAt: NOW + 300_000
    }),
    forwardToWorker: async (method, payload) => {
      calls.push(method)
      if (method.endsWith('.invalidate')) {
        if (failInvalidate) throw new Error('still live')
        return true
      }
      if (method.endsWith('.close')) {
        if (failClose) throw new Error('still live')
        return true
      }
      if (method.endsWith('.prepare'))
        return available
          ? {
              available: true,
              binding,
              threshold: '2-of-3',
              transport: 'qr',
              createdAt: NOW,
              summary: { recipient: draft.to, amount: draft.amountZats, memo: 'memo', fee: '10000' }
            }
          : { available: false, reason: 'pczt_review_unavailable' }
      if (method.endsWith('.advance')) {
        const ack = (
          payload as { acknowledgement: { ackId: string; phase: string; persisted: boolean } }
        ).acknowledgement
        assert.deepEqual(ack, {
          ackId: `ack-${pending}`,
          phase: ['created', 'committed', 'consumed'][pending],
          persisted: true
        })
        const intent = (await journal.listSigningIntents())[0]
        assert.equal(
          intent.noncePhase,
          ack.phase,
          'Worker acknowledgements follow durable journal readback'
        )
        pending += 1
      }
      return response()
    }
  }
  return {
    deps,
    handler: createMultisigSendHandler(deps),
    journal,
    calls,
    state,
    record,
    setAvailable: () => {
      available = true
    },
    setTime: (value: number) => {
      now = value
    },
    failClose: () => {
      failClose = true
    },
    failInvalidate: () => {
      failInvalidate = true
    },
    bindCalls: () => bindCalls
  }
}

test('production prepare unavailable never reserves signing authority or begins a nonce', async () => {
  const s = setup()
  let credentialReads = 0
  const worker = createSigningWorkerRpcHandler(await loadVaultWasm(), {
    credential: () => {
      credentialReads += 1
      return null
    },
    network: () => 'testnet',
    identity: async () => null,
    reviewProvider: { available: false }
  })
  s.deps.forwardToWorker = async (method, payload) => {
    s.calls.push(method)
    return worker.handle(method, payload)
  }
  assert.deepEqual(await s.handler.handle('vault.send.prepare', draft), {
    available: false,
    reason: 'pczt_review_unavailable'
  })
  assert.deepEqual(await s.journal.listSigningIntents(), [])
  assert.equal(
    credentialReads,
    0,
    'the unavailable review capability cannot open share/nonce authority'
  )
  assert.equal(
    s.calls.some(method => /\.(start|advance|ingest)$/.test(method)),
    false
  )
  await assert.rejects(s.handler.handle('vault.send.start', authority))
})

test('startup with no signing journal does not wake Worker; active recovery confirms invalidation before interruption', async () => {
  const s = setup()
  await s.handler.recoverPending()
  assert.deepEqual(s.calls, [])
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  s.calls.length = 0
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = async (method, payload) => {
    if (method.endsWith('.invalidate'))
      assert.equal((await s.journal.listSigningIntents())[0].phase, 'review_ready')
    return forward(method, payload)
  }
  const recovered = createMultisigSendHandler({ ...s.deps, journal: createSigningJournal() })
  await recovered.recoverPending()
  assert.deepEqual(s.calls, ['vault.sign.worker.invalidate'])
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'interrupted')
  const status = await recovered.handle('vault.send.status', authority)
  assert.equal(status.phase, 'interrupted')
  assert.equal(status.status, null)
  assert.deepEqual(status.outbound, [])
  // Metadata-only lifecycle calls cannot wake an otherwise idle Worker either.
  s.calls.length = 0
  await recovered.invalidate()
  assert.deepEqual(s.calls, [])
})

test('malformed drafts and inactive, changed network/source/group scopes never reach Worker prepare', async () => {
  for (const patch of [
    { amountZats: '1.0' },
    { selectedSlots: [1, 2] },
    { selectedSlots: [0, 0] },
    { memo: 'x'.repeat(513) },
    { groupId: 'other' },
    { rosterVersion: 2 },
    { source: 'injected' }
  ]) {
    const s = setup()
    await assert.rejects(s.handler.handle('vault.send.prepare', { ...draft, ...patch }))
    assert.equal(
      s.calls.some(method => method.endsWith('.prepare')),
      false
    )
  }
  for (const change of [
    (s: ReturnType<typeof setup>) => {
      s.state.activeAccountId = 'other'
    },
    (s: ReturnType<typeof setup>) => {
      s.state.network = 'mainnet'
    },
    (s: ReturnType<typeof setup>) => {
      s.state.source.groupId = 'other'
    },
    (s: ReturnType<typeof setup>) => {
      s.state.unlocked = false
    }
  ]) {
    const s = setup()
    change(s)
    await assert.rejects(s.handler.handle('vault.send.prepare', draft))
    assert.equal(
      s.calls.some(method => method.endsWith('.prepare')),
      false
    )
  }
})

test('a page cannot mint a fee quote or alter a trusted prepared binding', async () => {
  const s = setup()
  s.setAvailable()
  assert.deepEqual(
    await s.handler.handle('vault.send.prepare', { ...draft, feeQuoteId: 'minted' }),
    { available: false, reason: 'fee_quote_unavailable' }
  )
  assert.deepEqual(await s.journal.listSigningIntents(), [])
  await s.handler.handle('vault.send.prepare', draft)
  for (const patch of [
    { walletId: 'other' },
    { reviewId: 'other' },
    { sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ==' },
    { selectedSlots: [0, 1] }
  ])
    await assert.rejects(s.handler.handle('vault.send.start', { ...authority, ...patch }))
})

test('public signing roster requires live review authority and never survives a rejected unlock check', async () => {
  const s = setup()
  s.setAvailable()
  const identities = await Promise.all([
    generateDeviceIdentity(),
    generateDeviceIdentity(),
    generateDeviceIdentity()
  ])
  const expectedRoster = buildRoster({
    groupId: 'group',
    threshold: 2,
    identities: new Map(
      identities.map((identity, slot) => [slot, bytesToBase64(identity.publicKey)])
    )
  })
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = (method, payload) =>
    method === 'vault.sign.worker.roster'
      ? Promise.resolve(expectedRoster)
      : forward(method, payload)
  await s.handler.handle('vault.send.prepare', draft)
  const roster = await s.handler.handle('vault.send.roster', authority)
  assert.deepEqual(roster, expectedRoster)
  assert.equal('sealed_share' in roster, false)
  s.state.unlocked = false
  await assert.rejects(s.handler.handle('vault.send.roster', authority))
  s.state.unlocked = true
  // A rejected operation invalidates this review; never reuse it after unlocking.
  await assert.rejects(s.handler.handle('vault.send.roster', authority))
})

test('nonce acknowledgement and cancellation preserve consumed markers', async () => {
  const s = setup()
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  const result = await s.handler.handle('vault.send.start', authority)
  assert.equal(result.noncePhase, 'consumed')
  assert.equal(result.phase, 'signing')
  assert.equal(s.calls.filter(method => method.endsWith('.advance')).length, 3)
  assert.equal(
    s.bindCalls(),
    1,
    'read-only authority checks cannot rebind and destroy the live Worker credential'
  )
  await s.handler.handle('vault.send.cancel', authority)
  assert.equal(await s.handler.handle('vault.send.cancel', authority), true)
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'cancelled')
  assert.equal((await s.journal.listSigningIntents())[0].noncePhase, 'consumed')
  await assert.rejects(
    s.handler.handle('vault.send.ingest', {
      ...authority,
      envelope: createEnvelopeFactory({
        groupId: 'group',
        sessionId: binding.sessionId,
        senderId: 'device-3'
      })('SIGN_SHARE', 'device-1', {})
    })
  )
})

test('real credential host attestation preserves one bound Worker session through native nonce ACKs and real rebind destroys it (TEST-ONLY PCZT adapter)', async () => {
  const rig = await realReviewFixture()
  const native = createProtocolOnlySigningWasm(rig.wasm)
  const pczt = Uint8Array.from(
    Buffer.from(
      (await readFile(new URL('./fixtures/ironwood_1action.hex', import.meta.url), 'utf8')).trim(),
      'hex'
    )
  )
  let credential = rig.credential,
    binds = 0,
    multichainUnlocked = false
  const worker = createSigningWorkerRpcHandler(native, {
    credential: () => credential,
    network: () => rig.request.scope.network,
    identity: async () => rig.identities[0],
    now: () => NOW,
    reviewProvider: {
      available: true,
      prepare: async ({ intent }) => ({
        pczt: pczt.slice(),
        summary: {
          recipient: intent.recipient,
          amount: intent.amount,
          memo: intent.memo,
          fee: '10000'
        },
        reviewedChainPolicy: { expiryHeight: 4_134_041, consensusBranchId: 0x37a5165b }
      })
    }
  })
  const host = new CredentialSessionHost({
    now: () => NOW,
    capsules: {
      seal: async (_master, _epoch, _password, credentials) =>
        credentials.map(item => ({
          schemaVersion: 1 as const,
          keyDomainId: item.keyDomainId,
          credentialGenerationId: item.credentialGenerationId,
          iv: new Uint8Array(12),
          ciphertext: new Uint8Array(32)
        }))
    },
    multichain: {
      unlock: async () => {
        multichainUnlocked = true
      },
      getState: async () => (multichainUnlocked ? 'unlocked' : 'locked'),
      lockAll: async () => {
        multichainUnlocked = false
      },
      forceRestart: () => {
        multichainUnlocked = false
      }
    },
    zcash: {
      bind: async input => {
        // This is the actual credential host callback chain's important side effect: even a
        // same-descriptor rebind replaces the immutable Worker credential and cancels its session.
        binds += 1
        worker.invalidate()
        credential = {
          keyDomainId: input.keyDomainId,
          credentialGenerationId: input.credentialGenerationId,
          globalUnlockEpoch: input.globalUnlockEpoch,
          mnemonic: rig.credential.mnemonic
        }
      },
      getState: async input =>
        input.keyDomainId === credential.keyDomainId &&
        input.credentialGenerationId === credential.credentialGenerationId &&
        input.globalUnlockEpoch === credential.globalUnlockEpoch
          ? 'unlocked'
          : 'locked',
      lockAll: async () => {
        worker.invalidate()
      },
      forceRestart: () => {
        worker.invalidate()
      }
    }
  })
  const descriptor = await host.unlock({
    password: 'credential-session-password',
    lastUserActivityAt: NOW,
    expiresAt: NOW + 300_000,
    credentials: [
      {
        keyDomainId: rig.request.scope.walletId,
        credentialGenerationId: rig.credential.credentialGenerationId,
        zcashEnvelope: {
          encryptedData: 'AAAAAAAAAAAAAAAAAAAAAA==',
          salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
          iv: 'AAAAAAAAAAAAAAAA'
        },
        multichainVault: {
          version: 1,
          kdf: 'argon2id',
          kdfParams: { memoryKib: 19 * 1024, iterations: 2, parallelism: 1 },
          cipher: 'xchacha20poly1305',
          salt: '00'.repeat(16),
          nonce: '00'.repeat(24),
          ciphertext: '00'.repeat(16)
        }
      }
    ]
  })
  const journal = createSigningJournal()
  const acknowledgements: string[] = []
  let lastAck:
    | { ackId: string; phase: 'created' | 'committed' | 'consumed'; persisted: boolean }
    | undefined
  const s = setup()
  const handler = createMultisigSendHandler({
    ...s.deps,
    journal,
    readWalletState: async () => ({
      network: 'testnet',
      activeWalletId: rig.request.scope.walletId,
      activeAccountId: rig.request.scope.accountId,
      wallets: [
        {
          id: rig.request.scope.walletId,
          software: true,
          accounts: [{ id: rig.request.scope.accountId, source: rig.request.source }]
        }
      ]
    }),
    readRecord: async () => rig.request.sealedRecord,
    readGroup: async () => ({
      groupId: rig.request.scope.groupId,
      threshold: '2-of-2',
      fingerprint: rig.fingerprint,
      transportKind: 'qr',
      devices: [],
      createdAt: NOW,
      mock: false
    }),
    bindCredential: async walletId => {
      await host.bindZcashCredential(descriptor, walletId)
      return true
    },
    getCredentialBinding: async walletId => {
      const attested = await host.attest(descriptor)
      const found = attested.unlockedCredentials.find(item => item.keyDomainId === walletId)!
      return { kind: 'credential', ...found, globalUnlockEpoch: attested.globalUnlockEpoch }
    },
    isUnlocked: async () => {
      await host.attest(descriptor)
      return true
    },
    forwardToWorker: async (method, payload) => {
      if (method === 'vault.sign.worker.advance') {
        lastAck = (payload as unknown as { acknowledgement: NonNullable<typeof lastAck> })
          .acknowledgement
        assert.equal((await journal.listSigningIntents())[0].noncePhase, lastAck.phase)
        acknowledgements.push(lastAck.phase)
      }
      return worker.handle(method, payload)
    }
  })
  const request = {
    ...draft,
    scope: {
      walletId: rig.request.scope.walletId,
      accountId: rig.request.scope.accountId,
      network: 'testnet' as const
    },
    groupId: rig.request.scope.groupId,
    selectedSlots: [0, 1]
  }
  const reviewed = await handler.handle('vault.send.prepare', request)
  assert.equal(reviewed.available, true)
  if (!reviewed.available) throw new Error('missing test-only review')
  const reference = {
    walletId: request.scope.walletId,
    reviewId: reviewed.binding.reviewId,
    sessionId: reviewed.binding.sessionId
  }
  const authenticatedRoster = await handler.handle('vault.send.roster', reference)
  assert.deepEqual(
    authenticatedRoster.participants.map(participant => participant.identityPublicKey),
    rig.identities.map(identity => bytesToBase64(identity.publicKey))
  )
  assert.deepEqual(Object.keys(authenticatedRoster).sort(), [
    'ciphersuite',
    'groupId',
    'participants',
    'protocolVersion',
    'rosterHash',
    'threshold'
  ])
  const started = await handler.handle('vault.send.start', reference)
  assert.deepEqual(acknowledgements, ['created', 'committed'])
  const phone = new rig.wasm.Signer(
    base64ToBytes(reference.sessionId),
    1,
    2,
    rig.phones[0].keyPackage()
  )
  try {
    const commitment = phone.init(
      parseSignEnvelopePayload(JSON.parse(started.outbound[0].encrypted_payload))!
    )
    const signer = createEnvelopeSigner({
      groupId: request.groupId,
      sessionId: reference.sessionId,
      senderId: 'device-2',
      signingKey: rig.identities[1].signingKeys.privateKey
    })
    await handler.handle('vault.send.ingest', {
      ...reference,
      envelope: await signer.next('SIGN_COMMITMENTS', 'device-1', {
        envelope: bytesToBase64(commitment)
      })
    })
    assert.deepEqual(acknowledgements, ['created', 'committed', 'consumed'])
    assert.equal(binds, 1)
    await host.bindZcashCredential(descriptor, request.scope.walletId)
    assert.equal(binds, 2)
    await assert.rejects(
      worker.handle('vault.sign.worker.advance', { ...reference, acknowledgement: lastAck! })
    )
    await assert.rejects(worker.handle('vault.sign.worker.roster', reference))
    await assert.rejects(handler.handle('vault.send.start', reference))
    assert.equal(binds, 2)
    const intent = (await journal.listSigningIntents())[0]
    assert.equal(intent.phase, 'interrupted')
    assert.equal(intent.noncePhase, 'consumed')
  } finally {
    phone.free()
    await host.lock()
  }
})

test('durable write failure closes Worker before releasing the account and never acknowledges the failed edge', async () => {
  const s = setup()
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  const original = s.journal.advanceSigningIntent
  s.journal.advanceSigningIntent = async (...args) => {
    if (args[1].nextNoncePhase === 'created') throw new Error('readback failed')
    if (args[1].nextPhase === 'interrupted') assert.equal(s.calls.at(-1), 'vault.sign.worker.close')
    return original(...args)
  }
  await assert.rejects(s.handler.handle('vault.send.start', authority))
  assert.equal(
    s.calls.some(method => method.endsWith('.advance')),
    false
  )
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'interrupted')
})

test('forged Worker binding, skipped nonce phase and premature transport output cannot receive an acknowledgement', async () => {
  for (const mutation of ['binding', 'skip', 'outbound']) {
    env.store.clear()
    const s = setup()
    s.setAvailable()
    await s.handler.handle('vault.send.prepare', draft)
    const forward = s.deps.forwardToWorker
    s.deps.forwardToWorker = async (method, payload) => {
      const raw = await forward(method, payload)
      if (!method.endsWith('.start')) return raw
      const reply = raw as {
        binding: typeof binding
        persistence: { ackId: string; phase: string }
        outbound: unknown[]
      }
      if (mutation === 'binding') reply.binding = { ...reply.binding, pcztDigest: 'cd'.repeat(32) }
      if (mutation === 'skip') reply.persistence = { ...reply.persistence, phase: 'consumed' }
      if (mutation === 'outbound')
        reply.outbound = [
          createEnvelopeFactory({
            groupId: 'group',
            sessionId: binding.sessionId,
            senderId: 'device-1'
          })('SIGN_COMMIT_REQ', 'device-3', {})
        ]
      return reply
    }
    await assert.rejects(s.handler.handle('vault.send.start', authority))
    assert.equal(
      s.calls.some(method => method.endsWith('.advance')),
      false
    )
    assert.equal((await s.journal.listSigningIntents())[0].phase, 'interrupted')
  }
})

test('a changed active account after persistence cannot acknowledge a nonce or expose outbound bytes', async () => {
  const s = setup()
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  const advance = s.journal.advanceSigningIntent
  s.journal.advanceSigningIntent = async (...args) => {
    const result = await advance(...args)
    if (args[1].nextNoncePhase === 'created') s.state.activeAccountId = 'other'
    return result
  }
  await assert.rejects(s.handler.handle('vault.send.start', authority))
  assert.equal(
    s.calls.some(method => method.endsWith('.advance')),
    false
  )
  const intent = (await s.journal.listSigningIntents())[0]
  assert.equal(intent.phase, 'interrupted')
  assert.equal(intent.noncePhase, 'created')
})

test('credential generation, unlock epoch or selection changed during read-only attestation cannot start a nonce', async () => {
  for (const changed of ['generation', 'epoch', 'selection']) {
    env.store.clear()
    const s = setup()
    s.setAvailable()
    await s.handler.handle('vault.send.prepare', draft)
    const attest = s.deps.getCredentialBinding
    s.deps.getCredentialBinding = async walletId => {
      const binding = await attest(walletId)
      if (changed === 'selection') s.state.activeAccountId = 'other'
      return {
        ...binding,
        ...(changed === 'generation' ? { credentialGenerationId: 'generation-2' } : {}),
        ...(changed === 'epoch' ? { globalUnlockEpoch: 'unlock-2' } : {})
      }
    }
    await assert.rejects(s.handler.handle('vault.send.start', authority))
    assert.equal(
      s.calls.some(method => method.endsWith('.start')),
      false
    )
    assert.equal(s.bindCalls(), 1)
    assert.equal((await s.journal.listSigningIntents())[0].phase, 'interrupted')
  }
})

test('close failure keeps the signing slot active, and restart requires old Worker destruction before interruption', async () => {
  const s = setup()
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  s.failClose()
  await assert.rejects(s.handler.handle('vault.send.cancel', authority))
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'review_ready')
  s.failInvalidate()
  await assert.rejects(createMultisigSendHandler(s.deps).initialize())
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'review_ready')
  s.deps.forwardToWorker = async () => true
  const restarted = createMultisigSendHandler({ ...s.deps, journal: createSigningJournal() })
  await restarted.initialize()
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'interrupted')
  await assert.rejects(restarted.handle('vault.send.start', authority))
})

test('expired or changed sealed authority cannot create nonces, and restart exposes only interrupted public status', async () => {
  const s = setup()
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  s.setTime(binding.expiresAt)
  await assert.rejects(s.handler.handle('vault.send.start', authority))
  assert.equal(
    s.calls.some(method => method.endsWith('.start')),
    false
  )
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'expired')
  env.store.clear()
  const t = setup()
  t.setAvailable()
  await t.handler.handle('vault.send.prepare', draft)
  t.record.ciphertext = 'AA=='
  await assert.rejects(t.handler.handle('vault.send.start', authority))
  assert.equal(
    t.calls.some(method => method.endsWith('.start')),
    false
  )
})

test('a signed spend survives expiry, cancellation and restart without closing as an expired draft', async () => {
  const s = setup()
  s.setAvailable()
  let expire!: () => void
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    expire = callback
    return originalSetTimeout(callback, delay)
  }) as typeof setTimeout
  try {
    await s.handler.handle('vault.send.prepare', draft)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
  await s.handler.handle('vault.send.start', authority)
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = async (method, payload) => {
    if (method !== 'vault.sign.worker.status') return forward(method, payload)
    s.calls.push(method)
    return {
      binding,
      status: {
        sessionId: binding.sessionId,
        phase: 'signed',
        selectedSlots: [0, 2],
        committedSlots: [0, 2],
        sharedSlots: [0, 2]
      },
      outbound: []
    }
  }
  assert.equal((await s.handler.handle('vault.send.status', authority)).phase, 'signed')
  s.setTime(binding.expiresAt)
  expire()
  assert.equal((await s.handler.handle('vault.send.status', authority)).phase, 'signed')
  await assert.rejects(s.handler.handle('vault.send.cancel', authority))
  await assert.rejects(s.handler.handle('vault.send.start', authority))
  await assert.rejects(
    s.handler.handle('vault.send.ingest', {
      ...authority,
      envelope: createEnvelopeFactory({
        groupId: 'group',
        sessionId: binding.sessionId,
        senderId: 'device-3'
      })('SIGN_COMMITMENTS', 'device-1', {})
    })
  )
  assert.equal(s.calls.includes('vault.sign.worker.close'), false)
  assert.equal(s.calls.filter(method => method === 'vault.sign.worker.start').length, 1)
  await s.handler.invalidate()
  assert.equal(
    (
      await s.journal.readSigningIntent({
        ...binding,
        threshold: '2-of-3',
        transport: 'qr',
        createdAt: NOW
      })
    )?.phase,
    'signed'
  )
  const restarted = createMultisigSendHandler({ ...s.deps, journal: createSigningJournal() })
  await restarted.recoverPending()
  assert.equal((await restarted.handle('vault.send.status', authority)).phase, 'signed')
  await assert.rejects(restarted.handle('vault.send.cancel', authority))
  await assert.rejects(restarted.handle('vault.send.prepare', draft))
})

const finalizedReceipt = {
  txId: '13'.repeat(32),
  rawTxSha256: '24'.repeat(32),
  rawTxLen: 1234,
  network: 'testnet',
  accountId: 'a',
  snapshotSha256: '35'.repeat(32)
}

async function prepareSignedTransfer() {
  const s = setup()
  s.setAvailable()
  await s.handler.handle('vault.send.prepare', draft)
  await s.handler.handle('vault.send.start', authority)
  const intent = (await s.journal.listSigningIntents())[0]
  await s.journal.advanceSigningIntent(
    signingIntentBinding(intent),
    {
      expectedPhase: 'signing',
      expectedNoncePhase: 'consumed',
      nextPhase: 'signed',
      nextNoncePhase: 'consumed'
    },
    NOW
  )
  return s
}

// The Worker transport stub must acknowledge the same durable metadata as production Offscreen.
async function persistFinalizationReceipt() {
  const recoveryScope = {
    ...scope,
    reviewId: binding.reviewId,
    sessionId: binding.sessionId
  }
  await recordFinalizationReceipt(
    {
      ...recoveryScope,
      txId: finalizedReceipt.txId,
      rawTxSha256: finalizedReceipt.rawTxSha256,
      rawTxLen: finalizedReceipt.rawTxLen
    },
    NOW
  )
  const snapshot = {
    ...recoveryScope,
    txId: finalizedReceipt.txId,
    snapshotSha256: finalizedReceipt.snapshotSha256
  }
  await recordProtectedSnapshotVerified(snapshot, NOW)
  await recordDurableFinalization(snapshot, NOW)
  return finalizedReceipt
}

test('finalization persists the verified receipt and submission uncertainty precedes the network', async () => {
  const s = await prepareSignedTransfer()
  const forward = s.deps.forwardToWorker
  let finalizations = 0,
    submissions = 0
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') {
      finalizations++
      return persistFinalizationReceipt()
    }
    if (method === 'vault.sign.worker.submit') {
      assert.equal(payload.network, scope.network)
      submissions++
      const stored = (await s.deps.transactions.listTransactions())[0]
      assert.equal(stored.phase, 'submission_unknown')
      assert.equal(stored.rawTxSha256, finalizedReceipt.rawTxSha256)
      assert.equal(payload.snapshotSha256, finalizedReceipt.snapshotSha256)
      return { phase: 'broadcast', txId: finalizedReceipt.txId, outbound: [] }
    }
    return forward(method, payload)
  }
  assert.equal((await s.handler.handle('vault.send.finalize', authority)).phase, 'finalized')
  assert.equal((await s.handler.handle('vault.send.finalize', authority)).phase, 'finalized')
  assert.deepEqual(await s.handler.handle('vault.send.recovery', { scope }), {
    signedWithoutTransaction: false
  })
  assert.equal(finalizations, 1)
  assert.equal((await s.handler.handle('vault.send.submit', authority)).phase, 'broadcast')
  assert.equal((await s.handler.handle('vault.send.submit', authority)).phase, 'broadcast')
  assert.equal(submissions, 1)
})

test('finalization cannot mutate the Worker before reviewed recovery metadata is durable', async () => {
  const s = await prepareSignedTransfer()
  const originalSet = chrome.storage.local.set
  let finalizations = 0
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') {
      finalizations++
      return finalizedReceipt
    }
    return forward(method, payload)
  }
  chrome.storage.local.set = async () => {
    throw new Error('Storage unavailable before finalization')
  }
  try {
    await assert.rejects(s.handler.handle('vault.send.finalize', authority))
    assert.equal(finalizations, 0)
  } finally {
    chrome.storage.local.set = originalSet
  }
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'signed')
  assert.equal((await s.deps.transactions.listTransactions()).length, 0)
})

test('restart repairs a verified durable receipt without restoring submission authority', async () => {
  const s = await prepareSignedTransfer()
  const signed = signingIntentBinding((await s.journal.listSigningIntents())[0])
  const recoveryScope = {
    ...scope,
    reviewId: signed.reviewId,
    sessionId: signed.sessionId
  }
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = async (method, payload) => {
    if (method !== 'vault.sign.worker.finalize') return forward(method, payload)
    await recordFinalizationReceipt(
      {
        ...recoveryScope,
        txId: finalizedReceipt.txId,
        rawTxSha256: finalizedReceipt.rawTxSha256,
        rawTxLen: finalizedReceipt.rawTxLen
      },
      NOW
    )
    const snapshot = {
      ...recoveryScope,
      txId: finalizedReceipt.txId,
      snapshotSha256: finalizedReceipt.snapshotSha256
    }
    await recordProtectedSnapshotVerified(snapshot, NOW)
    await recordDurableFinalization(snapshot, NOW)
    return finalizedReceipt
  }
  s.deps.transactions.recordFinalized = async () => {
    throw new Error('Background transaction journal write failed')
  }
  await assert.rejects(s.handler.handle('vault.send.finalize', authority))
  assert.equal((await s.deps.transactions.listTransactions()).length, 0)
  const unverified = createMultisigSendHandler({
    ...s.deps,
    transactions: createMultisigTransactionJournal(),
    verifyFinalizationSnapshot: async () => {
      throw new Error('Protected snapshot does not match')
    }
  })
  assert.deepEqual(await unverified.handle('vault.send.transactions', { scope }), [])
  assert.deepEqual(await unverified.handle('vault.send.recovery', { scope }), {
    signedWithoutTransaction: true
  })
  const restartedTransactions = createMultisigTransactionJournal()
  let verified = 0
  const restarted = createMultisigSendHandler({
    ...s.deps,
    transactions: restartedTransactions,
    verifyFinalizationSnapshot: async input => {
      verified++
      assert.equal(input.snapshotSha256, finalizedReceipt.snapshotSha256)
      assert.equal(input.accountId, scope.accountId)
    },
    forwardToWorker: async () => {
      throw new Error('A metadata repair must not ask the Worker to send')
    }
  })
  const recovered = await restarted.handle('vault.send.transactions', { scope })
  assert.equal(verified, 1)
  assert.equal(recovered[0].phase, 'finalized')
  assert.equal(recovered[0].txId, finalizedReceipt.txId)
  assert.equal(recovered[0].summary?.recipient, draft.to)
  await assert.rejects(restartedTransactions.beginSubmission(signed, finalizedReceipt.txId, NOW))
  await assert.rejects(restarted.handle('vault.send.submit', authority))
})

test('a lost submission response remains unknown across restart without an automatic resend', async () => {
  const s = await prepareSignedTransfer()
  const forward = s.deps.forwardToWorker
  let submissions = 0
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') return persistFinalizationReceipt()
    if (method === 'vault.sign.worker.submit') {
      submissions++
      throw new Error('response lost')
    }
    return forward(method, payload)
  }
  await s.handler.handle('vault.send.finalize', authority)
  assert.equal((await s.handler.handle('vault.send.submit', authority)).phase, 'submission_unknown')
  assert.equal((await s.handler.handle('vault.send.submit', authority)).phase, 'submission_unknown')
  const restarted = createMultisigSendHandler({
    ...s.deps,
    transactions: createMultisigTransactionJournal()
  })
  const recovered = await restarted.handle('vault.send.transactions', { scope })
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].phase, 'submission_unknown')
  assert.equal(recovered[0].txId, finalizedReceipt.txId)
  await assert.rejects(restarted.handle('vault.send.submit', authority))
  assert.equal(submissions, 1)
})

test('a mismatched finalized receipt never authorizes submission or another finalization', async () => {
  const s = await prepareSignedTransfer()
  const forward = s.deps.forwardToWorker
  let finalizations = 0
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') {
      finalizations++
      return { ...finalizedReceipt, network: 'mainnet' }
    }
    return forward(method, payload)
  }
  await assert.rejects(s.handler.handle('vault.send.finalize', authority))
  await assert.rejects(s.handler.handle('vault.send.finalize', authority))
  await assert.rejects(s.handler.handle('vault.send.submit', authority))
  assert.equal(finalizations, 1)
  assert.deepEqual(await s.deps.transactions.listTransactions(), [])
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'signed')
})

test('account changes during finalization retain the signed intent and block submission', async () => {
  const s = await prepareSignedTransfer()
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') {
      s.state.activeAccountId = 'other-account'
      return finalizedReceipt
    }
    return forward(method, payload)
  }
  await assert.rejects(s.handler.handle('vault.send.finalize', authority))
  assert.deepEqual(await s.deps.transactions.listTransactions(), [])
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'signed')
})

test('local transaction queries do not wait for Worker initialization or network readiness', async () => {
  const s = setup()
  s.deps.forwardToWorker = async () => {
    throw new Error('Worker is not ready')
  }
  assert.deepEqual(await s.handler.handle('vault.send.transactions', { scope }), [])
})

test('only a sufficient chain confirmation settles a signed intent and releases its active slot', async () => {
  const s = await prepareSignedTransfer()
  const forward = s.deps.forwardToWorker
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') return persistFinalizationReceipt()
    if (method === 'vault.sign.worker.submit') throw new Error('response lost')
    return forward(method, payload)
  }
  await s.handler.handle('vault.send.finalize', authority)
  await s.handler.handle('vault.send.submit', authority)
  s.deps.confirmations = async () => null
  await s.handler.reconcileTransactions()
  assert.equal((await s.deps.transactions.listTransactions())[0].phase, 'submission_unknown')
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'signed')
  s.deps.confirmations = async () => 100
  await s.handler.reconcileTransactions()
  assert.equal((await s.deps.transactions.listTransactions())[0].phase, 'confirmed')
  assert.equal((await s.journal.listSigningIntents())[0].phase, 'confirmed')
})

test('a confirmed transaction is never downgraded by a cached broadcast response', async () => {
  const s = await prepareSignedTransfer()
  const signed = signingIntentBinding((await s.journal.listSigningIntents())[0])
  const controller = createMultisigTransactionController({
    journal: s.journal,
    transactions: s.deps.transactions,
    authorize: async () => {},
    now: () => NOW,
    forwardToWorker: async method =>
      method === 'vault.sign.worker.finalize'
        ? persistFinalizationReceipt()
        : { phase: 'broadcast', txId: finalizedReceipt.txId, outbound: [] }
  })
  await controller.finalize(signed, {
    recipient: draft.to,
    amount: draft.amountZats,
    memo: draft.memo,
    fee: '10000',
    marginalFeeZats: draft.marginalFeeZats,
    feeQuoteId: draft.feeQuoteId
  })
  assert.equal((await controller.submit(signed)).phase, 'broadcast')
  await s.deps.transactions.recordConfirmed(signed, finalizedReceipt.txId, NOW + 1)
  assert.equal((await controller.submit(signed)).phase, 'confirmed')
  const stored = (await s.deps.transactions.listTransactions())[0]
  const projected = projectMultisigActivity(stored, 'shielded-test-sender')!
  assert.equal(projected.status, 'success')
  assert.equal(projected.txHash, finalizedReceipt.txId)
  assert.equal(projected.amount, '0.00001')
  assert.equal(projected.fee, '0.0001')
  assert.equal(projected.to, draft.to)
  assert.equal(projected.memo, draft.memo)
  assert.equal(projected.network, 'testnet')
  assert.equal(projectMultisigActivity({ ...stored, phase: 'finalized' }, 'sender'), null)
  assert.equal(
    projectMultisigActivity({ ...stored, version: 1, review: undefined }, 'sender'),
    null
  )
  assert.equal(
    projectMultisigActivity({ ...stored, phase: 'submission_unknown' }, 'sender')?.status,
    'pending'
  )
})

test('signed intents without transaction receipts remain visible after restart without a Worker', async () => {
  const s = await prepareSignedTransfer()
  const restarted = createMultisigSendHandler({
    ...s.deps,
    forwardToWorker: async () => {
      throw new Error('Worker unavailable')
    }
  })
  assert.deepEqual(await restarted.handle('vault.send.recovery', { scope }), {
    signedWithoutTransaction: true
  })
  await assert.rejects(
    restarted.handle('vault.send.recovery', { scope: { ...scope, accountId: 'other' } })
  )
})

test('Background finishes the authorized send when its page closes during finalization', async () => {
  const s = await prepareSignedTransfer()
  const forward = s.deps.forwardToWorker
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  let submissions = 0
  s.deps.forwardToWorker = async (method, payload) => {
    if (method === 'vault.sign.worker.finalize') {
      enter()
      await released
      return persistFinalizationReceipt()
    }
    if (method === 'vault.sign.worker.submit') {
      submissions++
      return { phase: 'broadcast', txId: finalizedReceipt.txId, outbound: [] }
    }
    return forward(method, payload)
  }
  const sending = s.handler.handle('vault.send.execute', authority)
  // A bounded race also makes an absent execute implementation fail promptly.
  await Promise.race([
    entered,
    sending.then(() => {
      throw new Error('finalization not entered')
    })
  ])
  const closing = s.handler.handle('vault.send.close', authority)
  release()
  assert.equal((await sending).phase, 'broadcast')
  assert.equal(await closing, true)
  assert.equal(submissions, 1)
  assert.equal((await s.deps.transactions.listTransactions())[0].phase, 'broadcast')
  await assert.rejects(s.handler.handle('vault.send.execute', authority))
  assert.equal(submissions, 1)
})
