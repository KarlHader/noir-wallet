import assert from 'node:assert/strict'
import { it } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { ed25519 } from '@noble/curves/ed25519'
import { HDKey } from '@scure/bip32'
import { publicKeyToAddress } from 'viem/accounts'
import {
  createLedgerMultichainHardwareCredential,
  parseStoredHardwareCredential,
  createLedgerHardwareCredential,
  legacyZcashHardwareWalletData,
  findLedgerPublicAccount
} from '../../../src/core/wallet/hardware-wallet-data.ts'
import { deriveLedgerBitcoinAddress } from '../../../src/lib/ledger/bitcoin-model.ts'
import { parseHardwareCredentialMetadata } from '../../../src/core/keyring/domain/hardware-credential.ts'
import { encodeSolanaBase58 } from '../../../src/infrastructure/chains/solana/solana-rpc-codecs.ts'
import { nearPublicKeyFromImplicitAccountId } from '../../../src/core/chains/near/identifiers.ts'
import {
  assertRetainedDisabledLedgerAccounts,
  assertRetainedDisabledLedgerProjections
} from '../../../src/core/wallet/ledger-feature-policy.ts'
import { getBitcoinChainId } from '../../../src/core/chains/registry/index.ts'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '../../../src/config/networks.ts'

const key = `0x${secp256k1.getPublicKey(new Uint8Array(32).fill(3), false).reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '')}`
const evm = {
  family: 'evm',
  accountIndex: 0,
  derivationPath: "m/44'/60'/7'/0/2",
  publicKey: key,
  address: publicKeyToAddress(key).toLowerCase()
}
const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(5))
const btcRoot = master.derive("m/84'/0'/8'")
const btcReceive = deriveLedgerBitcoinAddress(btcRoot.publicExtendedKey, 'mainnet', false, 0)
const bitcoin = {
  family: 'bitcoin',
  accountIndex: 0,
  derivationPath: "m/84'/0'/8'",
  network: 'mainnet',
  xpub: btcRoot.publicExtendedKey,
  masterFingerprintHex: master.fingerprint.toString(16).padStart(8, '0'),
  publicKey: btcReceive.publicKey,
  address: btcReceive.address
}
const device = { deviceModel: 'nanoX', deviceName: 'Ledger Test' }

it('registers capabilities from actual exports and keeps logical indexes independent of device paths', () => {
  const credential = createLedgerMultichainHardwareCredential({
    ...device,
    accounts: [evm, bitcoin]
  })
  assert.equal(credential.schemaVersion, 3)
  assert.deepEqual(credential.capabilities, ['bitcoin', 'evm'])
  assert.equal(
    findLedgerPublicAccount(credential, { family: 'evm', accountIndex: 0 }).derivationPath,
    evm.derivationPath
  )
  assert.equal(findLedgerPublicAccount(credential, { family: 'solana' }), null)
  assert.deepEqual(parseStoredHardwareCredential(credential), credential)
  assert.deepEqual(
    parseHardwareCredentialMetadata({
      vendor: 'ledger',
      firmwareProfile: 'multi-app',
      capabilities: credential.capabilities
    }).capabilities,
    credential.capabilities
  )
  assert.throws(
    () =>
      parseStoredHardwareCredential({ ...credential, capabilities: ['bitcoin', 'evm', 'near'] }),
    /capabilities/
  )
  assert.throws(
    () =>
      parseHardwareCredentialMetadata({
        vendor: 'ledger',
        firmwareProfile: 'multi-app',
        capabilities: ['tron']
      }),
    /Ledger/
  )
})

it('rejects public-key, Bitcoin network, xpub path and duplicate registration tampering', () => {
  const create = accounts => createLedgerMultichainHardwareCredential({ ...device, accounts })
  assert.throws(() => create([{ ...evm, address: '0x' + '0'.repeat(40) }]), /address/)
  assert.throws(() => create([{ ...evm, derivationPath: "m/44'/60'/07'/0/2" }]), /canonical/)
  assert.throws(() => create([{ ...bitcoin, network: 'testnet' }]), /path/)
  assert.throws(() => create([{ ...bitcoin, derivationPath: "m/84'/0'/7'" }]), /xpub/)
  assert.throws(() => create([evm, { ...evm, accountIndex: 1 }]), /already registered/)
  assert.throws(() => create([bitcoin, { ...bitcoin, accountIndex: 1 }]), /already registered/)
  assert.throws(() => create([{ ...bitcoin, masterFingerprintHex: '0'.repeat(64) }]), /fingerprint/)
})

it('keeps selected device paths in public credentials across supported presets', () => {
  const edKey = ed25519.getPublicKey(new Uint8Array(32).fill(8))
  const solanaKey = encodeSolanaBase58(edKey)
  const nearAddress = Buffer.from(edKey).toString('hex')
  const nearKey = nearPublicKeyFromImplicitAccountId(nearAddress)
  const accounts = [
    { ...evm, accountIndex: 0, derivationPath: "m/44'/60'/0'/0/0" },
    { ...evm, accountIndex: 1, derivationPath: "m/44'/60'/1'/0/0" },
    { ...evm, accountIndex: 2, derivationPath: "m/44'/60'/0'/2" },
    {
      family: 'solana',
      accountIndex: 0,
      derivationPath: "m/44'/501'",
      publicKey: solanaKey,
      address: solanaKey
    },
    {
      family: 'solana',
      accountIndex: 1,
      derivationPath: "m/44'/501'/1'/0'",
      publicKey: solanaKey,
      address: solanaKey
    },
    {
      family: 'near',
      accountIndex: 0,
      derivationPath: "m/44'/397'/0'/0'/0'",
      publicKey: nearKey,
      address: nearAddress
    },
    {
      family: 'near',
      accountIndex: 1,
      derivationPath: "m/44'/397'/1'/0'/1'",
      publicKey: nearKey,
      address: nearAddress
    }
  ]
  const credential = createLedgerMultichainHardwareCredential({ ...device, accounts })
  assert.deepEqual(
    credential.accountExport.accounts.map(account => account.derivationPath),
    accounts.map(account => account.derivationPath)
  )
  assert.equal(credential.schemaVersion, 3)
})

it('retains old disabled Ledger accounts while extending EVM and Zcash only', () => {
  const edKey = ed25519.getPublicKey(new Uint8Array(32).fill(8))
  const solanaKey = encodeSolanaBase58(edKey)
  const nearAddress = Buffer.from(edKey).toString('hex')
  const solana = {
    family: 'solana',
    accountIndex: 0,
    derivationPath: "m/44'/501'",
    publicKey: solanaKey,
    address: solanaKey
  }
  const near = {
    family: 'near',
    accountIndex: 0,
    derivationPath: "m/44'/397'/0'/0'/0'",
    publicKey: nearPublicKeyFromImplicitAccountId(nearAddress),
    address: nearAddress
  }
  const zcash = {
    family: 'zcash',
    accountIndex: 0,
    derivationPath: "m/32'/133'/9'",
    network: 'mainnet',
    ufvk: 'uview1public-unfunded-vector',
    accountHdIndex: 9
  }
  const prior = createLedgerMultichainHardwareCredential({
    ...device,
    accounts: [bitcoin, solana, near]
  }).accountExport.accounts
  const incoming = createLedgerMultichainHardwareCredential({
    ...device,
    accounts: [bitcoin, solana, near, evm, zcash]
  }).accountExport.accounts
  const enabled = ['chain.zcash', 'chain.evm']
  const disabled = assertRetainedDisabledLedgerAccounts(prior, incoming, prior[0], enabled)
  assert.deepEqual(
    disabled.map(account => account.family),
    ['bitcoin', 'solana', 'near']
  )
  const keyDomainId = 'wallet:ledger-retained'
  const scope = { keyDomainId, accountId: 'account:ledger-retained' }
  const snapshot = {
    accounts: [{ id: scope.accountId, keyDomainId, accountIndex: 0 }],
    chainAccounts: [
      getBitcoinChainId('mainnet'),
      getSolanaNetworkConfig('mainnet').chainId,
      getNearNetworkConfig('mainnet').chainId
    ].map(chainId => ({ scope: { ...scope, chainId } }))
  }
  assert.doesNotThrow(() =>
    assertRetainedDisabledLedgerProjections(snapshot, keyDomainId, 'mainnet', disabled)
  )
  assert.throws(
    () =>
      assertRetainedDisabledLedgerProjections(
        { ...snapshot, chainAccounts: snapshot.chainAccounts.slice(1) },
        keyDomainId,
        'mainnet',
        disabled
      ),
    /not enabled/
  )
  assert.throws(
    () =>
      assertRetainedDisabledLedgerAccounts(
        prior,
        [...incoming, { ...solana, accountIndex: 1, derivationPath: "m/44'/501'/1'/0'" }],
        prior[0],
        enabled
      ),
    /not enabled/
  )
  assert.throws(
    () =>
      assertRetainedDisabledLedgerAccounts(
        prior,
        incoming.map(account =>
          account.family === 'bitcoin' ? { ...account, address: 'bc1qchanged' } : account
        ),
        prior[0],
        enabled
      ),
    /not enabled/
  )
  assert.throws(
    () =>
      assertRetainedDisabledLedgerAccounts(
        prior,
        incoming.filter(account => account.family !== 'near'),
        prior[0],
        enabled
      ),
    /not enabled/
  )
})

it('keeps schema-2 Zcash credentials and their unavailable fingerprint intact during upgrade', () => {
  const legacy = createLedgerHardwareCredential({
    ...device,
    ufvk: 'uview1public-unfunded-vector',
    accountHdIndex: 9,
    ledgerSigningTransport: 'bluetooth'
  })
  assert.equal(parseStoredHardwareCredential(legacy).schemaVersion, 2)
  assert.equal(parseStoredHardwareCredential(legacy).ledgerSigningTransport, 'bluetooth')
  assert.equal(legacy.accountExport.seedFingerprintHex, '0'.repeat(64))
  const zcash = {
    family: 'zcash',
    accountIndex: 0,
    derivationPath: "m/32'/133'/9'",
    network: 'mainnet',
    ufvk: legacy.accountExport.ufvk,
    accountHdIndex: 9
  }
  const upgraded = createLedgerMultichainHardwareCredential({
    ...device,
    accounts: [zcash, evm],
    ledgerSigningTransport: legacy.ledgerSigningTransport
  })
  assert.deepEqual(legacyZcashHardwareWalletData(upgraded), legacyZcashHardwareWalletData(legacy))
  assert.equal(parseStoredHardwareCredential(upgraded).ledgerSigningTransport, 'bluetooth')
  assert.throws(
    () => parseStoredHardwareCredential({ ...upgraded, ledgerSigningTransport: 'wireless' }),
    /Invalid Ledger multichain credential/
  )
  assert.throws(
    () =>
      parseStoredHardwareCredential({
        ...legacy,
        accountExport: { ...legacy.accountExport, seedFingerprintHex: '1'.repeat(64) }
      }),
    /fingerprint/
  )
})
