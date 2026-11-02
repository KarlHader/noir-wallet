import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveScopedZcashActivityTransaction } from '../../../../src/popup/services/zcash-activity-detail.ts'
import { isWalletSnapshotIntegrityError } from '../../../../src/lib/wallet-snapshot-errors.ts'
import { isWalletSnapshotRecoveryError, classifyError } from '../../../../src/lib/errors.ts'
import {
  getSpeedUpConfirmationError,
  resolveWalletSnapshotRecoveryTarget
} from '../../../../src/lib/transaction-replacement.ts'
import { getStoredTransparentAddressPath } from '../../../../src/lib/zcash-derivation.ts'
import {
  getActivityTransactionReferences,
  isActivityTransactionHash
} from '../../../../src/popup/services/activity-transaction-references.ts'
import { buildMyAccountRecipientGroups } from '../../../../src/popup/components/transaction/recipient-selector-model.ts'
import { mapZcashV1TransactionToActivityItem } from '../../../../src/infrastructure/activity/zcash-v1-activity-source.ts'
import { getActivityFailureLabel } from '../../../../src/popup/components/transaction/multichain-activity-presentation.ts'
import { isActivityModelForScope } from '../../../../src/popup/services/activity-list-model.ts'

const expiredSend = {
  id: 'tx-1',
  status: 'failed',
  failureReason: 'expired',
  type: 'send',
  network: 'mainnet',
  txHash: '',
  to: 'u1recipient',
  fee: '0.0001',
  memo: 'private note'
}
const item = {
  id: 'tx-1',
  source: 'zcash-v1',
  scope: { keyDomainId: 'wallet-1', accountId: 'account-1' }
}

test('Activity never reuses a read model from another wallet with a matching account ID', () => {
  const model = { scope: item.scope, items: [], partialItemCount: 0 }
  assert.equal(isActivityModelForScope(model, 'wallet-1', 'account-1'), true)
  assert.equal(isActivityModelForScope(model, 'wallet-2', 'account-1'), false)
  assert.equal(isActivityModelForScope(model, 'wallet-1', 'account-2'), false)
  assert.equal(isActivityModelForScope(model, null, 'account-1'), false)
  assert.equal(isActivityModelForScope(null, 'wallet-1', 'account-1'), false)
})

test('Activity recovery resolves only the original transaction in the active scope', () => {
  assert.equal(
    resolveScopedZcashActivityTransaction(item, [expiredSend], {
      walletId: 'wallet-1',
      accountId: 'account-1',
      network: 'mainnet'
    }),
    expiredSend
  )
  assert.equal(
    resolveScopedZcashActivityTransaction(item, [expiredSend], {
      walletId: 'wallet-2',
      accountId: 'account-1',
      network: 'mainnet'
    }),
    null
  )
  assert.equal(
    resolveScopedZcashActivityTransaction(item, [expiredSend], {
      walletId: 'wallet-1',
      accountId: 'account-1',
      network: 'testnet'
    }),
    null
  )
})

test('Speed Up confirmation requires the original account, network, and eligible transaction', () => {
  const original = {
    ...expiredSend,
    amount: '0.05',
    from: 'u1sender',
    fromType: 'shielded'
  }
  const expected = 'mainnet_wallet-1_account-1'
  const validate = (transactions, active = expected) =>
    getSpeedUpConfirmationError(original, transactions, expected, active)

  assert.equal(validate([original]), null)
  assert.equal(validate([original], 'mainnet_wallet-2_account-1'), 'account_changed')
  assert.equal(validate([original], 'mainnet_wallet-1_account-2'), 'account_changed')
  assert.equal(validate([original], 'testnet_wallet-1_account-1'), 'account_changed')
  assert.equal(validate([]), 'transaction_changed')
  assert.equal(validate([{ ...original, failureReason: 'timeout' }]), 'transaction_changed')
  assert.equal(validate([{ ...original, status: 'pending' }]), 'transaction_changed')
  assert.equal(
    validate([{ ...original, replacedByTransactionId: 'replacement' }]),
    'transaction_changed'
  )
  assert.equal(validate([{ ...original, to: 'u1other' }]), 'transaction_changed')
  assert.equal(validate([{ ...original, network: 'testnet' }]), 'transaction_changed')
  assert.equal(
    validate([
      original,
      { ...original, id: 'replacement', status: 'pending', replacesTransactionId: original.id }
    ]),
    'transaction_changed'
  )
  assert.equal(
    validate([
      original,
      {
        ...original,
        id: 'replacement',
        status: 'failed',
        txHash: '',
        replacesTransactionId: original.id
      }
    ]),
    null
  )
})

test('Zcash Activity preserves a known mined-expiry reason without changing approval expiry copy', () => {
  const transaction = {
    ...expiredSend,
    amount: '0.01',
    from: 't1sender',
    fromType: 'transparent',
    timestamp: 1_000
  }
  const scope = { keyDomainId: 'key-domain:zcash-v1', accountId: 'account:zcash-v1' }
  const expired = mapZcashV1TransactionToActivityItem(transaction, scope)
  assert.equal(expired.failureCode, 'expired')
  assert.equal(expired.segments[0].failureCode, 'expired')
  assert.equal(
    getActivityFailureLabel(expired.failureCode, expired.segments[0].evidence, expired.source),
    'Expired before it was mined'
  )
  assert.equal(getActivityFailureLabel('expired'), 'Approval expired')

  const timeout = mapZcashV1TransactionToActivityItem(
    { ...transaction, failureReason: 'timeout' },
    scope
  )
  assert.equal(timeout.failureCode, 'unknown')
  assert.equal(timeout.segments[0].failureCode, 'unknown')
})

test('snapshot recovery accepts a matching unbroadcast record and isolates corruption from RPC errors', () => {
  const wallets = [{ id: 'wallet-1', accounts: [{ id: 'account-1', birthdayHeight: 123 }] }]
  const target = resolveWalletSnapshotRecoveryTarget(
    'mainnet_wallet-1_account-1',
    'tx-1',
    expiredSend,
    wallets,
    'mainnet'
  )
  assert.deepEqual(target, {
    walletId: 'wallet-1',
    accountId: 'account-1',
    network: 'mainnet',
    birthdayHeight: 123
  })
  assert.equal(
    resolveWalletSnapshotRecoveryTarget(
      'mainnet_wallet-2_account-1',
      'tx-1',
      expiredSend,
      wallets,
      'mainnet'
    ),
    null
  )
  assert.equal(
    resolveWalletSnapshotRecoveryTarget(
      'mainnet_wallet-1_account-1',
      'tx-1',
      { ...expiredSend, txHash: 'ab'.repeat(32) },
      wallets,
      'mainnet'
    ),
    null
  )
  assert.equal(isWalletSnapshotIntegrityError('Missing chunk 1/2 for key: mainnet_wallet-1'), true)
  assert.equal(isWalletSnapshotIntegrityError({ code: 'INCOMPATIBLE_WALLET_DB' }), true)
  assert.equal(
    isWalletSnapshotRecoveryError(
      'Wallet recovery data is quarantined; explicit resync is required'
    ),
    true
  )
  assert.equal(isWalletSnapshotRecoveryError('Network connection failed'), false)
  assert.equal(
    classifyError('Invalid wallet database snapshot: invalid snapshot bytes').retryable,
    false
  )
})

test('method selectors cannot become EVM transaction links', () => {
  const chainId = 'eip155:42161'
  const originHash = `0x${'ab'.repeat(32)}`
  assert.equal(isActivityTransactionHash('0xa9059cbb', chainId), false)
  assert.equal(isActivityTransactionHash(originHash, chainId), true)
  assert.deepEqual(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'onchain', chainId },
          evidence: { transactionHash: '0xa9059cbb' }
        }
      ]
    }),
    []
  )
  assert.equal(
    getActivityTransactionReferences({
      segments: [
        {
          id: 'origin',
          role: 'origin',
          target: { kind: 'onchain', chainId },
          evidence: { transactionHash: originHash }
        }
      ]
    })[0].hash,
    originHash
  )
})

test('recipient groups normalize only timestamp-generated wallet labels', () => {
  const catalog = {
    accounts: [
      {
        walletId: 'w1',
        accountId: 'a1',
        walletDisplayName: 'Wallet 1792239657700',
        accountDisplayName: 'big money',
        active: true,
        networks: [
          {
            chain: { id: 'zcash:mainnet', family: 'zcash' },
            addresses: [
              {
                value: 'u1one',
                scheme: 'zcash-shielded-unified',
                privacy: 'shielded',
                preferredForReceive: true
              }
            ]
          }
        ]
      },
      {
        walletId: 'w2',
        accountId: 'a2',
        walletDisplayName: 'My long-term wallet',
        accountDisplayName: 'trade 19',
        active: false,
        networks: [
          {
            chain: { id: 'zcash:mainnet', family: 'zcash' },
            addresses: [
              {
                value: 'u1two',
                scheme: 'zcash-shielded-unified',
                privacy: 'shielded',
                preferredForReceive: true
              }
            ]
          }
        ]
      }
    ]
  }
  const groups = buildMyAccountRecipientGroups(catalog, 'zcash:mainnet')
  assert.equal(groups[0].walletDisplayName, '')
  assert.equal(groups[1].walletDisplayName, 'My long-term wallet')
})

test('transparent derivation path is shown only when a stored index is known', () => {
  assert.equal(
    getStoredTransparentAddressPath('mainnet', 2, { transparentAddressIndex: 3 }),
    "m/44'/133'/2'/0/3"
  )
  assert.equal(getStoredTransparentAddressPath('mainnet', 2, { transparent: 't1address' }), null)
})
