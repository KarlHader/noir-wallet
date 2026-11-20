import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMultisigVaultHandler } from '../../../src/background/multisig-vault'
import { createLazyDkgPort, type DkgPort } from '../../../src/core/multisig/dkg-port'
import {
  isBackgroundOnlyVaultRpc,
  isVaultRpcBlocked
} from '../../../src/core/multisig/multisig-runtime-policy'
import type { SealedVaultRecord } from '../../../src/core/multisig/vault-record'

const extensionDir = fileURLToPath(new URL('../../../', import.meta.url))

function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(extensionDir, relativePath), 'utf8')
}

const VAULT_METHODS = [
  'vault.dkg.open',
  'vault.dkg.acceptRound1',
  'vault.dkg.acceptRound2',
  'vault.dkg.confirmRound1',
  'vault.dkg.close'
] as const

test.describe('multisig dkg wiring', () => {
  test('blocks vault RPC only while the multisig UI is off', () => {
    expect(isVaultRpcBlocked('vault.dkg.open', false)).toBe(true)
    expect(isVaultRpcBlocked('vault.anything', false)).toBe(true)
    expect(isVaultRpcBlocked('vault.dkg.open', true)).toBe(false)
    expect(isVaultRpcBlocked('mnemonic.validate', false)).toBe(false)
  })

  test('keeps the Worker-only record summary and the group methods apart', () => {
    expect(isBackgroundOnlyVaultRpc('vault.record.summary')).toBe(true)
    // A page opens a ceremony through vault.group.open, which names the wallet itself.
    expect(isBackgroundOnlyVaultRpc('vault.dkg.open')).toBe(true)
    for (const method of [
      'wallet.registerFrostAccount',
      'wallet.preflightFrostAccount',
      'wallet.resolveFrostAccount',
      'vault.sign.worker.start',
      'vault.sign.worker.prepare',
      'vault.sign.worker.advance',
      'vault.sign.worker.ingest',
      'vault.sign.worker.status',
      'vault.sign.worker.close',
      'vault.sign.worker.invalidate'
    ]) {
      expect(isBackgroundOnlyVaultRpc(method), method).toBe(true)
    }
    expect(isBackgroundOnlyVaultRpc('vault.dkg.acceptRound2')).toBe(false)
    expect(isBackgroundOnlyVaultRpc('vault.dkg.confirmRound1')).toBe(false)
    expect(isBackgroundOnlyVaultRpc('vault.group.save')).toBe(false)
    expect(isBackgroundOnlyVaultRpc('vault.dkg.close')).toBe(false)
    expect(isVaultRpcBlocked('vault.group.open', false)).toBe(true)
  })

  test('wires the group methods into the client and the Background router', async () => {
    const client = await readSource('src/core/worker/client.ts')
    expect(client).toContain("'vault.group.open': LIGHT")
    expect(client).toContain("'vault.group.save': LIGHT")
    expect(client).toContain("'vault.group.summary': LIGHT")
    const background = await readSource('src/background/index.ts')
    const blocked = background.indexOf('isVaultRpcBlocked(rpcMessage.method)')
    const backgroundOnly = background.indexOf('isBackgroundOnlyVaultRpc(rpcMessage.method)')
    const group = background.indexOf('isVaultGroupMethod(rpcMessage.method)')
    expect(blocked).toBeGreaterThan(-1)
    expect(backgroundOnly).toBeGreaterThan(blocked)
    expect(group).toBeGreaterThan(blocked)
  })

  test('a lazy port loads once and retries after a failed load', async () => {
    let loads = 0
    const inner: DkgPort = {
      open: async () => ({ sessionId: 'sid' }),
      acceptRound1: async () => ({ complete: false }),
      acceptRound2: async () => ({ complete: false }),
      confirmRound1: async () => {},
      close: async () => {},
      save: async () => {}
    }
    const port = createLazyDkgPort(async () => {
      loads += 1
      if (loads === 1) throw new Error('offline')
      return inner
    })
    const open = {
      participants: 2,
      threshold: 2,
      mainnet: true,
      scope: { network: 'mainnet', walletId: 'wallet-1', accountId: 'acc-1' },
      groupId: 'group-1'
    } as const
    await expect(port.open(open)).rejects.toThrow('offline')
    expect(await port.open(open)).toEqual({ sessionId: 'sid' })
    await port.close({ sessionId: 'sid' })
    expect(await port.acceptRound1({ sessionId: 'sid', senderSlot: 1, envelope: 'AA' })).toEqual({
      complete: false
    })
    const record = {
      version: 1,
      network: 'mainnet',
      groupId: 'group-1',
      salt: 'AA==',
      iv: 'AA==',
      ciphertext: 'AA=='
    } as const
    await expect(
      port.save({ scope: open.scope, groupId: 'group-1', record })
    ).resolves.toBeUndefined()
    expect(loads).toBe(2)
  })

  test('the Worker, client and Background are wired to the vault handler', async () => {
    const [workerSource, clientSource, backgroundSource] = await Promise.all([
      readSource('src/core/worker/zcash.worker.ts'),
      readSource('src/core/worker/client.ts'),
      readSource('src/background/index.ts')
    ])
    expect(workerSource).toContain('createVaultDkgRpcHandler(')
    for (const method of VAULT_METHODS) {
      expect(workerSource).toContain(`case '${method}'`)
      expect(clientSource).toContain(`'${method}': LIGHT`)
    }
    expect(backgroundSource).toContain('isVaultRpcBlocked(rpcMessage.method)')
    expect(workerSource).toContain("case 'vault.record.summary'")
    expect(workerSource).toContain('ShareBackup')
    expect(clientSource).toContain("'vault.record.summary': LIGHT")
  })

  test('the payloads Background forwards to the Worker carry no walletId key', async () => {
    const fixture = JSON.parse(
      await readSource('tests/core/multisig/fixtures/vault-record-v1.json')
    )
    const record = fixture.record as SealedVaultRecord
    const scope = { network: record.network, walletId: 'w', accountId: 'a' }
    const forwarded: Array<Readonly<Record<string, unknown>>> = []
    const handler = createMultisigVaultHandler({
      readWalletState: async () => ({
        network: record.network,
        activeWalletId: 'w',
        wallets: [{ id: 'w', mnemonic: true, accountIds: ['a'] }]
      }),
      isUnlocked: async () => true,
      bindCredential: async () => true,
      forwardToWorker: async (method, payload) => {
        forwarded.push(payload)
        return method === 'vault.dkg.open'
          ? { sessionId: 'AAAA' }
          : { fingerprint: 'ab'.repeat(32), address: 'u1addr', participants: 3, threshold: 2 }
      },
      readRecord: async () => record,
      saveRecord: async () => {},
      readGroupId: async () => record.groupId
    })
    await handler.handle('vault.group.open', {
      participants: 3,
      threshold: 2,
      mainnet: record.network === 'mainnet',
      scope,
      groupId: record.groupId
    })
    await handler.handle('vault.group.summary', { scope })
    expect(forwarded).toHaveLength(2)
    // Offscreen treats any forwarded payload with `walletId` as a wallet RPC (recovery, re-init).
    for (const payload of forwarded) expect(Object.keys(payload)).not.toContain('walletId')
  })

  test('the page opens a DKG session through Background', async () => {
    const port = await readSource('src/core/multisig/worker-dkg-port.ts')
    expect(port).toContain("'vault.group.open'")
    expect(port).not.toContain("'vault.dkg.open'")
    expect(port).toContain("'vault.group.save'")
    // A save counts only when Background answers exactly `true`; anything else fails closed.
    expect(port).toContain("(await requestVaultGroup('vault.group.save', request)) !== true")
    expect(port).toContain("throw new Error('Vault record could not be saved')")
  })

  test('wallet removal and reset clear multisig data independently of the feature flag', async () => {
    const source = await readSource('src/background/wallet-cleanup.ts')
    const count = (needle: string) => source.split(needle).length - 1
    expect(count('completeWalletMetadataDeletion(walletId)')).toBe(4)
    expect(count('await this.removeMultisigWalletData(walletId)')).toBe(4)
    expect(source).toContain('this.removeMultisigAccountData(walletId, accountId)')
    expect(source).toContain('this.resetMultisigData()')
    expect(count('if (!isMultisigUiEnabled()) return')).toBe(0)
  })
})
