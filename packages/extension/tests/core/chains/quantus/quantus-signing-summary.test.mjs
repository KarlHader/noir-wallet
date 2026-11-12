import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import { parseSigningSummary } from '../../../../src/core/keyring/domain/index.ts'
import { buildSigningSummaryReviewModel } from '../../../../src/popup/components/signing/signing-summary-review-model.ts'

const SIGNER = 'qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8'
const RECIPIENT = 'qznFDa1qesTQ5UzEjGV4SDZTJJkqVmiqXUxkm9gMPU3JsuFFh'
const ACCOUNT_ID = `0x${'cd'.repeat(32)}`
const CALL_HASH = `0x${'44'.repeat(32)}`

function envelope(overrides = {}, review = { level: 'standard', issues: [] }) {
  return {
    schema: 'quantus.transfer.v1',
    chainId: 'quantus:mainnet',
    operation: 'transaction',
    review,
    fields: {
      signerAddress: SIGNER,
      signerAccountId: ACCOUNT_ID,
      scheme: 'ml-dsa-87',
      recipient: RECIPIENT,
      amountRaw: '1000000000000',
      feeLimitRaw: '10000000000',
      keepAlive: true,
      nonce: '7',
      tipRaw: '0',
      eraPeriod: 64,
      blockNumber: 1_024,
      callHash: CALL_HASH,
      callLength: 13,
      ...overrides
    }
  }
}

const expectation = {
  chainId: parseChainId('quantus:mainnet').id,
  family: 'quantus',
  operation: 'transaction'
}

test.describe('Quantus signing summary', () => {
  test('accepts a native transfer summary for the Quantus family', () => {
    const summary = parseSigningSummary(envelope(), expectation)
    expect(summary.schema).toBe('quantus.transfer.v1')
    expect(summary.fields).toMatchObject({
      recipient: RECIPIENT,
      amountRaw: '1000000000000',
      feeLimitRaw: '10000000000',
      keepAlive: true,
      nonce: '7',
      eraPeriod: 64
    })
  })

  test('rejects unsupported fields, schemes, and a mismatched family', () => {
    expect(() => parseSigningSummary(envelope({ extra: 1 }), expectation)).toThrow(/unknown field/i)
    expect(() => parseSigningSummary(envelope({ scheme: 'sr25519' }), expectation)).toThrow(
      /scheme/
    )
    expect(() => parseSigningSummary(envelope({ feeLimitRaw: '0' }), expectation)).toThrow(
      /feeLimitRaw must be positive/
    )
    expect(
      parseSigningSummary(envelope({ feeLimitRaw: '9999999999' }), expectation).fields.feeLimitRaw
    ).toBe('9999999999')
    expect(() =>
      parseSigningSummary(envelope({ feeLimitRaw: '010000000000' }), expectation)
    ).toThrow(/canonical unsigned decimal/)
    const { feeLimitRaw: _omitted, ...withoutFeeLimit } = envelope().fields
    expect(() =>
      parseSigningSummary({ ...envelope(), fields: withoutFeeLimit }, expectation)
    ).toThrow(/feeLimitRaw/)
    expect(() => parseSigningSummary(envelope(), { ...expectation, family: 'pearl' })).toThrow(
      /family|schema/
    )
  })

  test('rejects a short or non-Quantus address', () => {
    expect(() => parseSigningSummary(envelope({ recipient: 'qz1' }), expectation)).toThrow(
      /Quantus SS58 address/
    )
  })

  test('renders the review model with transfer, fee, and request rows', () => {
    const summary = parseSigningSummary(
      envelope({}, { level: 'caution', issues: [{ code: 'unrecognized-call' }] }),
      expectation
    )
    const model = buildSigningSummaryReviewModel(summary)
    expect(model.title).toBe('Sign Quantus transfer')
    expect(model.level).toBe('caution')
    expect(model.issues[0]).toMatchObject({ code: 'unrecognized-call', title: 'Unrecognized call' })
    expect(model.sections.map(section => section.title)).toEqual(['Transfer', 'Signing', 'Request'])
    expect(model.sections[0].rows.map(row => row.label)).toEqual([
      'From',
      'Recipient',
      'Amount',
      'Fee limit (estimated)',
      'Keep account alive',
      'Tip'
    ])
    expect(model.sections[0].rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Fee limit (estimated)', value: '0.01 QTC' })
      ])
    )
    expect(model.sections[1].rows).toEqual(
      expect.arrayContaining([{ label: 'Call hash', value: CALL_HASH, breakAll: true, code: true }])
    )
    expect(model.sections[2].rows).toEqual([
      { label: 'Schema', value: 'quantus.transfer.v1', code: true, breakAll: true },
      { label: 'Chain ID', value: 'quantus:mainnet', code: true, breakAll: true }
    ])
  })
})
