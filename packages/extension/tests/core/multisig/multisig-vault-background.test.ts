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
