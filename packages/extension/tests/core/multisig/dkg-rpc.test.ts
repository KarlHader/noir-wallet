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
  type SealedVaultRecord
} from '../../../src/core/multisig/vault-record'
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
  test('names its five methods', () => {
    for (const method of [
      'vault.dkg.open',
      'vault.dkg.acceptRound1',
      'vault.dkg.acceptRound2',
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
