import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectOwnedTransparentZcashRefundAddress } from '../../../src/background/shield-dapp-coordinator.ts'

const transparent = 't1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML'
const sapling = `zs${'a'.repeat(76)}`
const scope = {
  network: 'mainnet',
  keyDomainId: 'wallet:one',
  accountId: 'account:one'
}

function account(refundAddresses) {
  return {
    network: 'mainnet',
    walletId: scope.keyDomainId,
    accountId: scope.accountId,
    refundAddresses
  }
}

test('Zcash receive quotes refund to the active account transparent address', () => {
  assert.equal(
    selectOwnedTransparentZcashRefundAddress({
      network: 'mainnet',
      scope,
      account: account([sapling, transparent])
    }),
    transparent
  )
})

test('Zcash receive quotes reject an account without a transparent refund address', () => {
  assert.throws(
    () =>
      selectOwnedTransparentZcashRefundAddress({
        network: 'mainnet',
        scope,
        account: account([sapling])
      }),
    /Shield quote refund address is invalid/
  )
  assert.throws(
    () =>
      selectOwnedTransparentZcashRefundAddress({
        network: 'mainnet',
        scope,
        account: undefined
      }),
    /Shield quote refund address is invalid/
  )
  assert.throws(
    () =>
      selectOwnedTransparentZcashRefundAddress({
        network: 'mainnet',
        scope,
        account: { ...account([transparent]), accountId: 'account:other' }
      }),
    /Shield quote refund address is invalid/
  )
})
