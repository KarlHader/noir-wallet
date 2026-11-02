import { test } from 'node:test'
import { expect } from '@playwright/test'

import { getActivityInteractionPresentation } from '../../../src/popup/components/transaction/activity-interaction-adapters.ts'
import { resolveActivityChainId } from '../../../src/popup/components/transaction/activity-chain.ts'

function interactionItem(chainId, recipient = 'interaction-target') {
  return {
    id: `transaction:${chainId}`,
    source: 'wallet-v2',
    scope: { keyDomainId: 'wallet:activity', accountId: 'account:activity' },
    kind: 'contract-call',
    status: 'final',
    segments: [
      {
        id: `segment:${chainId}`,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status: 'final'
      }
    ],
    snapshot: {
      schemaVersion: 1,
      direction: 'contract',
      recipient: { chainId, address: recipient }
    },
    completeness: 'complete',
    createdAt: 1,
    updatedAt: 2
  }
}

test.describe('Activity interaction adapters', () => {
  test('maps EVM, Solana, NEAR, and TRON interactions to chain-native labels', () => {
    expect(getActivityInteractionPresentation(interactionItem('eip155:1'))).toMatchObject({
      family: 'evm',
      title: 'Contract interaction',
      targetLabel: 'Contract',
      fallbackChainIconAlias: 'evm'
    })
    expect(
      getActivityInteractionPresentation(interactionItem('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'))
    ).toMatchObject({
      family: 'solana',
      title: 'Program interaction',
      targetLabel: 'Program',
      fallbackChainIconAlias: 'solana'
    })
    expect(getActivityInteractionPresentation(interactionItem('near:mainnet'))).toMatchObject({
      family: 'near',
      title: 'Contract action',
      targetLabel: 'Contract',
      fallbackChainIconAlias: 'near'
    })
    expect(getActivityInteractionPresentation(interactionItem('tron:0x2b6653dc'))).toMatchObject({
      family: 'tron',
      title: 'Smart contract call',
      targetLabel: 'Contract',
      fallbackChainIconAlias: 'tron'
    })
  })

  test('retains the trusted recipient and safely falls back for future chain namespaces', () => {
    expect(
      getActivityInteractionPresentation(interactionItem('cosmos:cosmoshub-4', 'cosmos1target'))
    ).toEqual({
      family: 'generic',
      title: 'On-chain interaction',
      icon: 'lucide:braces',
      targetLabel: 'Target',
      targetAddress: 'cosmos1target',
      fallbackNetworkName: 'Network',
      fallbackChainIconAlias: undefined
    })
    expect(getActivityInteractionPresentation(interactionItem('not a chain id'))).toMatchObject({
      family: 'generic',
      title: 'On-chain interaction'
    })
  })

  test('does not reinterpret transfers as contract interactions', () => {
    expect(
      getActivityInteractionPresentation({ ...interactionItem('eip155:1'), kind: 'transfer' })
    ).toBeNull()
  })

  test('resolves a chain when an interaction has no amount or on-chain segment', () => {
    const item = {
      ...interactionItem('near:testnet'),
      segments: []
    }

    expect(resolveActivityChainId(item)).toBe('near:testnet')
    expect(getActivityInteractionPresentation(item)).toMatchObject({
      family: 'near',
      title: 'Contract action',
      fallbackNetworkName: 'NEAR'
    })
  })
})
