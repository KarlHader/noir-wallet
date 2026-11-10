import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BITCOIN_CHAIN_IDS,
  DASH_CHAIN_IDS,
  ZCASH_CHAIN_IDS
} from '../../../../src/core/chains/registry/chain-ids.ts'
import {
  assertDashDAppChain,
  assertDashDAppEnabled,
  assertDashMessageSigningAllowed,
  assertDashReviewedPaymentUnchanged,
  assertDashTransactionSigningAllowed,
  DashProviderError,
  DASH_INSUFFICIENT_TRANSFER_MESSAGE,
  mapDashInsufficientTransferError,
  parseDashDAppDuffs,
  parseDashSendRequest
} from '../../../../src/core/dapp/dash-provider.ts'

const REVIEWED = Object.freeze({
  recipient: 'XdashReviewedRecipient',
  amountDuffs: '125000000',
  payloadFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
})

function thrown(run) {
  try {
    run()
  } catch (error) {
    return error
  }
  assert.fail('expected the Dash policy to reject the request')
}

describe('Dash dApp provider policy', () => {
  it('rejects Dash requests when the chain flag is closed', () => {
    const error = thrown(() => assertDashDAppEnabled(false))
    assert.ok(error instanceof DashProviderError)
    assert.equal(error.code, 4200)
    assert.match(error.message, /not enabled/)
    assert.doesNotThrow(() => assertDashDAppEnabled(true))
  })

  it('accepts canonical duff strings and rejects numbers and bigint', () => {
    for (const amount of ['1.5', 1.5, '1.0', '01', '1e8', 1200000, 1200000n]) {
      const error = thrown(() => parseDashDAppDuffs(amount))
      assert.ok(error instanceof DashProviderError)
      assert.equal(error.code, -32602)
      assert.match(error.message, /integer number of duffs/)
    }
    assert.equal(parseDashDAppDuffs('1200000'), 1_200_000n)
    assert.throws(
      () => parseDashSendRequest(['XdashReviewedRecipient', '1.5']),
      error => error instanceof DashProviderError && error.code === -32602
    )
    assert.throws(
      () => parseDashSendRequest(['XdashReviewedRecipient', 1200000]),
      error => error instanceof DashProviderError && error.code === -32602
    )
    assert.throws(
      () => parseDashSendRequest(['XdashReviewedRecipient', 1200000n]),
      error => error instanceof DashProviderError && error.code === -32602
    )
    assert.deepEqual(parseDashSendRequest(['XdashReviewedRecipient', '125000000']), {
      recipient: 'XdashReviewedRecipient',
      amountDuffs: '125000000'
    })
    assert.deepEqual(parseDashSendRequest(['XdashReviewedRecipient', '1200000']), {
      recipient: 'XdashReviewedRecipient',
      amountDuffs: '1200000'
    })
  })

  it('rejects other bip122 chains that are not Dash', () => {
    for (const chainId of [
      BITCOIN_CHAIN_IDS.mainnet,
      BITCOIN_CHAIN_IDS.testnet,
      ZCASH_CHAIN_IDS.mainnet,
      ZCASH_CHAIN_IDS.testnet
    ]) {
      const error = thrown(() => assertDashDAppChain(chainId))
      assert.ok(error instanceof DashProviderError)
      assert.equal(error.code, 4901)
      assert.match(error.message, /not Dash/)
    }
    assert.doesNotThrow(() => assertDashDAppChain(DASH_CHAIN_IDS.mainnet))
    assert.doesNotThrow(() => assertDashDAppChain(DASH_CHAIN_IDS.testnet))
  })

  it('returns unsupported for hardware message signing without a signature', () => {
    for (const signer of ['ledger', 'keystone']) {
      let signature
      const sign = () => {
        signature = 'should-not-be-produced'
      }
      const error = thrown(() => {
        assertDashMessageSigningAllowed(signer)
        sign()
      })
      assert.ok(error instanceof DashProviderError)
      assert.equal(error.code, 4200)
      assert.equal(signature, undefined)
      assert.match(error.message, /unsupported/)
    }
    assert.doesNotThrow(() => assertDashMessageSigningAllowed('software'))
    assert.doesNotThrow(() => assertDashMessageSigningAllowed('private-key'))
  })

  it('returns unsupported for Keystone Dash signing', () => {
    let signed = false
    const error = thrown(() => {
      assertDashTransactionSigningAllowed('keystone', 'mainnet')
      signed = true
    })
    assert.ok(error instanceof DashProviderError)
    assert.equal(error.code, 4200)
    assert.equal(signed, false)
    assert.match(error.message, /Keystone/)
    const testnet = thrown(() => assertDashTransactionSigningAllowed('ledger', 'testnet'))
    assert.ok(testnet instanceof DashProviderError)
    assert.equal(testnet.code, 4200)
  })

  it('does not sign after the reviewed recipient or amount changes', () => {
    const sign = () => {
      throw new Error('signing function must not run')
    }
    const signReviewed = current => {
      assertDashReviewedPaymentUnchanged(REVIEWED, current)
      sign()
    }

    const recipient = thrown(() =>
      signReviewed({ ...REVIEWED, recipient: 'XdashChangedRecipient' })
    )
    assert.ok(recipient instanceof DashProviderError)
    assert.equal(recipient.code, 4100)
    assert.match(recipient.message, /recipient or amount changed/)

    const amount = thrown(() => signReviewed({ ...REVIEWED, amountDuffs: '1' }))
    assert.ok(amount instanceof DashProviderError)
    assert.equal(amount.code, 4100)

    const fingerprint = thrown(() =>
      signReviewed({
        ...REVIEWED,
        payloadFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      })
    )
    assert.ok(fingerprint instanceof DashProviderError)
    assert.equal(fingerprint.code, 4100)

    assert.doesNotThrow(() => assertDashReviewedPaymentUnchanged(REVIEWED, { ...REVIEWED }))
  })

  it('explains a transfer that has no spendable Dash', () => {
    const noUtxos = new Error('No spendable Dash UTXOs')
    const insufficient = new Error('Insufficient Dash funds')
    insufficient.code = 'insufficient-funds'
    const codedOnly = Object.freeze({ code: 'insufficient-funds' })

    for (const error of [noUtxos, insufficient, codedOnly]) {
      const mapped = mapDashInsufficientTransferError(error)
      assert.ok(mapped instanceof DashProviderError)
      assert.equal(mapped.code, -32603)
      assert.equal(mapped.message, DASH_INSUFFICIENT_TRANSFER_MESSAGE)
    }

    assert.equal(mapDashInsufficientTransferError(new Error('Dash signer failed')), null)
  })
})
