import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  ledgerCandidatePaths,
  ledgerCandidateIsRegistered
} from '../../../src/popup/services/ledger-account-discovery-model.ts'

it('pages independent device paths and preserves Ledger Live versus legacy addresses', () => {
  assert.deepEqual(ledgerCandidatePaths('evm', 'ledger-live', 5, 'mainnet'), [
    "m/44'/60'/5'/0/0",
    "m/44'/60'/6'/0/0",
    "m/44'/60'/7'/0/0",
    "m/44'/60'/8'/0/0",
    "m/44'/60'/9'/0/0"
  ])
  assert.equal(ledgerCandidatePaths('evm', 'standard', 5, 'mainnet')[0], "m/44'/60'/0'/0/5")
  assert.equal(ledgerCandidatePaths('evm', 'legacy', 5, 'mainnet')[0], "m/44'/60'/0'/5")
  assert.equal(ledgerCandidatePaths('near', 'standard', 2, 'mainnet')[0], "m/44'/397'/0'/0'/2'")
  assert.equal(ledgerCandidatePaths('near', 'noir', 2, 'mainnet')[0], "m/44'/397'/2'/0'/1'")
  assert.equal(ledgerCandidatePaths('bitcoin', 'standard', 8, 'testnet')[0], "m/84'/1'/8'")
  assert.deepEqual(ledgerCandidatePaths('solana', 'root', 0, 'mainnet'), ["m/44'/501'"])
  assert.throws(() => ledgerCandidatePaths('solana', 'root', 1, 'mainnet'))
  assert.throws(() => ledgerCandidatePaths('bitcoin', 'ledger-live', 0, 'mainnet'))
  assert.throws(() => ledgerCandidatePaths('evm', 'standard', 0x80000000, 'mainnet'))
  assert.equal(ledgerCandidatePaths('evm', 'standard', 0x7fffffff, 'mainnet').length, 1)
})

it('marks an existing device root as registered across logical account indexes and separates networks', () => {
  const account = {
    family: 'bitcoin',
    accountIndex: 0,
    derivationPath: "m/84'/0'/8'",
    network: 'mainnet'
  }
  const existing = { schemaVersion: 3, accountExport: { accounts: [account] } }
  assert.equal(ledgerCandidateIsRegistered({ ...account, accountIndex: 2 }, existing), true)
  assert.equal(
    ledgerCandidateIsRegistered({ ...account, derivationPath: "m/84'/0'/9'" }, existing),
    false
  )
  assert.equal(ledgerCandidateIsRegistered({ ...account, network: 'testnet' }, existing), false)
})
