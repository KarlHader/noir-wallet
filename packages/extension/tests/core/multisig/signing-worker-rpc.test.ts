import { realReviewFixture } from './helpers/signing-worker'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { SigningNonceCheckpoint } from '../../../src/core/multisig/nonce-checkpoint'
import { createSigningWorkerRpcHandler } from '../../../src/core/multisig/signing-worker-rpc'
import type { SigningStatus } from '../../../src/core/multisig/signing-coordinator'
import { loadWalletWasm } from './helpers/vault-wasm'
import { bytesToBase64 } from '../../../src/lib/bytes'
import { readFile } from 'node:fs/promises'

const status = (): SigningStatus => ({
  sessionId: 'session',
  phase: 'created',
  selectedSlots: [0, 1],
  committedSlots: [],
  sharedSlots: []
})

test('nonce checkpoints yield before every durable boundary and exact ACK replay advances only once', async () => {
  const checkpoint = new SigningNonceCheckpoint(status)
  const actions: string[] = []
  const start = () =>
    checkpoint.run('start', async () => {
      await checkpoint.persist('created')
      actions.push('nonce')
      await checkpoint.persist('committed')
      actions.push('commitment')
      return { status: status(), outbound: [] }
    })
  const created = await start()
  expect(actions).toEqual([])
  expect(created.persistence?.phase).toBe('created')
  expect(await start()).toEqual(created)
  const ack = { ...created.persistence!, persisted: true }
  const [committed, replay] = await Promise.all([checkpoint.advance(ack), checkpoint.advance(ack)])
  expect(committed).toEqual(replay)
  expect(actions).toEqual(['nonce'])
  expect(committed.persistence?.phase).toBe('committed')
  const ready = await checkpoint.advance({ ...committed.persistence!, persisted: true })
  expect(ready.persistence).toBeUndefined()
  expect(actions).toEqual(['nonce', 'commitment'])
  expect(await checkpoint.advance(ack)).toEqual(committed)
  const consuming = await checkpoint.run('ingest', async () => {
    await checkpoint.persist('consumed')
    actions.push('share')
    return { status: status(), outbound: [] }
  })
  expect(actions).toEqual(['nonce', 'commitment'])
  await checkpoint.advance({ ...consuming.persistence!, persisted: true })
  expect(actions).toEqual(['nonce', 'commitment', 'share'])
})

test('wrong or failed durable ACK and cancellation cannot release next-stage material', async () => {
  for (const failure of ['token', 'phase', 'failed', 'cancel']) {
    const checkpoint = new SigningNonceCheckpoint(status)
    let nonce = false
    const progress = await checkpoint.run('start', async () => {
      await checkpoint.persist('created')
      nonce = true
      return { status: status(), outbound: [] }
    })
    if (failure === 'cancel') checkpoint.cancel()
    else
      await expect(
        checkpoint.advance({
          ...progress.persistence!,
          ...(failure === 'token' ? { ackId: 'other' } : {}),
          ...(failure === 'phase' ? { phase: 'consumed' as const } : {}),
          persisted: failure !== 'failed'
        })
      ).rejects.toThrow()
    await expect(
      checkpoint.advance({ ...progress.persistence!, persisted: true })
    ).rejects.toThrow()
    expect(nonce).toBe(false)
  }
})

test('production unavailable prepare cannot decrypt a share or create a startable review', async () => {
  const wasm = await loadWalletWasm()
  let credentialReads = 0
  const handler = createSigningWorkerRpcHandler(wasm, {
    credential: () => {
      credentialReads++
      throw new Error('must not decrypt')
    },
    network: () => 'testnet',
    identity: async () => {
      throw new Error('must not load')
    },
    reviewProvider: { available: false }
  })
  const request = {
    scope: {
      walletId: 'wallet:1',
      accountId: 'account:1',
      network: 'testnet',
      groupId: 'group-1',
      rosterVersion: 1
    },
    source: { kind: 'frost-vault', version: 1, network: 'testnet', groupId: 'group-1' },
    sealedRecord: {
      version: 2,
      network: 'testnet',
      groupId: 'group-1',
      accountId: 'account:1',
      ownerWalletId: 'wallet:1',
      salt: bytesToBase64(new Uint8Array(32)),
      iv: bytesToBase64(new Uint8Array(12)),
      ciphertext: bytesToBase64(new Uint8Array(17))
    },
    intent: {
      recipient: 'u'.repeat(2048),
      amount: '1',
      memo: '',
      marginalFeeZats: 5000,
      feeQuoteId: 'quote-1'
    },
    selectedSlots: [0, 1],
    transport: 'qr'
  }
  expect(await handler.handle('vault.sign.worker.prepare', request)).toEqual({
    available: false,
    reason: 'pczt_review_unavailable'
  })
  expect(credentialReads).toBe(0)
  const reference = {
    walletId: 'wallet-1',
    reviewId: 'invented',
    sessionId: 'AAAAAAAAAAAAAAAAAAAAAA=='
  }
  for (const method of [
    'vault.sign.worker.start',
    'vault.sign.worker.ingest',
    'vault.sign.worker.advance',
    'vault.sign.worker.status'
  ] as const) {
    await expect(
      handler.handle(method, {
        ...reference,
        ...(method.endsWith('ingest') ? { envelope: {} } : {}),
        ...(method.endsWith('advance')
          ? { acknowledgement: { ackId: 'invented', phase: 'created', persisted: true } }
          : {})
      })
    ).rejects.toThrow()
  }
  expect(credentialReads).toBe(0)
  await expect(
    handler.handle('vault.sign.worker.prepare', { ...request, pczt: 'untrusted' })
  ).rejects.toThrow()
  await expect(
    handler.handle('vault.sign.worker.close', { ...reference, walletId: ' wallet-1' })
  ).rejects.toThrow()
})

test('real v2 authentication rejects mismatched owner/network/identity before private review', async () => {
  const { wasm, identities, request, credential } = await realReviewFixture()
  for (const failure of ['owner', 'network', 'identity', 'missing', 'epoch']) {
    let calls = 0
    const badRequest =
      failure === 'owner'
        ? {
            ...request,
            scope: { ...request.scope, walletId: 'other' },
            sealedRecord: { ...request.sealedRecord, ownerWalletId: 'other' }
          }
        : failure === 'network'
          ? {
              ...request,
              scope: { ...request.scope, network: 'mainnet' as const },
              source: { ...request.source, network: 'mainnet' as const },
              sealedRecord: { ...request.sealedRecord, network: 'mainnet' as const }
            }
          : request
    const handler = createSigningWorkerRpcHandler(wasm, {
      credential: () => (failure === 'epoch' ? null : credential),
      network: () => (failure === 'network' ? 'mainnet' : 'testnet'),
      identity: async () =>
        failure === 'missing' ? null : failure === 'identity' ? identities[1] : identities[0],
      reviewProvider: {
        available: true,
        prepare: async () => {
          calls++
          throw new Error('unreachable')
        }
      }
    })
    await expect(handler.handle('vault.sign.worker.prepare', badRequest)).rejects.toThrow()
    expect(calls).toBe(0)
  }
})

test('same mnemonic rebind or explicit invalidation cancels preparation after an await', async () => {
  const { wasm, identities, request, credential } = await realReviewFixture()
  for (const failure of ['rebind', 'invalidate']) {
    let current = credential
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const reached = new Promise<void>(resolve => {
      entered = resolve
    })
    let reviews = 0
    const handler = createSigningWorkerRpcHandler(wasm, {
      credential: () => current,
      network: () => 'testnet',
      identity: async () => {
        entered()
        await pending
        return identities[0]
      },
      reviewProvider: {
        available: true,
        prepare: async () => {
          reviews++
          throw new Error('unreachable')
        }
      }
    })
    const result = handler.handle('vault.sign.worker.prepare', request)
    await reached
    if (failure === 'rebind') current = { ...credential }
    else handler.invalidate(request.scope.walletId)
    release()
    await expect(result).rejects.toThrow('Signing session is unavailable')
    expect(reviews).toBe(0)
  }
})

test('a real PCZT for another group cannot create a Worker approval authority', async () => {
  const { wasm, identities, request, credential } = await realReviewFixture()
  const hex = (
    await readFile(new URL('./fixtures/ironwood_1action.hex', import.meta.url), 'utf8')
  ).trim()
  const fixture = Uint8Array.from(Buffer.from(hex, 'hex'))
  let calls = 0
  const handler = createSigningWorkerRpcHandler(wasm, {
    credential: () => credential,
    network: () => 'testnet',
    identity: async () => identities[0],
    reviewProvider: {
      available: true,
      prepare: async () => {
        calls++
        return {
          pczt: fixture,
          summary: {
            recipient: request.intent.recipient,
            amount: request.intent.amount,
            memo: request.intent.memo,
            fee: '10000'
          }
        }
      }
    }
  })
  await expect(handler.handle('vault.sign.worker.prepare', request)).rejects.toThrow(
    'Signing session is unavailable'
  )
  expect(calls).toBe(1)
  expect(fixture.some(byte => byte !== 0)).toBe(true)
})
