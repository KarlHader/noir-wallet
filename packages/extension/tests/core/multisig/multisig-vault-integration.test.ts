/**
 * The Background vault handler, the vault storage module and the Worker vault handler joined with
 * no fakes between them. Only wallet state, unlock state and credential binding are injected.
 */
import { afterEach, before, beforeEach, test } from 'node:test'
import { expect } from '@playwright/test'
import { createMultisigVaultHandler } from '../../../src/background/multisig-vault'
import type { VaultWasm } from '../../../src/core/multisig/dkg-protocol'
import { createVaultDkgRpcHandler } from '../../../src/core/multisig/dkg-rpc'
import {
  readMultisigGroup,
  writeMultisigGroup,
  type MultisigGroupScope
} from '../../../src/lib/multisig-group-storage'
import { readVaultRecord, saveVaultRecordVerified } from '../../../src/lib/multisig-vault-storage'
import { callVaultDkg, runRounds, type Round2Complete } from './helpers/raw-phone'
import { installStorageEnv } from './helpers/storage-env'
import { TEST_MNEMONIC, loadVaultWasm } from './helpers/vault-wasm'

const SCOPE: MultisigGroupScope = { network: 'testnet', walletId: 'wallet-1', accountId: 'acc-1' }
const SHAPE = { participants: 3, threshold: 2 } as const
const GROUP_A = '11111111-2222-4333-8444-555555555555'
const GROUP_B = '66666666-7777-4888-9999-aaaaaaaaaaaa'

let wasm: VaultWasm
let env: ReturnType<typeof installStorageEnv>

before(async () => {
  wasm = await loadVaultWasm()
})

beforeEach(() => {
  env = installStorageEnv()
})

afterEach(() => {
  env.restore()
})

function setup() {
  const worker = createVaultDkgRpcHandler(wasm, () => TEST_MNEMONIC)
  const background = createMultisigVaultHandler({
    readWalletState: async () => ({
      network: 'testnet',
      activeWalletId: SCOPE.walletId,
      wallets: [{ id: SCOPE.walletId, mnemonic: true, accountIds: [SCOPE.accountId] }]
    }),
    isUnlocked: async () => true,
    bindCredential: async () => true,
    forwardToWorker: (method, payload) => callVaultDkg(worker, method, payload),
    readRecord: readVaultRecord,
    saveRecord: saveVaultRecordVerified,
    readGroupId: async scope => (await readMultisigGroup(scope))?.groupId ?? null
  })
  return { worker, background }
}

/** Opens through Background, plays both rounds against the Worker and closes the session. */
async function ceremony(
  { worker, background }: ReturnType<typeof setup>,
  groupId: string
): Promise<Round2Complete> {
  const { sessionId } = await background.handle('vault.group.open', {
    ...SHAPE,
    mainnet: false,
    scope: SCOPE,
    groupId
  })
  const r2 = await runRounds(wasm, worker, SHAPE, sessionId)
  await callVaultDkg(worker, 'vault.dkg.close', { sessionId })
  return r2
}

function writeGroup(groupId: string, fingerprint: string): Promise<void> {
  return writeMultisigGroup(SCOPE, {
    groupId,
    threshold: '2-of-3',
    transportKind: 'ble',
    devices: [],
    fingerprint,
    createdAt: 1,
    mock: true
  })
}

test.describe('multisig vault integration', () => {
  test('two ceremonies on one account: the second record replaces the first once its group is written', async () => {
    const pieces = setup()
    const { background } = pieces
    const summary = () => background.handle('vault.group.summary', { scope: SCOPE })

    const a = await ceremony(pieces, GROUP_A)
    await writeGroup(GROUP_A, a.fingerprint)
    expect(
      await background.handle('vault.group.save', {
        scope: SCOPE,
        groupId: GROUP_A,
        record: a.record
      })
    ).toBe(true)
    expect(await summary()).toEqual({
      status: 'ok',
      fingerprint: a.fingerprint,
      address: expect.any(String),
      participants: SHAPE.participants,
      threshold: SHAPE.threshold
    })

    const b = await ceremony(pieces, GROUP_B)
    expect(
      await background.handle('vault.group.save', {
        scope: SCOPE,
        groupId: GROUP_B,
        record: b.record
      })
    ).toBe(true)
    // The group record still names A, so B's record is not vouched for yet.
    expect(await summary()).toEqual({ status: 'missing' })

    await writeGroup(GROUP_B, b.fingerprint)
    expect((await readVaultRecord(SCOPE))?.groupId).toBe(GROUP_B)
    const final = await summary()
    expect(final).toMatchObject({ status: 'ok', fingerprint: b.fingerprint })
    expect(b.fingerprint).not.toBe(a.fingerprint)
  })
})
