import test from 'node:test'
import assert from 'node:assert/strict'
import * as resolution from '../../../../src/core/worker/account-resolution.ts'

const identity = {
  walletId: 'wallet',
  accountId: 'frost-account',
  groupId: 'group',
  network: 'mainnet'
}
function database() {
  const entries = new Map()
  let imports = 0
  return {
    entries,
    get imports() {
      return imports
    },
    async findByName(name) {
      return [...entries].find(([, value]) => value.name === name)?.[0] ?? null
    },
    async getHdIndex(id) {
      return entries.get(id)?.index ?? null
    },
    async getAddresses(id) {
      return { unified: entries.get(id)?.address }
    },
    async importAccount(name) {
      imports++
      entries.set(72, { name, address: 'vault-address' })
      return 72
    }
  }
}

test('external import resolves its own stable identity after reload and never adopts HD account zero', async () => {
  const db = database()
  db.entries.set(0, { name: 'Account', index: 0, address: 'hd-address' })
  const imported = await resolution.registerExternalWasmAccount(db, identity, 'vault-address')
  assert.equal(imported, 72)
  assert.equal(await resolution.resolveExternalWasmAccount(db, identity, 'vault-address'), 72)
  assert.equal(await resolution.registerExternalWasmAccount(db, identity, 'vault-address'), 72)
  assert.equal(db.imports, 1)
  assert.equal(
    await resolution.resolveExternalWasmAccount(
      db,
      { ...identity, network: 'testnet' },
      'vault-address'
    ),
    null
  )
})

test('external resolution refuses an HD/name collision or changed viewing identity', async () => {
  const db = database()
  await resolution.registerExternalWasmAccount(db, identity, 'vault-address')
  db.entries.get(72).index = 0
  await assert.rejects(
    resolution.resolveExternalWasmAccount(db, identity, 'vault-address'),
    /identity/
  )
  delete db.entries.get(72).index
  await assert.rejects(
    resolution.resolveExternalWasmAccount(db, identity, 'other-address'),
    /identity/
  )
  assert.equal(db.imports, 1)
})

import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { mapWasmAccountAddresses } from '../../../../src/core/zcash/account-addresses.ts'
import * as accountSource from '../../../../src/core/accounts/domain/account-source.ts'
function coreWith(client) {
  const source = readFileSync(
    new URL('../../../../src/core/zcash/wallet-core.ts', import.meta.url),
    'utf8'
  )
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    name =>
      ({
        '../worker/client': { getWorkerClient: () => client },
        '@/lib/runtime-network': { getNetworkConfig: () => ({ rpcUrl: 'http://localhost' }) },
        '@/lib/logger': { logger: { log() {}, warn() {} } },
        './account-addresses': { mapWasmAccountAddresses },
        './wallet-rpc-errors': { isRetryableWalletRpcError: () => false },
        '../accounts/domain/account-source': accountSource
      })[name] ?? {},
    module,
    module.exports
  )
  return new module.exports.ZcashWalletCore({
    walletId: 'wallet',
    network: 'mainnet',
    lightwalletdUrl: 'http://localhost'
  })
}
const source = { kind: 'frost-vault', version: 1, groupId: 'group', network: 'mainnet' }
test('external core selection clears seed state and rejects software signing and HD address fallbacks', async () => {
  const requestedSource = { ...source }
  const core = coreWith({
    async registerFrostAccount() {
      requestedSource.groupId = 'changed-during-registration'
      return 72
    },
    markAccountReady() {},
    async getUnifiedAddresses(id) {
      assert.equal(id, 72)
      return { unified: 'vault-address' }
    }
  })
  core.setSeedPhrase('synthetic phrase', 0)
  await core.registerFrostAccount({
    accountId: identity.accountId,
    source: requestedSource,
    sealedRecord: {}
  })
  assert.notEqual(core.accountSource, requestedSource)
  assert.equal(Object.isFrozen(core.accountSource), true)
  assert.equal(core.accountSource.groupId, source.groupId)
  requestedSource.groupId = 'other-group'
  assert.equal(core.accountSource.groupId, source.groupId)
  assert.equal(core.accountIndex, undefined)
  assert.equal(core.isSessionCredentialReady(), false)
  assert.equal((await core.getAddresses()).shielded, 'vault-address')
  assert.throws(() => core.setSessionCredential(0), /external/i)
  assert.throws(() => core.setSeedPhrase('synthetic phrase', 0), /external/i)
  await assert.rejects(core.sendTransaction({ to: 'x', amount: '1' }), /external/i)
  await assert.rejects(core.signMessage('x'), /external/i)
  await assert.rejects(core.getAddresses('synthetic phrase', 'mainnet', 0), /external/i)
})
test('default DB restore never adopts an unlabelled external account as HD zero', async () => {
  const core = coreWith({
    async getAccountIds() {
      return [72]
    },
    async getAccountHdIndex() {
      return null
    }
  })
  assert.equal(await core.restoreFromDB(), false)
  assert.equal(core.accountId, null)
})
