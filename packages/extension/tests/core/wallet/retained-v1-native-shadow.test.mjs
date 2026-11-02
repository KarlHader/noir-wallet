import assert from 'node:assert/strict'
import { it } from 'node:test'
import { excludeNativeV2HardwareShadows } from '../../../src/infrastructure/persistence/migrations/retained-v1-discovery.ts'
import { inventoryAlreadyMatches } from '../../../src/infrastructure/keyring/migration/retained-v1-inventory-support.ts'
import { reconcileActiveHardwareCredentials } from '../../../src/infrastructure/keyring/migration/hardware-credential-reconciliation.ts'

const software = {
  id: 'software-wallet',
  displayName: 'Software',
  keySource: 'software',
  credentialStorageKey: 'seed_software-wallet',
  createdAt: 1,
  accounts: [{ id: 'software-account', displayName: 'Software account', accountIndex: 0 }]
}
const nativeLedgerShadow = {
  id: 'wallet:ledger-v3:device',
  displayName: 'Ledger',
  keySource: 'ledger',
  credentialStorageKey: 'hw_wallet:ledger-v3:device',
  createdAt: 2,
  accounts: [{ id: 'ledger-account', displayName: 'Ledger account', accountIndex: 0 }]
}
const nativeLedgerKeyDomain = {
  id: nativeLedgerShadow.id,
  displayName: nativeLedgerShadow.displayName,
  source: { kind: 'hardware', vendor: 'ledger' }
}
const nativeLedgerAccount = {
  id: 'ledger-account',
  keyDomainId: nativeLedgerShadow.id,
  displayName: 'Ledger account',
  accountIndex: 3
}
const snapshot = {
  manifest: { activeAccount: { keyDomainId: nativeLedgerShadow.id, accountId: 'ledger-account' } },
  keyDomains: [
    { id: software.id, displayName: software.displayName, source: { kind: 'software' } },
    nativeLedgerKeyDomain
  ],
  accounts: [
    {
      id: 'software-account',
      keyDomainId: software.id,
      displayName: 'Software account',
      accountIndex: 0
    },
    nativeLedgerAccount
  ]
}

it('reconciles retained software without treating a native Ledger Zcash projection as V1', async () => {
  const discovery = {
    status: 'ready',
    source: 'wallet_state',
    currentWalletId: nativeLedgerShadow.id,
    currentAccountId: nativeLedgerAccount.id,
    wallets: [software, nativeLedgerShadow],
    issues: []
  }
  const retained = excludeNativeV2HardwareShadows(discovery, snapshot)
  assert.deepEqual(
    retained.wallets.map(wallet => wallet.id),
    [software.id]
  )
  assert.equal(retained.currentWalletId, nativeLedgerShadow.id)
  assert.equal(retained.currentAccountId, nativeLedgerAccount.id)

  await reconcileActiveHardwareCredentials(
    new Proxy(
      {},
      {
        get: () => {
          throw new Error('Native credential must use V2 verification')
        }
      }
    ),
    snapshot,
    retained,
    {},
    'test-password',
    { allowRemovedWallets: true }
  )
  assert.equal(
    inventoryAlreadyMatches(snapshot, retained, [
      { wallet: software, existingCredentialSet: {}, newAccounts: [] }
    ]),
    true
  )
})

it('retains legacy hardware and mismatched native IDs for V1 reconciliation', () => {
  const legacyHardware = { ...nativeLedgerShadow, id: 'legacy-ledger' }
  const discovery = {
    status: 'ready',
    source: 'wallet_state',
    currentWalletId: software.id,
    currentAccountId: 'software-account',
    wallets: [software, legacyHardware, nativeLedgerShadow],
    issues: []
  }
  const retained = excludeNativeV2HardwareShadows(discovery, snapshot)
  assert.deepEqual(
    retained.wallets.map(wallet => wallet.id),
    [software.id, legacyHardware.id]
  )
  assert.equal(
    excludeNativeV2HardwareShadows(discovery, {
      ...snapshot,
      keyDomains: snapshot.keyDomains.map(keyDomain =>
        keyDomain.id === nativeLedgerShadow.id
          ? { ...nativeLedgerKeyDomain, source: { kind: 'hardware', vendor: 'keystone' } }
          : keyDomain
      )
    }).wallets.length,
    3
  )
})
