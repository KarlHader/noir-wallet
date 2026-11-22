import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCompatibilityWorkerRequest } from '../../../src/infrastructure/keyring/migration/compatibility-worker-protocol.ts'
import { assertCredentialOnlyVaultMatchesMnemonic } from '../../../src/infrastructure/keyring/migration/credential-only-vault-proof.ts'
import {
  assertKeystoneZcashVerificationMatches,
  parseKeystoneZcashVerificationInput
} from '../../../src/infrastructure/keyring/migration/keystone-hardware-verification.ts'
import { discoverV1Metadata } from '../../../src/infrastructure/persistence/migrations/v1-metadata-discovery.ts'
import { V1_MIGRATION_FIXTURES } from '../../fixtures/v1-migration-fixtures.mjs'

const envelope = {
  encryptedData: 'Zml4dHVyZS1jaXBoZXJ0ZXh0',
  salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
  iv: 'AAAAAAAAAAAAAAAA'
}
const expected = {
  transparent: 't-public-test',
  shielded: 'u-public-test',
  fullUnified: 'u-full-public-test'
}

function compatibilityRequest(addresses) {
  return {
    id: 'migration-test',
    operation: 'migrate',
    envelope,
    password: 'test-password',
    zcashNetwork: 'mainnet',
    zcashChainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
    evmChainId: 'eip155:1',
    bitcoinChainId: 'bip122:000000000019d6689c085ae165831e93',
    accounts: [{ accountIndex: 0, expectedZcash: addresses }]
  }
}

function keystoneInput(addresses) {
  return {
    envelope,
    password: 'test-password',
    network: 'mainnet',
    chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
    account: { accountIndex: 0, birthdayHeight: 2_000_000, expected: addresses }
  }
}

test('migration parsers accept a validated transparent index without changing verification addresses', () => {
  for (const index of [0, 0x7fffffff]) {
    const addresses = { ...expected, transparentAddressIndex: index }
    const compatibility = parseCompatibilityWorkerRequest(compatibilityRequest(addresses))
    const hardware = parseKeystoneZcashVerificationInput(keystoneInput(addresses))
    assert.deepEqual(compatibility.accounts[0].expectedZcash, expected)
    assert.deepEqual(hardware.account.expected, expected)
    assertKeystoneZcashVerificationMatches(
      {
        accountIndex: 0,
        chainId: hardware.chainId,
        derivationPath: "m/32'/133'/0'",
        identity: expected.fullUnified,
        ...expected
      },
      {
        accountIndex: 0,
        expected: hardware.account.expected,
        chainId: hardware.chainId,
        network: 'mainnet'
      }
    )
  }
})

test('migration parsers reject invalid indexes and unrelated address fields', () => {
  for (const index of [-1, 0x80000000, 1.5, '1', null, undefined]) {
    const addresses = { ...expected, transparentAddressIndex: index }
    assert.throws(() => parseCompatibilityWorkerRequest(compatibilityRequest(addresses)))
    assert.throws(() => parseKeystoneZcashVerificationInput(keystoneInput(addresses)))
  }
  const unexpected = { ...expected, transparentAddressIndex: 1, extra: 'ignored?' }
  assert.throws(() => parseCompatibilityWorkerRequest(compatibilityRequest(unexpected)))
  assert.throws(() => parseKeystoneZcashVerificationInput(keystoneInput(unexpected)))
})

test('V1 discovery preserves only valid optional transparent indexes', () => {
  const fixture = V1_MIGRATION_FIXTURES.find(item => item.id === 'software-single-account')
  assert.ok(fixture)
  const local = structuredClone(fixture.local)
  const state = JSON.parse(local.wallet_state)
  const addresses = state.state.wallets[0].accounts[0].addresses

  addresses.transparentAddressIndex = 1
  local.wallet_state = JSON.stringify(state)
  let discovery = discoverV1Metadata(local)
  assert.equal(discovery.status, 'ready')
  assert.equal(discovery.wallets[0].accounts[0].addresses.transparentAddressIndex, 1)

  addresses.transparentAddressIndex = -1
  local.wallet_state = JSON.stringify(state)
  discovery = discoverV1Metadata(local)
  assert.equal(discovery.status, 'ready')
  assert.equal('transparentAddressIndex' in discovery.wallets[0].accounts[0].addresses, false)
})

test('credential-only migration request requires an explicit empty-account mode', () => {
  const request = { ...compatibilityRequest(expected), accounts: [] }
  assert.throws(() => parseCompatibilityWorkerRequest(request))
  assert.deepEqual(
    parseCompatibilityWorkerRequest({ ...request, credentialOnly: true }).accounts,
    []
  )
  assert.throws(() =>
    parseCompatibilityWorkerRequest({ ...compatibilityRequest(expected), credentialOnly: true })
  )
})

test('credential-only target vault must derive the retained mnemonic identity', () => {
  const account = address => ({
    accountId: `eip155:1:${address}`,
    address,
    derivationPath: "m/44'/60'/0'/0/0",
    publicKey: `0x02${'11'.repeat(32)}`,
    curve: 'secp256k1',
    addressScheme: 'evm',
    derivationScheme: 'bip44'
  })
  const target = account(`0x${'22'.repeat(20)}`)
  const retained = account(`0x${'33'.repeat(20)}`)
  const engine = {
    deriveEvmAccount(sessionId) {
      return sessionId === 1 ? target : retained
    }
  }
  assert.throws(() => assertCredentialOnlyVaultMatchesMnemonic(engine, 1, 2, 'eip155:1'))
  target.address = retained.address
  target.accountId = retained.accountId
  assert.doesNotThrow(() => assertCredentialOnlyVaultMatchesMnemonic(engine, 1, 2, 'eip155:1'))
})
