import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getActivityRecoveryAction,
  isActivityRecoveryTransition
} from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'

const chainId = 'eip155:11155111'
const bitcoinChainId = 'bip122:000000000933ea01ad0ee984209779ba'

function activity(overrides = {}) {
  return {
    id: 'transaction:evm:recovery',
    source: 'wallet-v2',
    scope: { keyDomainId: 'wallet:1', accountId: 'account:1' },
    kind: 'transfer',
    status: 'signed',
    snapshot: {
      direction: 'outgoing',
      primaryAmount: { assetId: `${chainId}/slip44:60`, amountRaw: '1' }
    },
    segments: [
      {
        id: 'segment:evm:recovery',
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status: 'signed',
        evidence: { transactionHash: `0x${'a'.repeat(64)}` }
      }
    ],
    completeness: 'complete',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

test.describe('Multichain Activity recovery action', () => {
  test('offers an EVM broadcast retry only for the exact locally signed transaction', () => {
    expect(getActivityRecoveryAction(activity(), [chainId])).toBe('retry-evm-broadcast')
  })

  test('offers a Bitcoin broadcast retry only for a canonical local txid', () => {
    const bitcoin = activity({
      id: 'transaction:bitcoin:recovery',
      snapshot: {
        direction: 'outgoing',
        primaryAmount: { assetId: `${bitcoinChainId}/slip44:0`, amountRaw: '1' }
      },
      segments: [
        {
          ...activity().segments[0],
          id: 'segment:bitcoin:recovery',
          target: { kind: 'onchain', chainId: bitcoinChainId },
          evidence: { transactionHash: 'a'.repeat(64) }
        }
      ]
    })
    expect(getActivityRecoveryAction(bitcoin, [chainId], bitcoinChainId)).toBe(
      'retry-bitcoin-broadcast'
    )
    expect(
      getActivityRecoveryAction(
        {
          ...bitcoin,
          segments: [
            { ...bitcoin.segments[0], evidence: { transactionHash: `0x${'a'.repeat(64)}` } }
          ]
        },
        [chainId],
        bitcoinChainId
      )
    ).toBe('none')
  })

  test('does not offer a retry for terminal, external, or cross-chain history', () => {
    expect(getActivityRecoveryAction(activity({ status: 'final' }), [chainId])).toBe('none')
    expect(getActivityRecoveryAction(activity({ source: 'rpc' }), [chainId])).toBe('none')
    expect(
      getActivityRecoveryAction(
        activity({
          segments: [
            activity().segments[0],
            {
              ...activity().segments[0],
              id: 'segment:relay',
              role: 'relay'
            }
          ]
        }),
        [chainId]
      )
    ).toBe('none')
  })

  test('rejects a missing, malformed, or wrong-network signed transaction hash', () => {
    expect(
      getActivityRecoveryAction(
        activity({
          segments: [{ ...activity().segments[0], evidence: undefined }]
        }),
        [chainId]
      )
    ).toBe('none')
    expect(
      getActivityRecoveryAction(
        activity({
          segments: [
            { ...activity().segments[0], evidence: { transactionHash: `0x${'A'.repeat(64)}` } }
          ]
        }),
        [chainId]
      )
    ).toBe('none')
    expect(
      getActivityRecoveryAction(
        activity({
          snapshot: {
            direction: 'outgoing',
            primaryAmount: { assetId: 'eip155:1/slip44:60', amountRaw: '1' }
          }
        }),
        [chainId]
      )
    ).toBe('none')
    expect(getActivityRecoveryAction(activity({ failureCode: 'unknown' }), [chainId])).toBe('none')
  })

  test('accepts only a monotonic recovery result bound to the original transaction', () => {
    const source = activity()
    const recovered = activity({
      status: 'broadcast',
      updatedAt: 3,
      segments: [{ ...source.segments[0], status: 'broadcast' }]
    })

    expect(isActivityRecoveryTransition(source, recovered, [chainId])).toBe(true)
    expect(
      isActivityRecoveryTransition(
        source,
        { ...recovered, scope: { ...recovered.scope, accountId: 'account:2' } },
        [chainId]
      )
    ).toBe(false)
    expect(
      isActivityRecoveryTransition(
        source,
        {
          ...recovered,
          snapshot: {
            ...recovered.snapshot,
            primaryAmount: { ...recovered.snapshot.primaryAmount, amountRaw: '2' }
          }
        },
        [chainId]
      )
    ).toBe(false)
    expect(
      isActivityRecoveryTransition(
        source,
        {
          ...recovered,
          segments: [
            {
              ...recovered.segments[0],
              evidence: { transactionHash: `0x${'b'.repeat(64)}` }
            }
          ]
        },
        [chainId]
      )
    ).toBe(false)
    expect(isActivityRecoveryTransition(source, { ...recovered, updatedAt: 1 }, [chainId])).toBe(
      false
    )
  })
})
