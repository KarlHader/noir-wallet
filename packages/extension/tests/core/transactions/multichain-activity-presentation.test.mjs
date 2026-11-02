import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  buildActivityExecutionAddressModes,
  canCancelEvmActivity,
  getActivityDetailTitle,
  getActivityExternalReferenceLabel,
  getActivityFailureLabel,
  getActivityRowTextPresentation,
  getActivityRouteTitle,
  getActivityTransferRecipient,
  getActivitySegmentStatusPresentation,
  getActivityStatusPresentation,
  getActivitySwapPresentation,
  getActivitySwapSourceMethodLabel,
  hasMatchingActivityTokenIcons,
  isAccountModeTransfer
} from '../../../src/popup/components/transaction/multichain-activity-presentation.ts'

const transactionHash = `0x${'a'.repeat(64)}`
const replacementTransactionHash = `0x${'b'.repeat(64)}`

function failedItem(evidence) {
  return {
    id: 'transaction:evm:replaced',
    source: 'wallet-v2',
    scope: { keyDomainId: 'wallet:activity', accountId: 'account:activity' },
    kind: 'transfer',
    status: 'failed',
    segments: [
      {
        id: 'segment:evm:replaced',
        role: 'origin',
        target: { kind: 'onchain', chainId: 'eip155:1' },
        status: 'failed',
        evidence,
        failureCode: 'dropped'
      }
    ],
    completeness: 'partial',
    createdAt: 1,
    updatedAt: 2,
    failureCode: 'dropped'
  }
}

test.describe('Multichain Activity presentation', () => {
  test('shows the owned account route for a Confidential transfer without labeling external recipients', () => {
    const publicAddress = `0x${'1'.repeat(40)}`
    const privateAddress = `0x${'2'.repeat(40)}`
    const externalAddress = `0x${'3'.repeat(40)}`
    const assetId = 'eip155:1/slip44:60'
    const addressModes = buildActivityExecutionAddressModes([
      {
        chain: { family: 'evm' },
        addresses: [{ value: publicAddress }],
        privateExecutionAddress: privateAddress
      }
    ])
    const item = {
      ...failedItem({ transactionHash }),
      kind: 'transfer',
      status: 'final',
      failureCode: undefined,
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId, amountRaw: '2000000000000000' },
        counterAmount: { assetId, amountRaw: '1900000000000000' },
        sender: { chainId: 'eip155:1', address: publicAddress },
        protocol: {
          provider: 'rhea-cross-chain-dex',
          userAction: 'transfer',
          destination: { recipient: privateAddress }
        }
      }
    }
    const assets = new Map([[assetId, { metadata: { symbol: 'ETH', decimals: 18 } }]])
    const chains = new Map([['eip155:1', { displayName: 'Ethereum' }]])

    const route = getActivitySwapPresentation(item, assets, chains, addressModes)
    expect(route).toMatchObject({
      sourceAccountMode: 'Public',
      destinationAccountMode: 'Confidential'
    })
    expect(getActivityRouteTitle(item, route)).toBe('Account Transfer')
    expect(hasMatchingActivityTokenIcons(route)).toBe(true)
    expect(
      hasMatchingActivityTokenIcons({
        ...route,
        destination: {
          ...route.destination,
          assetId: 'eip155:42161/slip44:60',
          iconUrl: 'https://example.test/other-eth.png'
        },
        source: { ...route.source, iconUrl: 'https://example.test/eth.png' }
      })
    ).toBe(false)
    expect(getActivityDetailTitle(item)).toBe('Transfer')
    expect(
      isAccountModeTransfer(
        { ...item, kind: 'swap' },
        getActivitySwapPresentation({ ...item, kind: 'swap' }, assets, chains, addressModes)
      )
    ).toBe(true)
    expect(
      getActivitySwapPresentation(
        {
          ...item,
          snapshot: {
            ...item.snapshot,
            protocol: {
              ...item.snapshot.protocol,
              destination: { recipient: externalAddress }
            }
          }
        },
        assets,
        chains,
        addressModes
      )?.destinationAccountMode
    ).toBeUndefined()
    expect(
      getActivityRouteTitle(
        item,
        getActivitySwapPresentation(
          {
            ...item,
            snapshot: {
              ...item.snapshot,
              protocol: {
                ...item.snapshot.protocol,
                destination: { recipient: externalAddress }
              }
            }
          },
          assets,
          chains,
          addressModes
        )
      )
    ).toBe('Transfer')
  })

  test('keeps both Swap assets and their route tied to the correct chains', () => {
    const sourceId = 'eip155:1/slip44:60'
    const destinationId = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'
    const assetMetadata = new Map([
      [sourceId, { metadata: { symbol: 'ETH', decimals: 18 } }],
      [destinationId, { metadata: { symbol: 'USDC', decimals: 6 } }]
    ])
    const chainMetadata = new Map([
      ['eip155:1', { displayName: 'Ethereum', iconAlias: 'ethereum' }],
      ['eip155:42161', { displayName: 'Arbitrum', iconAlias: 'arbitrum' }]
    ])
    const item = {
      ...failedItem({ transactionHash }),
      kind: 'swap',
      status: 'final',
      failureCode: undefined,
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId: sourceId, amountRaw: '1000000000000000000' },
        counterAmount: { assetId: destinationId, amountRaw: '2500000' }
      }
    }

    const route = getActivitySwapPresentation(item, assetMetadata, chainMetadata)
    expect(route).toEqual({
      source: { assetId: sourceId, symbol: 'ETH', formatted: '1' },
      destination: { assetId: destinationId, symbol: 'USDC', formatted: '2.5' },
      sourceNetwork: 'Ethereum',
      destinationNetwork: 'Arbitrum',
      sourceChainIconAlias: 'ethereum',
      destinationChainIconAlias: 'arbitrum'
    })
    expect(getActivityRouteTitle(item, route)).toBe('Swap')
    expect(hasMatchingActivityTokenIcons(route)).toBe(false)
    const recipientAddress = `0x${'3'.repeat(40)}`
    const sourceContract = `0x${'4'.repeat(40)}`
    expect(
      getActivitySwapPresentation(
        {
          ...item,
          snapshot: {
            ...item.snapshot,
            recipient: { chainId: 'eip155:1', address: sourceContract },
            protocol: {
              provider: 'rhea-cross-chain-dex',
              destination: { recipient: recipientAddress }
            }
          }
        },
        assetMetadata,
        chainMetadata
      )?.recipientAddress
    ).toBe(recipientAddress)
    expect(
      getActivitySwapPresentation(
        {
          ...item,
          snapshot: {
            ...item.snapshot,
            recipient: { chainId: 'eip155:1', address: sourceContract }
          }
        },
        assetMetadata,
        chainMetadata
      )?.recipientAddress
    ).toBeUndefined()
  })

  test('names a Swap ERC-20 source transfer without mislabeling other calls', () => {
    const item = {
      ...failedItem({ transactionHash }),
      kind: 'swap',
      snapshot: {
        schemaVersion: 1,
        primaryAmount: {
          assetId: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          amountRaw: '2000000'
        },
        evm: { methodSelector: '0xa9059cbb' }
      }
    }
    expect(getActivitySwapSourceMethodLabel(item, 'USDC')).toBe('USDC transfer')
    expect(getActivitySwapSourceMethodLabel({ ...item, kind: 'transfer' }, 'USDC')).toBeNull()
    expect(
      getActivitySwapSourceMethodLabel(
        { ...item, snapshot: { ...item.snapshot, evm: { methodSelector: '0x12345678' } } },
        'USDC'
      )
    ).toBeNull()
    expect(
      getActivitySwapSourceMethodLabel(
        {
          ...item,
          snapshot: {
            ...item.snapshot,
            primaryAmount: { assetId: 'eip155:1/slip44:60', amountRaw: '2000000' }
          }
        },
        'ETH'
      )
    ).toBeNull()
  })

  test('uses MetaMask-style transfer, swap, and contract row labels', () => {
    const sender = `0x${'1'.repeat(40)}`
    const recipient = `0x${'2'.repeat(40)}`
    const base = {
      ...failedItem({ transactionHash }),
      status: 'final',
      failureCode: undefined,
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        sender: { chainId: 'eip155:1', address: sender },
        recipient: { chainId: 'eip155:1', address: recipient }
      }
    }

    expect(getActivityRowTextPresentation(base, 'ETH', undefined, 'Ethereum')).toEqual({
      title: 'Sent ETH',
      subtitle: 'To: 0x2222...222222'
    })
    expect(
      getActivityRowTextPresentation(
        { ...base, snapshot: { ...base.snapshot, direction: 'incoming' } },
        'USDC',
        undefined,
        'Ethereum'
      )
    ).toEqual({ title: 'Received USDC', subtitle: 'From: 0x1111...111111' })
    expect(
      getActivityRowTextPresentation(
        { ...base, kind: 'receive', snapshot: { ...base.snapshot, direction: 'self' } },
        'ETH',
        undefined,
        'Ethereum'
      )
    ).toEqual({ title: 'Received ETH', subtitle: 'From: 0x1111...111111' })
    expect(
      getActivityRowTextPresentation({ ...base, kind: 'swap' }, 'USDC', 'ETH', 'Ethereum')
    ).toEqual({ title: 'Swapped', subtitle: 'USDC → ETH' })
    expect(
      getActivityRowTextPresentation(
        { ...base, kind: 'shield', snapshot: { ...base.snapshot, direction: 'self' } },
        'ZEC',
        undefined,
        'Zcash'
      )
    ).toEqual({ title: 'Shielded ZEC', subtitle: 'Transparent → Shielded' })
    expect(
      getActivityRowTextPresentation(
        { ...base, kind: 'contract-call', snapshot: { ...base.snapshot, direction: 'contract' } },
        undefined,
        undefined,
        'Ethereum'
      )
    ).toEqual({ title: 'Contract interaction', subtitle: 'Contract: 0x2222...222222' })
    expect(
      getActivityRowTextPresentation(
        { ...base, kind: 'approve', snapshot: { ...base.snapshot, direction: 'contract' } },
        undefined,
        undefined,
        'Ethereum'
      )
    ).toEqual({ title: 'Approve', subtitle: 'Token: 0x2222...222222' })

    expect(
      getActivityRowTextPresentation(
        {
          ...base,
          kind: 'contract-call',
          segments: [
            {
              ...base.segments[0],
              target: {
                ...base.segments[0].target,
                chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
              }
            }
          ],
          snapshot: {
            ...base.snapshot,
            direction: 'contract',
            recipient: {
              chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
              address: '11111111111111111111111111111111'
            }
          }
        },
        undefined,
        undefined,
        'Solana',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
      )
    ).toEqual({ title: 'Program interaction', subtitle: 'Program: 111111...111111' })
  })

  test('shows the final RHEA transfer recipient instead of its source contract', () => {
    const sourceContract = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const destination = `0x${'3'.repeat(40)}`
    const item = {
      ...failedItem({ transactionHash }),
      status: 'final',
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        recipient: { chainId: 'eip155:1', address: sourceContract },
        protocol: {
          provider: 'rhea-cross-chain-dex',
          userAction: 'transfer',
          destination: { recipient: destination }
        }
      }
    }

    expect(getActivityTransferRecipient(item)).toBe(destination)
    expect(getActivityRowTextPresentation(item, 'USDC', undefined, 'Ethereum')).toEqual({
      title: 'Sent USDC',
      subtitle: 'To: 0x3333...333333'
    })
    expect(
      getActivityTransferRecipient({ ...item, snapshot: { ...item.snapshot, protocol: undefined } })
    ).toBe(sourceContract)
  })

  test('offers cancellation only for a locally tracked pending EVM transaction', () => {
    const item = {
      ...failedItem({ transactionHash }),
      status: 'broadcast',
      failureCode: undefined,
      completeness: 'complete',
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        evm: {
          schemaVersion: 1,
          nonce: '7',
          maxFeePerGasWei: '5',
          maxPriorityFeePerGasWei: '1',
          gasLimit: '21000'
        }
      },
      segments: [
        {
          ...failedItem({ transactionHash }).segments[0],
          status: 'broadcast',
          failureCode: undefined
        }
      ]
    }
    expect(canCancelEvmActivity(item, ['eip155:1'])).toBe(true)
    expect(canCancelEvmActivity({ ...item, status: 'final' }, ['eip155:1'])).toBe(false)
    expect(canCancelEvmActivity({ ...item, kind: 'cancel' }, ['eip155:1'])).toBe(false)
  })

  test('distinguishes a proven replacement from an unexplained dropped transaction', () => {
    expect(
      getActivityStatusPresentation(failedItem({ transactionHash, replacementTransactionHash }))
    ).toEqual({ label: 'Replaced', tone: 'neutral' })
    expect(getActivityStatusPresentation(failedItem({ transactionHash }))).toEqual({
      label: 'Failed',
      tone: 'error'
    })
    expect(getActivityFailureLabel('dropped', { replacementTransactionHash })).toBe(
      'Replaced by a confirmed transaction'
    )
    expect(getActivityFailureLabel('dropped')).toBe('Dropped before confirmation')
  })

  test('presents a broadcast transaction as submitted without a warning tone', () => {
    const item = {
      ...failedItem({ transactionHash }),
      kind: 'swap',
      status: 'broadcast',
      failureCode: undefined
    }
    expect(getActivityStatusPresentation(item)).toEqual({ label: 'Submitted', tone: 'neutral' })
    expect(getActivityStatusPresentation({ ...item, reconfirming: true })).toEqual({
      label: 'Reconfirming',
      tone: 'warning'
    })
  })

  test('presents a completed refund as recovery instead of a generic swap failure', () => {
    const refunded = {
      ...failedItem({ transactionHash }),
      kind: 'swap',
      failureCode: 'refunded'
    }
    expect(getActivityStatusPresentation(refunded)).toEqual({
      label: 'Refunded',
      tone: 'success'
    })
    expect(getActivityRowTextPresentation(refunded, 'ZEC', 'USDC', 'Zcash')).toEqual({
      title: 'Refunded',
      subtitle: 'Returned ZEC'
    })
  })

  test('keeps a pre-finality reorg visible while confirmations rebuild', () => {
    const item = {
      ...failedItem({ transactionHash }),
      status: 'confirming',
      reconfirming: true,
      failureCode: undefined,
      segments: [
        {
          ...failedItem({ transactionHash }).segments[0],
          status: 'confirming',
          reconfirming: true,
          failureCode: undefined,
          evidence: { transactionHash, confirmations: 1, requiredConfirmations: 6 }
        }
      ]
    }

    expect(getActivityStatusPresentation(item)).toEqual({
      label: 'Reconfirming · 1/6',
      tone: 'warning'
    })
  })

  test('labels public references by their transaction role and replacement evidence', () => {
    const replaced = failedItem({
      transactionHash,
      replacementTransactionHash,
      externalReference: `${'c'.repeat(64)}:1`
    }).segments[0]
    expect(getActivityExternalReferenceLabel(replaced)).toBe('Spent input')
    expect(
      getActivityExternalReferenceLabel({
        ...replaced,
        target: { kind: 'relay', provider: 'near-intents' },
        failureCode: undefined
      })
    ).toBe('Relay reference')
    expect(
      getActivityExternalReferenceLabel({
        ...replaced,
        target: {
          kind: 'protocol',
          provider: 'RHEA Lending',
          account: 'rhea00000x.multica.near'
        },
        failureCode: undefined
      })
    ).toBe('Protocol reference')
    expect(
      getActivityExternalReferenceLabel({
        ...replaced,
        evidence: { transactionHash, externalReference: 'evm-nonce:7' },
        failureCode: 'dropped'
      })
    ).toBe('Network reference')
  })

  test('marks untouched cross-chain segments as not started after user rejection', () => {
    const segment = {
      id: 'segment:intents:relay',
      role: 'relay',
      target: { kind: 'relay', provider: 'NEAR Intents' },
      status: 'created'
    }
    expect(
      getActivitySegmentStatusPresentation(segment, {
        status: 'failed',
        failureCode: 'user-rejected'
      })
    ).toEqual({ label: 'Not started', tone: 'neutral' })
    expect(getActivitySegmentStatusPresentation(segment)).toEqual({
      label: 'Pending',
      tone: 'neutral'
    })
  })
})
