import { test } from 'node:test'
import { expect } from '@playwright/test'
import { selectActivityObservation } from '../../../src/popup/services/activity-observation.ts'
import { getActivityAction } from '../../../src/popup/services/activity-action-label.ts'
import { filterActivityItems } from '../../../src/popup/services/activity-list-model.ts'
import { projectLegacyShieldWithdrawActivityGraph } from '../../../src/core/services/confidential-funding/confidential-funding-graph.ts'

import {
  buildActivityExecutionAddressModes,
  canCancelEvmActivity,
  canSpeedUpEvmActivity,
  getActivityDetailTitle,
  getActivityExternalReferenceLabel,
  getActivityFailureLabel,
  getActivityRowTextPresentation,
  getActivityRouteTitle,
  getActivityTransferRecipient,
  getActivitySegmentStatusPresentation,
  getActivityStatusPresentation,
  getConfirmedFailedActivityAmount,
  getActivitySwapPresentation,
  getClusterSettledDestination,
  getActivitySwapSourceMethodLabel,
  hasMatchingActivityTokenIcons,
  isAccountModeTransfer
} from '../../../src/popup/services/multichain-activity-presentation.ts'

const transactionHash = `0x${'a'.repeat(64)}`
const replacementTransactionHash = `0x${'b'.repeat(64)}`

test('Activity observations stay scoped and never regress a terminal transaction', () => {
  const current = {
    id: 'tx:1',
    source: 'wallet-v2',
    scope: { keyDomainId: 'wallet:1', accountId: 'account:1' },
    status: 'final',
    updatedAt: 10
  }
  expect(
    selectActivityObservation(current, { ...current, status: 'confirming', updatedAt: 9 })
  ).toBe(current)
  expect(
    selectActivityObservation(current, { ...current, status: 'confirming', updatedAt: 11 })
  ).toBe(current)
  const other = { ...current, id: 'tx:2', status: 'broadcast', updatedAt: 1 }
  expect(selectActivityObservation(current, other)).toBe(other)
  const otherAccount = {
    ...current,
    scope: { keyDomainId: 'wallet:1', accountId: 'account:2' },
    status: 'broadcast',
    updatedAt: 1
  }
  expect(selectActivityObservation(current, otherAccount)).toBe(otherAccount)
})

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
  test('shows confirmed debits but never quoted credits on a failed routed transfer', () => {
    const assetId = 'eip155:1/slip44:60'
    const assets = new Map([[assetId, { metadata: { symbol: 'ETH', decimals: 18 } }]])
    const item = {
      ...failedItem({ transactionHash }),
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId, amountRaw: '3000000000000000000' },
        counterAmount: { assetId, amountRaw: '2000000000000000000' }
      }
    }
    expect(getConfirmedFailedActivityAmount(item, assets, 'outgoing', assetId)).toBeUndefined()

    const debit = {
      id: 'confirmed-origin',
      role: 'origin',
      target: { kind: 'onchain', chainId: 'eip155:1' },
      status: 'final',
      evidence: {
        transactionHash,
        assetEffects: {
          source: 'receipt',
          completeness: 'complete',
          changes: [{ assetId, amountRaw: '1000000000000000000', direction: 'outgoing' }]
        }
      }
    }
    const failedAfterDebit = { ...item, segments: [debit] }
    expect(
      getConfirmedFailedActivityAmount(failedAfterDebit, assets, 'outgoing', assetId)
    ).toMatchObject({
      symbol: 'ETH',
      exact: '1'
    })
    expect(
      getConfirmedFailedActivityAmount(failedAfterDebit, assets, 'incoming', assetId)
    ).toBeUndefined()
  })

  test('classifies internal movement from the viewed domain and known Shield provider', () => {
    const item = {
      ...failedItem({ transactionHash }),
      kind: 'withdraw',
      snapshot: {
        direction: 'self',
        shield: { operation: 'withdraw', sourceDomain: 'shield', destinationDomain: 'private' }
      }
    }
    expect(getActivityAction(item, { viewedDomain: 'private' })).toEqual({
      label: 'Receive',
      side: 'destination'
    })
    expect(getActivityAction(item, { viewedDomain: 'shield' })).toEqual({
      label: 'Withdraw',
      side: 'source'
    })
    const zcashWithdrawal = {
      ...item,
      snapshot: {
        ...item.snapshot,
        shield: { ...item.snapshot.shield, destinationDomain: 'public' },
        recipient: {
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
          address: 't1recipient'
        }
      }
    }
    for (const shieldProvider of [undefined, 'near-confidential']) {
      const perspective = { viewedDomain: 'shield', shieldProvider }
      expect(getActivityAction(zcashWithdrawal, perspective)).toEqual({
        label: 'Withdraw',
        side: 'source'
      })
      expect(
        getActivityAction(
          { ...zcashWithdrawal, snapshot: { ...zcashWithdrawal.snapshot, direction: 'outgoing' } },
          perspective
        )
      ).toEqual({ label: 'Send', side: 'source' })
    }
    expect(
      getActivityAction(
        {
          ...item,
          snapshot: {
            ...item.snapshot,
            shield: { ...item.snapshot.shield, destinationDomain: 'shield' }
          }
        },
        { viewedDomain: 'shield' }
      )
    ).toEqual({ label: 'Transfer', side: 'none' })
    const providerRoute = {
      sourceFundingSource: 'shielded',
      destinationAccountMode: 'Confidential'
    }
    const historicalSwap = { ...item, kind: 'swap', snapshot: { direction: 'outgoing' } }
    expect(
      getActivityAction(
        historicalSwap,
        { viewedDomain: 'shield', shieldProvider: 'zcash-shield' },
        providerRoute
      )
    ).toEqual({ label: 'Withdraw', side: 'source' })
    expect(
      getActivityAction(
        historicalSwap,
        { viewedDomain: 'shield', shieldProvider: 'near-confidential' },
        providerRoute
      )
    ).toEqual({ label: 'Deposit', side: 'destination' })
    expect(getActivityAction(historicalSwap, { viewedDomain: 'shield' }, providerRoute)).toEqual({
      label: 'Swap',
      side: 'none'
    })
    const nativeSwap = {
      ...item,
      id: 'tx:confidential:native-swap',
      snapshot: {
        ...item.snapshot,
        shield: { operation: 'swap', sourceDomain: 'shield', destinationDomain: 'shield' },
        primaryAmount: { assetId: 'eip155:1/slip44:60', amountRaw: '100' },
        counterAmount: {
          assetId: 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133',
          amountRaw: '90'
        }
      }
    }
    expect(
      getActivityAction(nativeSwap, { viewedDomain: 'shield', shieldProvider: 'near-confidential' })
    ).toEqual({ label: 'Swap', side: 'none' })
    expect(
      getActivityAction(nativeSwap, { viewedDomain: 'shield', shieldProvider: 'zcash-shield' })
    ).toEqual({ label: 'Deposit', side: 'destination' })
    expect(getActivityAction(nativeSwap, { viewedDomain: 'shield' })).toEqual({
      label: 'Swap',
      side: 'none'
    })
    const nativeZecRecipient = {
      ...nativeSwap,
      snapshot: {
        ...nativeSwap.snapshot,
        shield: { ...nativeSwap.snapshot.shield, destinationDomain: 'public' }
      }
    }
    const shieldedDestination = { destinationFundingSource: 'shielded' }
    expect(
      getActivityAction(nativeZecRecipient, { viewedDomain: 'shield' }, shieldedDestination)
    ).toEqual({ label: 'Swap', side: 'none' })
    expect(
      getActivityAction(
        nativeZecRecipient,
        { viewedDomain: 'shield', shieldProvider: 'near-confidential' },
        shieldedDestination
      )
    ).toEqual({ label: 'Swap', side: 'none' })
    expect(
      getActivityAction(
        nativeZecRecipient,
        { viewedDomain: 'shield', shieldProvider: 'zcash-shield' },
        shieldedDestination
      )
    ).toEqual({ label: 'Deposit', side: 'destination' })
  })

  test('labels a legacy Shield send to the scoped Private address without relabeling other recipients', () => {
    const chainId = 'eip155:137'
    const privateAddress = `0x${'2'.repeat(40)}`
    const publicAddress = `0x${'3'.repeat(40)}`
    const assetId = `${chainId}/slip44:60`
    const item = {
      ...failedItem({ transactionHash }),
      id: 'tx:confidential:legacy-send',
      kind: 'withdraw',
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        shield: {
          schemaVersion: 1,
          operation: 'withdraw',
          sourceDomain: 'shield',
          destinationDomain: 'public'
        },
        primaryAmount: { assetId, amountRaw: '100' },
        counterAmount: { assetId, amountRaw: '90' },
        recipient: { chainId, address: privateAddress }
      }
    }
    const plan = {
      operation: 'withdraw',
      destinationDomain: 'public',
      transactionId: item.id,
      network: 'mainnet',
      keyDomainId: item.scope.keyDomainId,
      accountId: item.scope.accountId,
      destination: { chainId, address: privateAddress },
      externalRecipient: privateAddress
    }
    const assets = new Map([[assetId, { metadata: { symbol: 'POL', decimals: 18 } }]])
    const project = (activity, fundingPlan = plan, ownedAddresses = [privateAddress]) => {
      const graph = { root: { id: activity.id, scope: activity.scope, intent: activity.snapshot } }
      return {
        ...activity,
        snapshot: projectLegacyShieldWithdrawActivityGraph(
          graph,
          fundingPlan,
          'mainnet',
          ownedAddresses
        ).root.intent
      }
    }
    const route = (...args) => getActivitySwapPresentation(project(...args), assets, new Map())

    expect(route(item)?.destinationAccountMode).toBe('Confidential')
    const filters = { items: [project(item)], selectedChainIds: [chainId] }
    expect(filterActivityItems({ ...filters, domain: 'private' })).toEqual([])
    expect(filterActivityItems({ ...filters, domain: 'public' })).toEqual([])
    expect(filterActivityItems({ ...filters, domain: 'shield' })).toEqual(filters.items)
    const confirmed = {
      ...project(item),
      status: 'final',
      failureCode: undefined,
      segments: [
        {
          id: 'settlement:one',
          role: 'destination',
          status: 'final',
          target: { kind: 'onchain', chainId },
          evidence: { transactionHash, settledAmount: { assetId, amountRaw: '86' } }
        }
      ]
    }
    const executionAddressModes = new Map([[`${chainId}:${privateAddress}`, 'Confidential']])
    const destinationFilters = { ...filters, domain: 'private', executionAddressModes }
    const [receipt] = filterActivityItems({ ...destinationFilters, items: [confirmed] })
    expect(receipt).toMatchObject({
      kind: 'receive',
      snapshot: { direction: 'incoming', primaryAmount: { assetId, amountRaw: '86' } }
    })
    const observed = { ...receipt, id: 'rpc:private-credit', source: 'rpc' }
    expect(filterActivityItems({ ...destinationFilters, items: [confirmed, observed] })).toEqual([
      observed
    ])
    expect(
      filterActivityItems({
        ...destinationFilters,
        items: [confirmed],
        executionAddressModes: new Map()
      })
    ).toEqual([])
    expect(route(item, { ...plan, externalRecipient: publicAddress })?.destinationAccountMode).toBe(
      'Public'
    )
    expect(route(item, { ...plan, transactionId: 'other' })?.destinationAccountMode).toBe('Public')
    expect(route(item, { ...plan, network: 'testnet' })?.destinationAccountMode).toBe('Public')
    expect(
      route(item, { ...plan, destination: { ...plan.destination, chainId: 'eip155:1' } })
        ?.destinationAccountMode
    ).toBe('Public')
    expect(route(item, { ...plan, accountId: 'account:other' })?.destinationAccountMode).toBe(
      'Public'
    )
    expect(route(item, plan, [publicAddress])?.destinationAccountMode).toBe('Public')
    expect(
      route({ ...item, snapshot: { ...item.snapshot, direction: 'self' } })?.destinationAccountMode
    ).toBe('Public')
    expect(
      route({
        ...item,
        snapshot: {
          ...item.snapshot,
          shield: { ...item.snapshot.shield, destinationDomain: 'private' }
        }
      })?.destinationAccountMode
    ).toBe('Confidential')
  })

  test('shows the owned account route for a Confidential transfer without labeling external recipients', () => {
    const publicAddress = `0x${'1'.repeat(40)}`
    const privateAddress = `0x${'2'.repeat(40)}`
    const externalAddress = `0x${'3'.repeat(40)}`
    const assetId = 'eip155:1/slip44:60'
    const addressModes = buildActivityExecutionAddressModes([
      {
        chain: { id: 'eip155:1', family: 'evm' },
        addresses: [{ value: publicAddress }],
        privateExecutionAddress: privateAddress
      },
      {
        chain: { id: 'eip155:8453', family: 'evm' },
        addresses: [{ value: publicAddress }]
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
          destination: { chainId: 'eip155:1', recipient: privateAddress }
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
    expect(route.hideDestinationCredit).toBeUndefined()
    expect(getActivityRouteTitle(item, route, { viewedDomain: 'public' })).toBe('Send')
    expect(getActivityRouteTitle(item, route, { viewedDomain: 'private' })).toBe('Receive')
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
    const externalTransfer = {
      ...item,
      snapshot: {
        ...item.snapshot,
        protocol: {
          ...item.snapshot.protocol,
          destination: { chainId: 'eip155:8453', recipient: externalAddress }
        }
      }
    }
    const externalRoute = getActivitySwapPresentation(
      externalTransfer,
      assets,
      chains,
      addressModes
    )
    expect(externalRoute.destinationAccountMode).toBeUndefined()
    expect(externalRoute.hideDestinationCredit).toBe(true)
    expect(
      getActivitySwapPresentation(
        {
          ...externalTransfer,
          snapshot: {
            ...externalTransfer.snapshot,
            protocol: {
              ...externalTransfer.snapshot.protocol,
              destination: { chainId: 'eip155:8453', recipient: publicAddress }
            }
          }
        },
        assets,
        chains,
        addressModes
      )?.hideDestinationCredit
    ).toBeUndefined()
    expect(getActivityRouteTitle(externalTransfer, externalRoute)).toBe('Send')
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
        counterAmount: { assetId: destinationId, amountRaw: '2500001' }
      }
    }

    const route = getActivitySwapPresentation(item, assetMetadata, chainMetadata)
    expect(route).toEqual({
      source: { assetId: sourceId, symbol: 'ETH', formatted: '1', exact: '1' },
      destination: { assetId: destinationId, symbol: 'USDC', formatted: '2.5', exact: '2.500001' },
      sourceNetwork: 'Ethereum',
      destinationNetwork: 'Arbitrum',
      sourceChainIconAlias: 'ethereum',
      destinationChainIconAlias: 'arbitrum'
    })
    expect(getActivityRouteTitle(item, route)).toBe('Swap')
    expect(
      getActivityAction(
        item,
        { viewedDomain: 'private' },
        {
          ...route,
          sourceAccountMode: 'Public',
          destinationAccountMode: 'Confidential'
        }
      )
    ).toEqual({ label: 'Swap', side: 'none' })
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

  test('shows the final Near Intents transfer recipient instead of the deposit address', () => {
    const depositAddress = `0x${'2'.repeat(40)}`
    const destination = `0x${'3'.repeat(40)}`
    const assetId = 'eip155:8453/slip44:60'
    const item = {
      ...failedItem({ transactionHash }),
      failureCode: undefined,
      status: 'confirming',
      snapshot: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId, amountRaw: '21080000000000' },
        counterAmount: { assetId, amountRaw: '20000000000000' },
        recipient: { chainId: 'eip155:8453', address: depositAddress },
        protocol: {
          provider: 'near-intents',
          userAction: 'transfer',
          destination: { recipient: destination }
        }
      }
    }
    const assets = new Map([[assetId, { metadata: { symbol: 'ETH', decimals: 18 } }]])

    expect(getActivityTransferRecipient(item)).toBe(destination)
    expect(getActivityRowTextPresentation(item, 'ETH', 'ETH', 'Base')).toEqual({
      title: 'Sent ETH',
      subtitle: 'To: 0x3333...333333'
    })
    expect(getActivitySwapPresentation(item, assets, new Map())).toBeNull()
  })

  test('offers pending EVM actions for an onchain origin until it finalizes or is replaced', () => {
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
    expect(
      canCancelEvmActivity(
        {
          ...item,
          status: 'confirming',
          segments: [{ ...item.segments[0], status: 'confirming' }]
        },
        ['eip155:1']
      )
    ).toBe(false)
    expect(canCancelEvmActivity({ ...item, status: 'final' }, ['eip155:1'])).toBe(false)
    expect(canCancelEvmActivity({ ...item, kind: 'cancel' }, ['eip155:1'])).toBe(false)
    const shield = {
      ...item,
      kind: 'shield',
      snapshot: {
        ...item.snapshot,
        shield: { operation: 'deposit', sourceDomain: 'private', destinationDomain: 'shield' },
        evm: { ...item.snapshot.evm, unsignedTransaction: { type: 'eip1559' } },
        protocol: { expiresAt: 200 }
      },
      segments: [
        ...item.segments,
        { role: 'relay', status: 'created', target: { kind: 'protocol' } }
      ]
    }
    expect(canCancelEvmActivity(shield, ['eip155:1'])).toBe(true)
    expect(canSpeedUpEvmActivity(shield, ['eip155:1'], 100)).toBe(true)
    const processing = {
      ...shield,
      segments: [
        { ...shield.segments[0], evidence: { transactionHash, confirmations: 0 } },
        { ...shield.segments[1], status: 'broadcast' }
      ]
    }
    expect(canCancelEvmActivity(processing, ['eip155:1'])).toBe(true)
    expect(canSpeedUpEvmActivity(processing, ['eip155:1'], 100)).toBe(true)
    const completedDestination = {
      ...processing,
      status: 'confirming',
      segments: [
        processing.segments[0],
        processing.segments[1],
        { role: 'destination', status: 'final', target: { kind: 'onchain', chainId: 'eip155:56' } }
      ]
    }
    expect(canCancelEvmActivity(completedDestination, ['eip155:1'])).toBe(false)
    expect(canSpeedUpEvmActivity(completedDestination, ['eip155:1'], 100)).toBe(false)
    const includedDestination = {
      ...completedDestination,
      segments: [
        processing.segments[0],
        processing.segments[1],
        {
          role: 'destination',
          status: 'confirming',
          target: { kind: 'onchain', chainId: 'eip155:56' },
          evidence: { transactionHash: `0x${'d'.repeat(64)}`, blockHeight: 0 }
        }
      ]
    }
    expect(canCancelEvmActivity(includedDestination, ['eip155:1'])).toBe(false)
    expect(canSpeedUpEvmActivity(includedDestination, ['eip155:1'], 100)).toBe(false)
    const pendingDestination = {
      ...includedDestination,
      segments: [
        processing.segments[0],
        processing.segments[1],
        {
          ...includedDestination.segments[2],
          status: 'broadcast',
          evidence: { transactionHash: `0x${'d'.repeat(64)}` }
        }
      ]
    }
    expect(canCancelEvmActivity(pendingDestination, ['eip155:1'])).toBe(true)
    expect(canSpeedUpEvmActivity(pendingDestination, ['eip155:1'], 100)).toBe(true)
    for (const evidence of [
      { blockHeight: 0 },
      { blockHash: `0x${'c'.repeat(64)}` },
      { confirmations: 1 }
    ]) {
      const mined = {
        ...processing,
        segments: [
          { ...processing.segments[0], evidence: { transactionHash, ...evidence } },
          processing.segments[1]
        ]
      }
      expect(canCancelEvmActivity(mined, ['eip155:1'])).toBe(false)
      expect(canSpeedUpEvmActivity(mined, ['eip155:1'], 100)).toBe(false)
    }
    for (const reconfirming of [
      { ...processing, reconfirming: true },
      {
        ...processing,
        segments: [{ ...processing.segments[0], reconfirming: true }, processing.segments[1]]
      }
    ]) {
      expect(canCancelEvmActivity(reconfirming, ['eip155:1'])).toBe(false)
      expect(canSpeedUpEvmActivity(reconfirming, ['eip155:1'], 100)).toBe(false)
    }
    expect(canSpeedUpEvmActivity(shield, ['eip155:1'], 200)).toBe(false)
    expect(canSpeedUpEvmActivity(shield, ['eip155:1'], 100, 100)).toBe(false)
    expect(
      canSpeedUpEvmActivity(
        { ...shield, snapshot: { ...shield.snapshot, evm: item.snapshot.evm } },
        ['eip155:1'],
        100
      )
    ).toBe(false)
    expect(
      canCancelEvmActivity({ ...shield, segments: [{ ...item.segments[0], status: 'final' }] }, [
        'eip155:1'
      ])
    ).toBe(false)
    expect(
      canCancelEvmActivity(
        {
          ...shield,
          segments: [
            { ...item.segments[0], evidence: { transactionHash, replacementTransactionHash } }
          ]
        },
        ['eip155:1']
      )
    ).toBe(false)
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

  test('uses only the complete, scoped Cluster settlement instead of its quote', () => {
    const assetId = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    const item = {
      id: 'tx:confidential:cluster-plan',
      scope: { keyDomainId: 'wallet:cluster', accountId: 'account:cluster' },
      kind: 'withdraw',
      status: 'final',
      completeness: 'complete',
      snapshot: {
        schemaVersion: 1,
        shield: {
          schemaVersion: 1,
          operation: 'cluster',
          sourceDomain: 'public',
          destinationDomain: 'private'
        },
        primaryAmount: { assetId, amountRaw: '160000' },
        counterAmount: { assetId, amountRaw: '144700' }
      },
      segments: [0, 1, 2].map(sequence => ({
        id: `destination:${sequence}`,
        role: 'destination',
        target: { kind: 'onchain', chainId: 'eip155:8453' },
        status: 'final'
      }))
    }
    const plan = {
      operation: 'cluster',
      phase: 'ready',
      transactionId: item.id,
      keyDomainId: item.scope.keyDomainId,
      accountId: item.scope.accountId,
      destination: { assetId },
      withdraws: [40828, 51918, 52052].map((value, sequence) => ({
        sequence,
        status: 'SUCCESS',
        settledOutputRaw: String(value)
      }))
    }
    const settled = getClusterSettledDestination(item, plan)
    expect(settled).toEqual({ assetId, amountRaw: '144798' })
    const route = getActivitySwapPresentation(
      item,
      new Map([[assetId, { metadata: { symbol: 'USDC', decimals: 6 } }]]),
      new Map(),
      new Map(),
      settled
    )
    expect(route?.destinationIsSettled).toBe(true)
    expect(route?.destination?.exact).toBe('0.144798')
    expect(getClusterSettledDestination({ ...item, reconfirming: true }, plan)).toBeUndefined()
    expect(getClusterSettledDestination(item, { ...plan, phase: 'processing' })).toBeUndefined()
    expect(
      getClusterSettledDestination(item, {
        ...plan,
        withdraws: [
          { ...plan.withdraws[0], status: 'SUCCESS' },
          { ...plan.withdraws[1], status: 'PROCESSING' },
          plan.withdraws[2]
        ]
      })
    ).toBeUndefined()
    expect(
      getClusterSettledDestination(item, { ...plan, accountId: 'account:other' })
    ).toBeUndefined()
    expect(
      getClusterSettledDestination(item, {
        ...plan,
        destination: { assetId: 'eip155:1/slip44:60' }
      })
    ).toBeUndefined()
  })
})
