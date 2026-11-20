import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  createMultisigVaultHandler,
  type MultisigVaultDeps
} from '../../../src/background/multisig-vault'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'
import type { MultisigGroupScope } from '../../../src/lib/multisig-group-storage'
import type { MultisigCreationOperation } from '../../../src/lib/multisig-creation-storage'
import { buildRoster } from '../../../src/core/multisig/roster'
import { bytesToBase64 } from '../../../src/lib/bytes'
import { sealedVaultRecordEquals } from '../../../src/core/multisig/vault-record'
import type { PendingPhoneRecovery } from '../../../src/lib/multisig-recovery-storage'
import { createVaultDkgRpcHandler } from '../../../src/core/multisig/dkg-rpc'
import { generateDeviceIdentity } from '../../../src/core/multisig/identity'
import { createEnvelopeSigner } from '../../../src/core/multisig/envelope-signing'
import { Phone, runRounds } from './helpers/raw-phone'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'

const fixture = JSON.parse(
  await readFile(fileURLToPath(new URL('./fixtures/vault-record-v1.json', import.meta.url)), 'utf8')
) as { record: SealedVaultRecord }
const RECORD = fixture.record
const SCOPE: MultisigGroupScope = { network: 'testnet', walletId: 'w', accountId: 'a' }
const OPEN = {
  participants: 3,
  threshold: 2,
  mainnet: false,
  scope: SCOPE,
  groupId: RECORD.groupId
}
const SAVE = { scope: SCOPE, groupId: RECORD.groupId, record: RECORD }
const SUMMARY = { fingerprint: 'ab'.repeat(32), address: 'u1addr', participants: 3, threshold: 2 }

function setup(overrides: Partial<MultisigVaultDeps> = {}) {
  const state = {
    unlocked: true,
    store: null as SealedVaultRecord | null,
    groupId: RECORD.groupId as string | null,
    binds: [] as string[],
    forwarded: [] as unknown[][],
    bindResult: true,
    saves: 0,
    workerReply: { sessionId: 'AAAA' } as unknown
  }
  const deps: MultisigVaultDeps = {
    readWalletState: async () => ({
      network: 'testnet',
      activeWalletId: 'w',
      wallets: [
        { id: 'w', mnemonic: true, accountIds: ['a'] },
        { id: 'hw', mnemonic: false, accountIds: ['a'] },
        { id: 'other', mnemonic: true, accountIds: ['a'] }
      ]
    }),
    isUnlocked: async () => state.unlocked,
    bindCredential: async id => {
      state.binds.push(id)
      return state.bindResult
    },
    forwardToWorker: async (method, payload) => {
      state.forwarded.push([method, payload])
      return state.workerReply
    },
    readRecord: async () => state.store,
    saveRecord: async (_scope, record) => {
      state.saves += 1
      state.store = record
    },
    readGroupId: async () => state.groupId,
    ...overrides
  }
  return { state, handler: createMultisigVaultHandler(deps) }
}

const INVALID = 'Invalid vault group request'

test.describe('multisig vault background', () => {
  test('phone recovery survives Background restart and replaces only after explicit safe completion', async () => {
    const original: SealedVaultRecord = {
      ...RECORD,
      version: 2,
      accountId: SCOPE.accountId,
      ownerWalletId: SCOPE.walletId
    }
    const candidate: SealedVaultRecord = {
      ...original,
      iv: bytesToBase64(new Uint8Array(12).fill(7))
    }
    let stored = original
    let pending: { id: string; value: PendingPhoneRecovery } | null = null
    let blocked = true
    let invalidated = 0
    let pauseSafety = false
    let releaseSafety: (() => void) | null = null
    let safetyEntered: (() => void) | null = null
    const deps: MultisigVaultDeps = {
      readWalletState: async () => ({
        network: 'testnet',
        activeWalletId: 'w',
        activeAccountId: 'a',
        wallets: [{ id: 'w', mnemonic: true, accountIds: ['a'] }]
      }),
      isUnlocked: async () => true,
      bindCredential: async () => true,
      forwardToWorker: async () => ({
        record: candidate,
        reply: bytesToBase64(Uint8Array.of(1, 2, 3))
      }),
      readRecord: async () => stored,
      saveRecord: async () => {},
      readGroupId: async () => original.groupId,
      recovery: {
        withScope: async (_scope, operation) => operation(),
        readCreationReady: async () => true,
        assertSafe: async () => {
          if (blocked) throw new Error('Pending signing')
          if (pauseSafety) {
            pauseSafety = false
            safetyEntered?.()
            await new Promise<void>(resolve => {
              releaseSafety = resolve
            })
          }
        },
        invalidateSigning: async () => {
          invalidated++
        },
        readGeneration: async () => 0,
        readPending: async id => (pending?.id === id ? pending.value : null),
        savePending: async (id, value) => {
          pending = { id, value }
        },
        removePending: async id => {
          if (pending?.id === id) pending = null
        },
        replaceRecord: async (_scope, previous, next, assertAuthorized) => {
          await assertAuthorized()
          if (!sealedVaultRecordEquals(stored, previous)) throw new Error('Record changed')
          stored = next
        }
      }
    }
    const request = bytesToBase64(new Uint8Array(202).fill(1))
    const prepared = await createMultisigVaultHandler(deps).handle('vault.group.recover.prepare', {
      scope: SCOPE,
      request
    })
    expect(stored).toEqual(original)
    expect(prepared.reply).toBe(bytesToBase64(Uint8Array.of(1, 2, 3)))
    const resumed = createMultisigVaultHandler(deps)
    await expect(
      resumed.handle('vault.group.recover.complete', {
        scope: SCOPE,
        recoveryId: prepared.recoveryId
      })
    ).rejects.toThrow('Pending signing')
    expect(stored).toEqual(original)
    expect(invalidated).toBe(0)
    blocked = false
    pauseSafety = true
    const entered = new Promise<void>(resolve => {
      safetyEntered = resolve
    })
    const oldCompletion = resumed.handle('vault.group.recover.complete', {
      scope: SCOPE,
      recoveryId: prepared.recoveryId
    })
    await entered
    const replacement = await resumed.handle('vault.group.recover.prepare', {
      scope: SCOPE,
      request
    })
    releaseSafety?.()
    await expect(oldCompletion).rejects.toThrow('Vault group scope is not available')
    expect(stored).toEqual(original)
    expect(
      await resumed.handle('vault.group.recover.complete', {
        scope: SCOPE,
        recoveryId: replacement.recoveryId
      })
    ).toBe(true)
    expect(stored).toEqual(candidate)
    expect(invalidated).toBe(1)
    expect(pending).toBeNull()
  })

  test('reserved independent creation retains saved material after metadata failure and resumes after restart', async () => {
    let operation: MultisigCreationOperation | null = null
    let stored: SealedVaultRecord | null = null
    let groupSaved = false
    let failGroup = true
    let metadataSaved = false
    let requireQuiescence = false
    let mutationActive = false
    let metadataLocked = false
    let failQuiescence = false
    let lockAfterQuiescence = false
    let unlocked = true
    let activeWalletId = 'w'
    let mutationAttempts = 0
    let mutationResumes = 0
    const wasm = await loadVaultWasm()
    let worker = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const registrations: unknown[] = []
    const accounts = ['a']
    let scopeTail = Promise.resolve()
    const deps: MultisigVaultDeps = {
      readWalletState: async () => ({
        network: 'testnet',
        activeWalletId,
        wallets: [{ id: 'w', mnemonic: true, accountIds: [...accounts], derivedAccountIds: ['a'] }]
      }),
      isUnlocked: async () => unlocked,
      bindCredential: async () => true,
      forwardToWorker: async (method, payload) => worker.handle(method, payload),
      readRecord: async () => stored,
      saveRecord: async (_scope, record) => {
        stored = record
      },
      readGroupId: async () => (groupSaved ? operation!.groupId : null),
      creation: {
        withMutation: async (_walletId, run) => {
          expect(metadataLocked).toBe(false)
          mutationAttempts++
          try {
            if (failQuiescence) throw new Error('Sync did not stop')
            mutationActive = true
            if (lockAfterQuiescence) unlocked = false
            return await run()
          } finally {
            mutationActive = false
            mutationResumes++
          }
        },
        birthdayHeight: async () => 123,
        read: async () => (operation ? structuredClone(operation) : null),
        list: async () => (operation ? [structuredClone(operation)] : []),
        write: async op => {
          operation = structuredClone(op)
        },
        remove: async () => {
          operation = null
        },
        withScope: async (_scope, run) => {
          if (requireQuiescence && !mutationActive)
            throw new Error('Metadata lock entered before sync quiescence')
          const previous = scopeTail
          let release!: () => void
          scopeTail = new Promise<void>(resolve => {
            release = resolve
          })
          await previous
          try {
            metadataLocked = true
            return await run()
          } finally {
            metadataLocked = false
            release()
          }
        },
        register: async (_wallet, account, record) => {
          expect(mutationActive).toBe(true)
          registrations.push({ account, record })
          return account.addresses
        },
        commitMetadata: async (op, account, guard) => {
          await guard()
          expect(account).not.toHaveProperty('derivationIndex')
          expect(account.source).toEqual({
            kind: 'frost-vault',
            version: 1,
            groupId: op.groupId,
            network: 'testnet'
          })
          if (!accounts.includes(account.id)) accounts.push(account.id)
          metadataSaved = true
        },
        saveGroup: async () => {
          if (failGroup) throw new Error('write failed')
          groupSaved = true
        }
      }
    }
    const first = createMultisigVaultHandler(deps)
    const op = await first.handle('vault.group.reserve', { scope: SCOPE, threshold: '2-of-3' })
    expect(op.scope.accountId).not.toBe(SCOPE.accountId)
    expect(accounts).toEqual(['a'])
    expect(await first.handle('vault.group.pending', { scope: SCOPE })).toEqual([op])
    await expect(
      first.handle('vault.group.reserve', { scope: SCOPE, threshold: '2-of-3' })
    ).rejects.toThrow('An earlier multisig setup is incomplete')
    const identities = await Promise.all([0, 1, 2].map(() => generateDeviceIdentity()))
    const roster = buildRoster({
      groupId: op.groupId,
      threshold: 2,
      identities: new Map(
        identities.map((identity, slot) => [slot, bytesToBase64(identity.publicKey)])
      )
    })
    const openRequest = {
      ...OPEN,
      scope: op.scope,
      groupId: op.groupId,
      operationId: op.operationId,
      outerSessionId: 'outer-session',
      binding: {
        accountId: op.scope.accountId,
        birthdayHeight: 123,
        rosterVersion: 1 as const,
        roster
      }
    }
    const realForward = deps.forwardToWorker
    deps.forwardToWorker = async () => ({ sessionId: 'AAAA' })
    await expect(first.handle('vault.group.open', openRequest)).rejects.toThrow(
      'Vault setup could not start'
    )
    expect(operation?.dkgSessionId).toBeUndefined()
    deps.forwardToWorker = realForward
    const results = await Promise.allSettled([
      first.handle('vault.group.open', openRequest),
      first.handle('vault.group.open', { ...openRequest, outerSessionId: 'racing-session' })
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    if (results[0].status !== 'fulfilled') throw new Error('first session failed')
    const { sessionId } = results[0].value
    expect(operation?.outerSessionId).toBe('outer-session')
    const signers = identities.map((identity, slot) =>
      createEnvelopeSigner({
        groupId: op.groupId,
        sessionId: 'outer-session',
        senderId: `device-${slot + 1}`,
        signingKey: identity.signingKeys.privateKey
      })
    )
    const shape = { participants: 3, threshold: 2 } as const
    const phones = [1, 2].map(slot => new Phone(wasm, shape, slot, sessionId))
    const r2 = await runRounds(wasm, worker, shape, sessionId, phones, (slot, type, payload) =>
      signers[slot].next(type, 'device-1', payload)
    )
    const record = r2.record
    await first.handle('vault.group.save', {
      scope: op.scope,
      groupId: op.groupId,
      operationId: op.operationId,
      record
    })
    const retainedIncomplete = await first.handle('vault.group.pending', { scope: SCOPE })
    expect(retainedIncomplete[0].phase).toBe('share_saved')
    expect(retainedIncomplete[0].group).toBeUndefined()
    expect(accounts).toEqual(['a'])
    const display = {
      groupId: op.groupId,
      threshold: op.threshold,
      fingerprint: r2.fingerprint,
      transportKind: 'qr' as const,
      devices: [],
      createdAt: 0,
      mock: true
    }
    const confirmations = await Promise.all(
      phones.map(async phone => {
        expect(
          phone.finish(r2.inboxes[String(phone.slot)], r2.sealedQsk[String(phone.slot)], false)
        ).toBe(r2.fingerprint)
        return signers[phone.slot].next('DKG_FINAL', 'device-1', { fingerprint: r2.fingerprint })
      })
    )
    const evidence = { sessionId: 'outer-session', confirmations }
    const forged = {
      ...evidence,
      confirmations: confirmations.map((env, index) =>
        index === 0 ? { ...env, authentication_data: bytesToBase64(new Uint8Array(64)) } : env
      )
    }
    await expect(
      first.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: display,
        evidence: forged
      })
    ).rejects.toThrow('Vault record cannot be opened')
    expect(metadataSaved).toBe(false)
    await expect(
      first.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: display,
        evidence: { ...evidence, sessionId: 'other-session' }
      })
    ).rejects.toThrow('Verified device confirmation is required')
    await expect(
      first.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: { ...display, fingerprint: 'ff'.repeat(32) },
        evidence
      })
    ).rejects.toThrow(INVALID)
    requireQuiescence = true
    const beforeIneligible = mutationAttempts
    for (const context of [
      { unlocked: false, activeWalletId: 'w', error: 'Wallet is locked' },
      { unlocked: true, activeWalletId: 'other', error: 'Vault setup requires the active wallet' }
    ]) {
      unlocked = context.unlocked
      activeWalletId = context.activeWalletId
      await expect(
        first.handle('vault.group.commit', {
          scope: op.scope,
          operationId: op.operationId,
          group: display,
          evidence
        })
      ).rejects.toThrow(context.error)
      expect(mutationAttempts).toBe(beforeIneligible)
    }
    unlocked = true
    activeWalletId = 'w'
    failQuiescence = true
    await expect(
      first.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: display,
        evidence
      })
    ).rejects.toThrow('Sync did not stop')
    expect(operation?.phase).toBe('share_saved')
    expect(stored).toEqual(record)
    expect(registrations).toEqual([])
    expect(metadataSaved).toBe(false)
    expect(groupSaved).toBe(false)

    failQuiescence = false
    lockAfterQuiescence = true
    await expect(
      first.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: display,
        evidence
      })
    ).rejects.toThrow('Wallet is locked')
    expect(operation?.phase).toBe('share_saved')
    expect(registrations).toEqual([])
    lockAfterQuiescence = false
    unlocked = true
    await expect(
      first.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: display,
        evidence
      })
    ).rejects.toThrow('write failed')
    expect(operation?.phase).toBe('metadata_saved')
    expect(metadataSaved).toBe(true)
    expect(groupSaved).toBe(false)
    expect(stored).toEqual(record)
    expect(mutationActive).toBe(false)
    expect(mutationResumes).toBe(mutationAttempts)
    failGroup = false
    // The Worker and Background restart; persisted signed finals must be revalidated from the
    // encrypted roster without relying on the original live DKG coordinator.
    worker = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
    const restarted = createMultisigVaultHandler(deps)
    requireQuiescence = false
    const ready = await restarted.handle('vault.group.status', {
      scope: op.scope,
      operationId: op.operationId
    })
    expect(ready.phase).toBe('ready')
    expect(accounts).toEqual(['a', op.scope.accountId])
    expect(registrations.length).toBe(2)
    await restarted.handle('vault.group.commit', {
      scope: op.scope,
      operationId: op.operationId,
      group: display,
      evidence
    })
    expect(registrations.length).toBe(2)
    operation = null
    await expect(
      restarted.handle('vault.group.commit', {
        scope: op.scope,
        operationId: op.operationId,
        group: display,
        evidence
      })
    ).rejects.toThrow('Vault group scope is not available')
    // Cancellation wins the metadata lock while a save is queued. A stale pre-lock read must
    // never recreate the removed reservation or its encrypted record.
    operation = { ...op, rosterHash: roster.rosterHash, phase: 'reserved' }
    stored = null
    let release!: () => void
    let entered!: () => void
    const acquired = new Promise<void>(resolve => {
      entered = resolve
    })
    const waiting = new Promise<void>(resolve => {
      release = resolve
    })
    let holdNext = true
    deps.creation!.withScope = async (_scope, run) => {
      if (holdNext) {
        holdNext = false
        entered()
        await waiting
      }
      return run()
    }
    const queuedSave = restarted.handle('vault.group.save', {
      scope: op.scope,
      groupId: op.groupId,
      operationId: op.operationId,
      record
    })
    await acquired
    await restarted.handle('vault.group.cancel', { scope: op.scope, operationId: op.operationId })
    release()
    await expect(queuedSave).rejects.toThrow('Vault group scope is not available')
    expect(operation).toBeNull()
    expect(stored).toBeNull()
  })
  test('open binds the active wallet and forwards the Worker request', async () => {
    const { state, handler } = setup()
    const result = await handler.handle('vault.group.open', OPEN)
    expect(state.forwarded).toEqual([
      [
        'vault.dkg.open',
        {
          participants: 3,
          threshold: 2,
          mainnet: false,
          ownerWalletId: 'w',
          groupId: RECORD.groupId
        }
      ]
    ])
    expect(state.binds).toEqual(['w'])
    expect(result).toEqual({ sessionId: 'AAAA' })
  })

  test('open forwards sessionId to the Worker', async () => {
    const { state, handler } = setup()
    const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA=='
    await handler.handle('vault.group.open', { ...OPEN, sessionId })
    expect(state.forwarded[0]).toEqual([
      'vault.dkg.open',
      {
        participants: 3,
        threshold: 2,
        mainnet: false,
        ownerWalletId: 'w',
        groupId: RECORD.groupId,
        sessionId
      }
    ])
    await expect(
      handler.handle('vault.group.open', { ...OPEN, sessionId: 'AAAA' })
    ).rejects.toThrow('Invalid vault group request')
  })

  test('open refuses anything but an unlocked, active mnemonic wallet on this network', async () => {
    const cases: Array<[string, unknown, string, (s: ReturnType<typeof setup>['state']) => void]> =
      [
        ['locked', OPEN, 'Wallet is locked', s => (s.unlocked = false)],
        [
          'not active',
          { ...OPEN, scope: { ...SCOPE, walletId: 'other' } },
          'Vault setup requires the active wallet',
          () => {}
        ],
        [
          'hardware wallet',
          { ...OPEN, scope: { network: 'mainnet', walletId: 'hw', accountId: 'zz' } },
          'Vault group scope is not available',
          () => {}
        ],
        ['mainnet flag', { ...OPEN, mainnet: true }, INVALID, () => {}],
        ['no credential', OPEN, 'Wallet credential is unavailable', s => (s.bindResult = false)],
        ['extra key', { ...OPEN, extra: 1 }, INVALID, () => {}]
      ]
    for (const [name, payload, message, arrange] of cases) {
      const { state, handler } = setup()
      arrange(state)
      await expect(handler.handle('vault.group.open', payload), name).rejects.toThrow(message)
      expect(state.forwarded, name).toEqual([])
      if (name === 'not active') expect(state.binds).toEqual([])
    }
  })

  test('open rejects a malformed Worker reply', async () => {
    const { state, handler } = setup()
    state.workerReply = { sessionId: '***' }
    await expect(handler.handle('vault.group.open', OPEN)).rejects.toThrow(
      'Vault setup could not start'
    )
  })

  test('save stores the record and works while the wallet is locked', async () => {
    const { state, handler } = setup()
    state.unlocked = false
    expect(await handler.handle('vault.group.save', SAVE)).toBe(true)
    expect(state.store).toEqual(RECORD)
    expect(state.binds).toEqual([])
    expect(state.forwarded).toEqual([])
  })

  test('save refuses a record for another group or network', async () => {
    const { handler } = setup()
    await expect(
      handler.handle('vault.group.save', {
        ...SAVE,
        groupId: '99999999-2222-4333-8444-555555555555'
      })
    ).rejects.toThrow(INVALID)
    await expect(
      handler.handle('vault.group.save', { ...SAVE, record: { ...RECORD, network: 'mainnet' } })
    ).rejects.toThrow(INVALID)
  })

  test('save reports a store that could not prove the record landed', async () => {
    const { state, handler } = setup({
      saveRecord: async () => {
        throw new Error('Vault record could not be saved')
      }
    })
    state.store = RECORD
    const second = { ...RECORD, salt: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' }
    await expect(handler.handle('vault.group.save', { ...SAVE, record: second })).rejects.toThrow(
      'Vault record could not be saved'
    )
    expect(state.store).toEqual(RECORD)
  })

  test('save reports a failing write with the same message and keeps the earlier record', async () => {
    const { state, handler } = setup({
      saveRecord: async () => {
        throw new Error('quota')
      }
    })
    state.store = RECORD
    const second = { ...RECORD, salt: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' }
    await expect(handler.handle('vault.group.save', { ...SAVE, record: second })).rejects.toThrow(
      /^Vault record could not be saved$/
    )
    expect(state.store).toEqual(RECORD)
  })

  test('save refuses a scope that is not available and stores nothing', async () => {
    const cases: Array<[string, unknown]> = [
      ['unknown wallet', { ...SAVE, scope: { ...SCOPE, walletId: 'nobody' } }],
      ['no recovery phrase', { ...SAVE, scope: { ...SCOPE, walletId: 'hw' } }],
      ['account not in wallet', { ...SAVE, scope: { ...SCOPE, accountId: 'zz' } }],
      [
        'other network',
        {
          ...SAVE,
          scope: { ...SCOPE, network: 'mainnet' },
          record: { ...RECORD, network: 'mainnet' }
        }
      ]
    ]
    for (const [name, payload] of cases) {
      const { state, handler } = setup()
      await expect(handler.handle('vault.group.save', payload), name).rejects.toThrow(
        'Vault group scope is not available'
      )
      expect(state.saves, name).toBe(0)
      expect(state.store, name).toBeNull()
    }
  })

  test('saving again for the same scope replaces the earlier record', async () => {
    const { state, handler } = setup()
    await handler.handle('vault.group.save', SAVE)
    const second = { ...RECORD, salt: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' }
    await handler.handle('vault.group.save', { ...SAVE, record: second })
    expect(state.store).toEqual(second)
  })

  test('summary reports missing without a record, or when the group record names another group', async () => {
    const empty = setup()
    expect(await empty.handler.handle('vault.group.summary', { scope: SCOPE })).toEqual({
      status: 'missing'
    })
    const other = setup()
    other.state.store = RECORD
    other.state.groupId = '99999999-2222-4333-8444-555555555555'
    expect(await other.handler.handle('vault.group.summary', { scope: SCOPE })).toEqual({
      status: 'missing'
    })
    expect(other.state.forwarded).toEqual([])
  })

  test('summary forwards the record and returns the Worker summary', async () => {
    const { state, handler } = setup()
    state.store = RECORD
    state.workerReply = SUMMARY
    const result = await handler.handle('vault.group.summary', { scope: SCOPE })
    expect(state.forwarded).toEqual([
      ['vault.record.summary', { record: RECORD, ownerWalletId: 'w' }]
    ])
    expect(result).toEqual({ status: 'ok', ...SUMMARY })
  })

  test('summary refuses a wallet that is not active', async () => {
    const { state, handler } = setup()
    state.store = RECORD
    await expect(
      handler.handle('vault.group.summary', { scope: { ...SCOPE, walletId: 'other' } })
    ).rejects.toThrow('Vault setup requires the active wallet')
    expect(state.binds).toEqual([])
  })

  test('summary refuses a locked wallet, a refused bind and an unavailable scope', async () => {
    const cases: Array<[string, unknown, string, (s: ReturnType<typeof setup>['state']) => void]> =
      [
        ['locked', { scope: SCOPE }, 'Wallet is locked', s => (s.unlocked = false)],
        [
          'bind refused',
          { scope: SCOPE },
          'Wallet credential is unavailable',
          s => (s.bindResult = false)
        ],
        [
          'scope not available',
          { scope: { ...SCOPE, accountId: 'zz' } },
          'Vault group scope is not available',
          () => {}
        ]
      ]
    for (const [name, payload, message, arrange] of cases) {
      const { state, handler } = setup()
      state.store = RECORD
      state.workerReply = SUMMARY
      arrange(state)
      await expect(handler.handle('vault.group.summary', payload), name).rejects.toThrow(message)
      expect(state.forwarded, name).toEqual([])
    }
  })

  test('summary refuses a malformed Worker summary', async () => {
    const replies: Array<[string, unknown]> = [
      ['threshold', { ...SUMMARY, threshold: 5 }],
      ['uppercase fingerprint', { ...SUMMARY, fingerprint: 'AB'.repeat(32) }],
      ['63-character fingerprint', { ...SUMMARY, fingerprint: 'a'.repeat(63) }],
      ['513-character address', { ...SUMMARY, address: 'u'.repeat(513) }]
    ]
    for (const [name, reply] of replies) {
      const { state, handler } = setup()
      state.store = RECORD
      state.workerReply = reply
      await expect(handler.handle('vault.group.summary', { scope: SCOPE }), name).rejects.toThrow(
        'Vault record cannot be opened'
      )
    }
  })

  test('summary accepts a 512-character address', async () => {
    const { state, handler } = setup()
    state.store = RECORD
    state.workerReply = { ...SUMMARY, address: 'u'.repeat(512) }
    expect(await handler.handle('vault.group.summary', { scope: SCOPE })).toEqual({
      status: 'ok',
      ...SUMMARY,
      address: 'u'.repeat(512)
    })
  })
})
