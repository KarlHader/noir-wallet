import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  createNearIntentsSupplyBinding,
  createNearIntentsSwapBinding,
  createQuoteDepositTransferClient,
  createRheaSwapBinding,
  listWalletSwapSourceTokens,
  resolveWalletOwnedQuoteAsset,
  resolveWalletQuoteReceiveTarget,
  resolveWalletSwapSourceToken,
  resolveRheaSwapDestinationIdentity,
  selectWalletOwnedQuoteAssetExecution
} from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import { parseAssetId } from '../../../src/core/chains/registry/asset-id.ts'
import {
  isPreparedSwapFeeUnaffordable,
  resolveConfidentialFundingDestinationToken,
  resolveLockedWalletSwapSourceToken,
  resolveSwapReviewAction
} from '../../../src/popup/services/swap-page-model.ts'

const EVM_CHAIN_ID = 'eip155:1'
const BITCOIN_CHAIN_ID = 'bip122:000000000019d6689c085ae165831e93'
const EVM_ASSET_ID = `${EVM_CHAIN_ID}/slip44:60`
const USER_TOKEN_CONTRACT = '0x3333333333333333333333333333333333333333'
const USER_TOKEN_ASSET_ID = `${EVM_CHAIN_ID}/erc20:${USER_TOKEN_CONTRACT}`
const USER_TOKEN_PROTOCOL_ASSET = 'nep141:eth-0x3333333333333333333333333333333333333333.omft.near'
const BITCOIN_ASSET_ID = `${BITCOIN_CHAIN_ID}/slip44:0`
const ZCASH_CHAIN_ID = 'bip122:00040fe8ec8471911baa1db1266ea15d'
const ZCASH_ASSET_ID = `${ZCASH_CHAIN_ID}/slip44:133`
const OPTIMISM_CHAIN_ID = 'eip155:10'
const OPTIMISM_ETH_ASSET_ID = `${OPTIMISM_CHAIN_ID}/slip44:60`
const MONAD_CHAIN_ID = 'eip155:143'
const MONAD_ASSET_ID = `${MONAD_CHAIN_ID}/slip44:268435779`
const BSC_CHAIN_ID = 'eip155:56'
const NEAR_CHAIN_ID = 'near:mainnet'
const NEAR_ASSET_ID = `${NEAR_CHAIN_ID}/slip44:397`

function portfolio() {
  const evmChain = {
    chain: {
      id: EVM_CHAIN_ID,
      family: 'evm',
      capabilities: { transaction: { status: 'available' } }
    }
  }
  const bitcoinChain = {
    chain: {
      id: BITCOIN_CHAIN_ID,
      family: 'bitcoin',
      capabilities: { transaction: { status: 'available' } }
    }
  }
  const nearChain = {
    chain: {
      id: NEAR_CHAIN_ID,
      family: 'near',
      capabilities: { transaction: { status: 'available' } }
    }
  }
  return {
    scope: { keyDomainId: 'wallet:test', accountId: 'account:test' },
    chains: [evmChain, bitcoinChain, nearChain],
    assets: [
      {
        asset: { id: EVM_ASSET_ID, chainId: EVM_CHAIN_ID, kind: 'native' },
        metadata: { symbol: 'ETH', decimals: 18 }
      },
      {
        asset: {
          id: USER_TOKEN_ASSET_ID,
          chainId: EVM_CHAIN_ID,
          namespace: 'erc20',
          reference: USER_TOKEN_CONTRACT,
          kind: 'token'
        },
        metadata: { symbol: 'TEST', decimals: 6 }
      },
      {
        asset: { id: BITCOIN_ASSET_ID, chainId: BITCOIN_CHAIN_ID, kind: 'native' },
        metadata: { symbol: 'BTC', decimals: 8 }
      },
      {
        asset: { id: NEAR_ASSET_ID, chainId: NEAR_CHAIN_ID, kind: 'native' },
        metadata: { symbol: 'NEAR', decimals: 24 }
      }
    ]
  }
}

const receiveTargets = {
  generationId: 'storage-v2-generation:test',
  keyDomainId: 'wallet:test',
  accountId: 'account:test',
  targets: [
    {
      chain: { id: EVM_CHAIN_ID },
      kind: 'evm',
      address: '0x1111111111111111111111111111111111111111'
    },
    {
      chain: { id: BITCOIN_CHAIN_ID },
      kind: 'bitcoin',
      addressType: 'p2wpkh',
      address: 'bc1qsource'
    },
    {
      chain: { id: BSC_CHAIN_ID },
      kind: 'evm',
      address: '0x2222222222222222222222222222222222222222'
    },
    {
      chain: { id: NEAR_CHAIN_ID },
      kind: 'near',
      address: 'alice.near'
    }
  ]
}

const mappings = [
  { assetId: EVM_ASSET_ID, protocolAssetId: 'nep141:eth.omft.near' },
  { assetId: BITCOIN_ASSET_ID, protocolAssetId: 'nep141:btc.omft.near' }
]

function token(assetId, blockchain, decimals) {
  return {
    assetId,
    blockchain,
    decimals,
    price: 1,
    priceUpdatedAt: '2026-08-11T00:00:00.000Z',
    symbol: blockchain.toUpperCase()
  }
}

function review(transactionId, fingerprint = 'a'.repeat(64)) {
  return {
    graph: { root: { id: transactionId } },
    review: { payloadFingerprint: { digestHex: fingerprint } }
  }
}

function nearIntentsBinding(source, depositAddress, amountRaw) {
  return {
    schemaVersion: 1,
    provider: 'near-intents',
    kind: 'swap',
    depositAddress,
    refundAddress: source.refundAddress,
    expiresAt: Date.now() + 60_000,
    origin: {
      chainId: source.chain.chain.id,
      assetId: source.asset.asset.id,
      protocolAssetId: source.sourceAssetId
    },
    destination: {
      chainId: ZCASH_CHAIN_ID,
      assetId: ZCASH_ASSET_ID,
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: amountRaw,
      minimumAmountRaw: amountRaw
    }
  }
}

test.describe('quote deposit transfer client', () => {
  test('wallet-funded swaps proceed through signing or transfer and never external deposit', () => {
    const base = {
      isZecSource: false,
      hasDepositAddress: true,
      hasSigningReview: false,
      hasPreparedTransfer: false
    }
    expect(resolveSwapReviewAction({ ...base, hasPreparedTransfer: true })).toBe('wallet-transfer')
    expect(resolveSwapReviewAction({ ...base, hasSigningReview: true })).toBe('wallet-signing')
    expect(resolveSwapReviewAction(base)).toBe('unavailable')
    expect(resolveSwapReviewAction({ ...base, isZecSource: true })).toBe('zcash-transfer')
  })

  test('requires the native balance to cover the prepared EVM value and maximum network fee', () => {
    const prepared = {
      family: 'evm',
      source: { networkFeeAsset: { balance: { availableRaw: '100' } } },
      review: {
        review: {
          summary: {
            schema: 'evm.transaction.v1',
            fields: { valueWei: '30', maximumFeeWei: '71' }
          }
        }
      }
    }
    expect(isPreparedSwapFeeUnaffordable(prepared)).toBe(true)
    prepared.review.review.summary.fields.maximumFeeWei = '70'
    expect(isPreparedSwapFeeUnaffordable(prepared)).toBe(false)
    prepared.review.review.summary.fields.valueWei = '0'
    prepared.review.review.summary.fields.maximumFeeWei = '101'
    expect(isPreparedSwapFeeUnaffordable(prepared)).toBe(true)
  })

  test('preserves protocol identifiers with underscores in canonical destination asset IDs', () => {
    const protocolId = 'nep245:v2_1.omni.hot.tg:56_12zbnsg6xndDVj25QyL82YMPudb'
    const destination = resolveRheaSwapDestinationIdentity(
      { ...token(protocolId, 'bsc', 18), tokenListChainId: 56, rheaChainId: '56' },
      null
    )
    const parsed = parseAssetId(destination.assetId)
    expect(parsed.chainId).toBe('rhea:56')
    expect(parsed.reference).toBe('nep245%3Av2%5F1.omni.hot.tg%3A56%5F12zbnsg6xndDVj25QyL82YMPudb')
    expect(decodeURIComponent(parsed.reference)).toBe(protocolId)
  })

  test('finds a wallet funding destination without resolving unrelated protocol asset IDs', () => {
    const model = portfolio()
    model.chains[0].chain.family = 'evm'
    const eth = {
      ...token('nep141:eth.omft.near', 'eth', 18),
      tokenListChainId: 1,
      rheaChainId: '1',
      isNative: true,
      sources: ['nearintents']
    }
    const unrelated = {
      ...eth,
      assetId: `nep245:v2_1.omni.hot.tg:${'a_'.repeat(90)}`,
      isNative: false
    }
    const input = {
      tokens: [unrelated, eth],
      destinationChain: '1',
      destinationAsset: EVM_ASSET_ID,
      portfolio: model,
      receiveTargets
    }
    expect(resolveConfidentialFundingDestinationToken(input)).toBe(eth)
    expect(
      resolveConfidentialFundingDestinationToken({ ...input, destinationAsset: eth.assetId })
    ).toBe(eth)
    expect(resolveConfidentialFundingDestinationToken({ ...input, destinationAsset: null })).toBe(
      eth
    )
    expect(
      resolveConfidentialFundingDestinationToken({ ...input, destinationChain: '56' })
    ).toBeNull()
    expect(resolveConfidentialFundingDestinationToken({ ...input, portfolio: null })).toBeNull()
    expect(
      resolveConfidentialFundingDestinationToken({
        ...input,
        tokens: [{ ...eth, sources: ['lifi'] }]
      })
    ).toBeNull()
    const { sources: _sources, ...legacyEth } = eth
    expect(resolveConfidentialFundingDestinationToken({ ...input, tokens: [legacyEth] })).toBeNull()
  })

  test('never falls back from a locked BNB transfer to a different wallet asset', () => {
    const bnb = {
      ...token('nep245:v2_1.omni.hot.tg:56_11111111111111111111', 'bsc', 18),
      tokenListChainId: 56,
      rheaChainId: '56',
      rheaAddress: '0x0000000000000000000000000000000000000000',
      isNative: true
    }
    const usdc = {
      ...token('nep141:eth-usdc.omft.near', 'eth', 6),
      tokenListChainId: 1,
      rheaChainId: '1',
      rheaAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      isNative: false
    }

    expect(
      resolveLockedWalletSwapSourceToken({
        requestedToken: bnb,
        sourceTokens: [usdc, bnb],
        walletSourceTokens: [usdc, bnb]
      })
    ).toBe(bnb)
    expect(
      resolveLockedWalletSwapSourceToken({
        requestedToken: bnb,
        sourceTokens: [usdc],
        walletSourceTokens: [usdc]
      })
    ).toBeNull()
  })

  test('binds EVM signature orders to the signing account instead of the router', () => {
    const source = {
      family: 'evm',
      sourceAssetId: 'nep141:eth.omft.near',
      refundAddress: '0x1111111111111111111111111111111111111111',
      chain: { chain: { id: EVM_CHAIN_ID } },
      asset: { asset: { id: EVM_ASSET_ID } }
    }
    const tokenIn = {
      rheaChainId: '1',
      assetId: source.sourceAssetId,
      rheaAddress: source.sourceAssetId
    }
    const tokenOut = {
      rheaChainId: 'near',
      assetId: 'nep141:wrap.near',
      rheaAddress: 'wrap.near'
    }
    const quote = {
      quoteHandle: 'rhea-quote:signature-binding',
      recipient: 'alice.near',
      estimatedOut: '900',
      minAmountOut: '850',
      router: 'one-inch',
      receivedAt: 1_000,
      expiresAt: 5_000
    }
    const review = {
      executionId: 'execution-signature-binding',
      router: 'one-inch',
      amountIn: '1000',
      isCrossChain: true,
      execution: {
        kind: 'evm-signature',
        target: '0x2222222222222222222222222222222222222222'
      }
    }

    expect(
      createRheaSwapBinding({
        source,
        destinationAssetId: 'near:mainnet/slip44:397',
        destinationChainId: 'near:mainnet',
        tokenIn,
        tokenOut,
        quote,
        review
      }).sourceTarget
    ).toBe(source.refundAddress)
  })

  test('monitors same-chain Confidential routes through destination settlement', () => {
    const source = {
      family: 'evm',
      refundAddress: '0x1111111111111111111111111111111111111111',
      chain: { chain: { id: 'eip155:1' } },
      asset: { asset: { id: 'eip155:1/slip44:60' } }
    }
    const token = {
      rheaChainId: '1',
      assetId: 'nep141:eth.omft.near',
      rheaAddress: 'native'
    }
    const input = {
      source,
      destinationAssetId: 'eip155:1/slip44:60',
      destinationChainId: 'eip155:1',
      tokenIn: token,
      tokenOut: token,
      quote: {
        quoteHandle: 'rhea-quote:private-same-chain',
        recipient: '0x2222222222222222222222222222222222222222',
        estimatedOut: '990',
        minAmountOut: '980',
        router: 'nearintents',
        receivedAt: 1_000,
        expiresAt: 5_000
      },
      review: {
        executionId: 'execution-private-same-chain',
        router: 'nearintents',
        amountIn: '1000',
        isCrossChain: false,
        execution: {
          kind: 'evm-signature',
          target: source.refundAddress
        }
      }
    }

    expect(createRheaSwapBinding(input).isCrossChain).toBe(false)
    expect(createRheaSwapBinding({ ...input, confidentiality: 'basic' }).isCrossChain).toBe(true)
  })

  test('passes the exact Near Intents binding into Solana and NEAR wallet preparation', async () => {
    const calls = []
    const unsupported = {
      prepareTransfer: async () => {
        throw new Error('unexpected prepare')
      },
      approveTransfer: async () => {
        throw new Error('unexpected approve')
      },
      rejectTransfer: async () => {
        throw new Error('unexpected reject')
      }
    }
    const protocolClient = family => ({
      prepareTransfer: async (intent, options) => {
        calls.push([family, intent, options])
        return review(`transaction:${family}:quote`)
      },
      approveTransfer: async () => {
        throw new Error('unexpected approve')
      },
      rejectTransfer: async () => {
        throw new Error('unexpected reject')
      }
    })
    const client = createQuoteDepositTransferClient({
      evm: unsupported,
      bitcoin: unsupported,
      solana: protocolClient('solana'),
      near: protocolClient('near')
    })

    for (const [family, chainId, assetId, address] of [
      [
        'solana',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:mint',
        'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
      ],
      ['near', 'near:mainnet', 'near:mainnet/nep141:token.near', 'alice.near']
    ]) {
      const source = {
        family,
        sourceAssetId: `protocol:${family}`,
        refundAddress: address,
        chain: { chain: { id: chainId } },
        asset: { asset: { id: assetId, kind: 'token' }, balance: { availableRaw: '100' } },
        networkFeeAsset: { metadata: { symbol: family === 'solana' ? 'SOL' : 'NEAR', decimals: 9 } }
      }
      const binding = nearIntentsBinding(source, address, '10')
      await client.prepare({
        source,
        depositAddress: address,
        amountRaw: '10',
        nearIntentsBinding: binding
      })
      expect(calls.at(-1)).toEqual([
        family,
        { assetId, recipient: address, amountRaw: '10' },
        { nearIntentsBinding: binding }
      ])
    }
  })

  test('reserves 25% of the EVM fee cap beyond the live signing fee and rejects the preflight', async () => {
    const calls = []
    const source = {
      family: 'evm',
      asset: {
        asset: { id: EVM_ASSET_ID, kind: 'native' },
        balance: { availableRaw: '100000' }
      },
      networkFeeAsset: { metadata: { symbol: 'POL', decimals: 18 } }
    }
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async (intent, options) => {
          calls.push(['prepare', intent, options])
          return {
            graph: { root: { id: 'transaction:evm:max' } },
            review: {
              summary: {
                schema: 'evm.transaction.v1',
                fields: { maximumFeeWei: '21000' }
              }
            }
          }
        },
        approveTransfer: async () => {
          throw new Error('unexpected approve')
        },
        rejectTransfer: async transactionId => {
          calls.push(['reject', transactionId])
          return { root: { id: transactionId } }
        }
      },
      bitcoin: {
        prepareTransfer: async () => {
          throw new Error('unexpected Bitcoin prepare')
        },
        approveTransfer: async () => {
          throw new Error('unexpected Bitcoin approve')
        },
        rejectTransfer: async () => {
          throw new Error('unexpected Bitcoin reject')
        }
      }
    })

    await expect(
      client.estimateMaximum({
        source,
        depositAddress: '0x2222222222222222222222222222222222222222',
        feeTier: 'fast'
      })
    ).resolves.toEqual({
      amountRaw: '73750',
      networkFeeRaw: '21000',
      networkFeeSymbol: 'POL',
      networkFeeDecimals: 18
    })
    expect(calls).toEqual([
      [
        'prepare',
        {
          assetId: EVM_ASSET_ID,
          recipient: '0x2222222222222222222222222222222222222222',
          amountRaw: '1'
        },
        { feeTier: 'fast' }
      ],
      ['reject', 'transaction:evm:max']
    ])
  })

  test('deducts NEAR fees and storage without adding the probe amount back into the balance', async () => {
    const rejected = []
    const client = createQuoteDepositTransferClient({
      near: {
        prepareTransfer: async intent => {
          if (BigInt(intent.amountRaw) + 720n > 1000n) throw new Error('Insufficient funds')
          return {
            graph: { root: { id: 'near-max', intent: { feeLimit: { amountRaw: '700' } } } },
            debit: { maximumFeeRaw: '700', storageReserveRaw: '20' },
            review: {
              summary: {
                schema: 'near.transaction.v1',
                fields: { actions: [{ kind: 'transfer', depositYocto: intent.amountRaw }] }
              }
            }
          }
        },
        rejectTransfer: async id => {
          rejected.push(id)
        }
      }
    })
    const source = {
      family: 'near',
      asset: { asset: { id: NEAR_ASSET_ID, kind: 'native' }, balance: { availableRaw: '1000' } },
      networkFeeAsset: { metadata: { symbol: 'NEAR', decimals: 24 } }
    }
    await expect(
      client.estimateMaximum({ source, depositAddress: 'alice.near' })
    ).resolves.toMatchObject({ amountRaw: '280', networkFeeRaw: '700' })
    expect(rejected).toEqual(['near-max'])
  })

  test('deducts SOL transaction fees and rejects a maximum estimate with missing fee evidence', async () => {
    let fee = '700'
    const rejected = []
    const client = createQuoteDepositTransferClient({
      solana: {
        prepareTransfer: async intent => {
          if (fee && BigInt(intent.amountRaw) + BigInt(fee) > 1000n)
            throw new Error('Insufficient funds')
          return {
            graph: { root: { id: 'sol-max', intent: { feeLimit: { amountRaw: fee } } } },
            review: { summary: { schema: 'solana.transaction.v1' } }
          }
        },
        rejectTransfer: async id => {
          rejected.push(id)
        }
      }
    })
    const source = {
      family: 'solana',
      asset: {
        asset: { id: 'solana:mainnet/slip44:501', kind: 'native' },
        balance: { availableRaw: '1000' }
      },
      networkFeeAsset: { metadata: { symbol: 'SOL', decimals: 9 } }
    }
    await expect(
      client.estimateMaximum({ source, depositAddress: 'recipient' })
    ).resolves.toMatchObject({ amountRaw: '300', networkFeeRaw: '700' })
    fee = undefined
    await expect(client.estimateMaximum({ source, depositAddress: 'recipient' })).rejects.toThrow(
      'valid network fee'
    )
    expect(rejected).toEqual(['sol-max', 'sol-max'])
  })

  test('can estimate native Max even when the live fee consumes most of the source balance', async () => {
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async intent => {
          if (BigInt(intent.amountRaw) + 700n > 1000n) throw new Error('Insufficient funds')
          return {
            graph: { root: { id: 'tiny-balance' } },
            review: { summary: { schema: 'evm.transaction.v1', fields: { maximumFeeWei: '700' } } }
          }
        },
        rejectTransfer: async () => {}
      }
    })
    const source = {
      family: 'evm',
      asset: { asset: { id: EVM_ASSET_ID, kind: 'native' }, balance: { availableRaw: '1000' } },
      networkFeeAsset: { metadata: { symbol: 'ETH', decimals: 18 } }
    }
    await expect(
      client.estimateMaximum({ source, depositAddress: 'recipient' })
    ).resolves.toMatchObject({ amountRaw: '125' })
  })

  for (const mode of ['main', 'private']) {
    test(`reserves actual Swap calldata gas and attached native value for ${mode} Max`, async () => {
      const source = {
        family: 'evm',
        chain: { chain: { id: 'eip155:1' } },
        asset: {
          asset: { id: EVM_ASSET_ID, kind: 'native' },
          balance: { availableRaw: '1000000' }
        },
        networkFeeAsset: { metadata: { symbol: 'ETH', decimals: 18 } }
      }
      const calls = []
      const transaction = {
        chainId: 1,
        to: '0x2222222222222222222222222222222222222222',
        from: null,
        data: '0x12345678aabb',
        value: '500100'
      }
      const client = createQuoteDepositTransferClient({
        evm: {
          prepareTransfer: async () => {
            throw new Error('must not estimate a plain transfer')
          },
          prepareContractCall: async (intent, options) => {
            calls.push([intent, options])
            return {
              graph: { root: { id: 'actual-call' } },
              review: {
                summary: {
                  schema: 'evm.transaction.v1',
                  fields: { maximumFeeWei: '300000' }
                }
              }
            }
          },
          rejectTransfer: async id => {
            calls.push(id)
          }
        }
      })
      const input = {
        source,
        depositAddress: transaction.to,
        evmTransaction: transaction,
        quotedAmountRaw: '500000',
        executionMode: mode,
        feeTier: 'fast'
      }
      await expect(client.estimateMaximum(input)).resolves.toMatchObject({
        amountRaw: '624900',
        networkFeeRaw: '300000'
      })
      expect(calls).toEqual([
        [
          {
            chainId: 'eip155:1',
            contractAddress: transaction.to,
            valueRaw: '500100',
            calldata: transaction.data
          },
          { executionMode: mode, feeTier: 'fast' }
        ],
        'actual-call'
      ])
      source.asset.balance.availableRaw = '100'
      await expect(client.estimateMaximum(input)).rejects.toThrow('does not cover')
      expect(calls.at(-1)).toBe('actual-call')
      await expect(
        client.estimateMaximum({ ...input, evmTransaction: { ...transaction, chainId: 56 } })
      ).rejects.toThrow('does not match')
    })
  }

  test('estimates a plain native Swap route using its exact transfer value', async () => {
    const calls = []
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async intent => {
          calls.push(intent)
          return {
            graph: { root: { id: 'plain-route' } },
            review: {
              summary: {
                schema: 'evm.transaction.v1',
                fields: { maximumFeeWei: '63000' }
              }
            }
          }
        },
        prepareContractCall: async () => {
          throw new Error('not a contract call')
        },
        rejectTransfer: async id => {
          calls.push(id)
        }
      }
    })
    await expect(
      client.estimateMaximum({
        source: {
          family: 'evm',
          chain: { chain: { id: 'eip155:1' } },
          asset: {
            asset: { id: EVM_ASSET_ID, kind: 'native' },
            balance: { availableRaw: '1000000' }
          },
          networkFeeAsset: { metadata: { symbol: 'ETH', decimals: 18 } }
        },
        depositAddress: '0x2222222222222222222222222222222222222222',
        quotedAmountRaw: '500000',
        evmTransaction: {
          chainId: 1,
          from: null,
          to: '0x2222222222222222222222222222222222222222',
          value: '500100',
          data: '0x'
        }
      })
    ).resolves.toMatchObject({ amountRaw: '921150' })
    expect(calls).toEqual([
      {
        assetId: EVM_ASSET_ID,
        recipient: '0x2222222222222222222222222222222222222222',
        amountRaw: '500100'
      },
      'plain-route'
    ])
  })

  test('uses the Bitcoin max coin-selection result instead of treating its balance as sendable', async () => {
    const calls = []
    const source = {
      family: 'bitcoin',
      asset: {
        asset: { id: BITCOIN_ASSET_ID, kind: 'native' },
        balance: { availableRaw: '100000' }
      },
      networkFeeAsset: { metadata: { symbol: 'BTC', decimals: 8 } }
    }
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async () => {
          throw new Error('unexpected EVM prepare')
        },
        approveTransfer: async () => {
          throw new Error('unexpected EVM approve')
        },
        rejectTransfer: async () => {
          throw new Error('unexpected EVM reject')
        }
      },
      bitcoin: {
        prepareTransfer: async (intent, options) => {
          calls.push(['prepare', intent, options])
          return {
            graph: {
              root: {
                id: 'transaction:bitcoin:max',
                intent: { primaryAmount: { amountRaw: '99860' } }
              }
            },
            review: {
              summary: { schema: 'bitcoin.psbt.v1', fields: { feeSats: '140' } }
            }
          }
        },
        approveTransfer: async () => {
          throw new Error('unexpected approve')
        },
        rejectTransfer: async transactionId => {
          calls.push(['reject', transactionId])
          return { root: { id: transactionId } }
        }
      }
    })

    await expect(
      client.estimateMaximum({ source, depositAddress: 'bc1qdestination', feeTier: 'low' })
    ).resolves.toEqual({
      amountRaw: '99860',
      networkFeeRaw: '140',
      networkFeeSymbol: 'BTC',
      networkFeeDecimals: 8
    })
    expect(calls).toEqual([
      [
        'prepare',
        { recipient: 'bc1qdestination', amount: { mode: 'max' } },
        { bitcoinAddressType: undefined, feeTier: 'low' }
      ],
      ['reject', 'transaction:bitcoin:max']
    ])
  })

  test('resolves only exact supported wallet assets with an active refund address', () => {
    const evm = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    expect(evm).toMatchObject({
      family: 'evm',
      sourceAssetId: 'nep141:eth.omft.near',
      refundAddress: '0x1111111111111111111111111111111111111111',
      networkFeeAsset: { asset: { id: EVM_ASSET_ID }, metadata: { symbol: 'ETH', decimals: 18 } }
    })

    expect(
      resolveWalletOwnedQuoteAsset(
        token('nep141:eth.omft.near', 'eth', 6),
        portfolio(),
        receiveTargets,
        mappings
      )
    ).toBeNull()
    expect(
      resolveWalletOwnedQuoteAsset(
        token('nep141:unknown.omft.near', 'eth', 18),
        portfolio(),
        receiveTargets,
        mappings
      )
    ).toBeNull()
  })

  test('selects an exact Main or Private EVM balance and binds the Private Execution Address', () => {
    const source = {
      family: 'evm',
      refundAddress: '0x1111111111111111111111111111111111111111',
      asset: {
        asset: { id: USER_TOKEN_ASSET_ID, kind: 'token' },
        balance: {
          totalRaw: '700',
          spendableRaw: '700',
          availableRaw: '700',
          pendingRaw: '0',
          mainRaw: '500',
          privateRaw: '200'
        }
      },
      networkFeeAsset: {
        asset: { id: EVM_ASSET_ID, kind: 'native' },
        balance: {
          totalRaw: '70',
          spendableRaw: '70',
          availableRaw: '70',
          pendingRaw: '0',
          mainRaw: '50',
          privateRaw: '20'
        }
      }
    }

    expect(selectWalletOwnedQuoteAssetExecution(source, 'main')).toMatchObject({
      refundAddress: '0x1111111111111111111111111111111111111111',
      asset: { balance: { availableRaw: '500' } },
      networkFeeAsset: { balance: { availableRaw: '50' } }
    })
    expect(
      selectWalletOwnedQuoteAssetExecution(
        source,
        'private',
        '0x9999999999999999999999999999999999999999'
      )
    ).toMatchObject({
      refundAddress: '0x9999999999999999999999999999999999999999',
      asset: { balance: { availableRaw: '200' } },
      networkFeeAsset: { balance: { availableRaw: '20' } }
    })
    expect(selectWalletOwnedQuoteAssetExecution(source, 'private')).toBeNull()
  })

  test('lists every wallet-owned Intents source without admitting unsupported chains or assets', () => {
    const tokens = [
      token('nep141:zec.omft.near', 'zec', 8),
      token('nep141:eth.omft.near', 'eth', 18),
      token('nep141:btc.omft.near', 'btc', 8),
      {
        ...token(USER_TOKEN_PROTOCOL_ASSET, 'eth', 6),
        contractAddress: USER_TOKEN_CONTRACT
      },
      token('nep141:sol.omft.near', 'sol', 9),
      token('nep141:unknown.omft.near', 'eth', 18),
      token('nep141:eth.omft.near', 'eth', 6)
    ]

    expect(
      listWalletSwapSourceTokens(tokens, portfolio(), receiveTargets, {
        includeZcash: true,
        mappings
      }).map(candidate => `${candidate.blockchain}:${candidate.assetId}:${candidate.decimals}`)
    ).toEqual([
      'zec:nep141:zec.omft.near:8',
      'eth:nep141:eth.omft.near:18',
      'btc:nep141:btc.omft.near:8',
      `eth:${USER_TOKEN_PROTOCOL_ASSET}:6`
    ])
    expect(
      listWalletSwapSourceTokens(tokens, portfolio(), receiveTargets, {
        includeZcash: false,
        mappings
      }).map(candidate => candidate.blockchain)
    ).toEqual(['eth', 'btc', 'eth'])
  })

  test('resolves a managed destination address even when the destination Token is not enabled', () => {
    const target = resolveWalletQuoteReceiveTarget(
      {
        ...token('nep141:bsc-near.omft.near', 'bsc', 18),
        symbol: 'NEAR'
      },
      portfolio(),
      receiveTargets,
      mappings
    )

    expect(target).toMatchObject({
      kind: 'evm',
      address: '0x2222222222222222222222222222222222222222',
      chain: { id: BSC_CHAIN_ID }
    })
  })

  test('resolves the active wallet address for a native NEAR RHEA destination', () => {
    const target = resolveWalletQuoteReceiveTarget(
      {
        ...token('nep141:wrap.near', 'near', 24),
        contractAddress: null
      },
      portfolio(),
      receiveTargets,
      mappings
    )

    expect(target).toMatchObject({
      kind: 'near',
      address: 'alice.near',
      chain: { id: NEAR_CHAIN_ID }
    })
  })

  test('maps an Asset details wallet ID back to its Intents Swap source', () => {
    const eth = token('nep141:eth.omft.near', 'eth', 18)
    expect(
      resolveWalletSwapSourceToken(
        EVM_ASSET_ID,
        [token('nep141:zec.omft.near', 'zec', 8), eth],
        portfolio(),
        receiveTargets,
        mappings
      )
    ).toEqual(eth)
    expect(resolveWalletSwapSourceToken(EVM_ASSET_ID, [eth], null, null, mappings)).toEqual(eth)
  })

  test('binds an exact user-added EVM Token as a wallet destination', () => {
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    const destinationToken = {
      ...token(USER_TOKEN_PROTOCOL_ASSET, 'eth', 6),
      contractAddress: USER_TOKEN_CONTRACT
    }
    const destination = resolveWalletOwnedQuoteAsset(
      destinationToken,
      portfolio(),
      receiveTargets,
      mappings
    )
    const binding = createNearIntentsSwapBinding({
      source,
      destination,
      tokenIn: token('nep141:eth.omft.near', 'eth', 18),
      tokenOut: destinationToken,
      amountInRaw: '1000000000000000',
      recipient: '0x1111111111111111111111111111111111111111',
      quote: {
        amountIn: '1000000000000000',
        amountOut: '900000',
        minAmountOut: '895000',
        amountInFormatted: '0.001',
        amountOutFormatted: '0.9',
        depositAddress: '0x2222222222222222222222222222222222222222',
        deadline: '2026-08-11T01:00:00.000Z'
      },
      now: Date.parse('2026-08-11T00:00:00.000Z')
    })

    expect(binding.destination).toEqual({
      chainId: EVM_CHAIN_ID,
      assetId: USER_TOKEN_ASSET_ID,
      protocolAssetId: USER_TOKEN_PROTOCOL_ASSET,
      recipient: '0x1111111111111111111111111111111111111111',
      expectedAmountRaw: '900000',
      minimumAmountRaw: '895000'
    })
  })

  test('routes EVM quote deposits through prepare, fingerprint-bound approve, and reject', async () => {
    const calls = []
    const evmReview = review('transaction:evm:quote')
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async (intent, protocol) => {
          calls.push(['prepare', intent, protocol])
          return evmReview
        },
        approveTransfer: async (transactionId, fingerprint) => {
          calls.push(['approve', transactionId, fingerprint])
          return { status: 'broadcast', graph: { root: { id: transactionId } } }
        },
        rejectTransfer: async transactionId => {
          calls.push(['reject', transactionId])
          return { root: { id: transactionId } }
        }
      },
      bitcoin: {
        prepareTransfer: async () => {
          throw new Error('unexpected Bitcoin prepare')
        },
        approveTransfer: async () => {
          throw new Error('unexpected Bitcoin approve')
        },
        rejectTransfer: async () => {
          throw new Error('unexpected Bitcoin reject')
        }
      }
    })
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    expect(source).not.toBeNull()

    const binding = nearIntentsBinding(
      source,
      '0x2222222222222222222222222222222222222222',
      '1000000000000000'
    )
    const prepared = await client.prepare({
      source,
      depositAddress: '0x2222222222222222222222222222222222222222',
      amountRaw: '1000000000000000',
      nearIntentsBinding: binding,
      executionMode: 'private'
    })
    await client.approve(prepared)
    await client.reject(prepared)

    expect(calls).toEqual([
      [
        'prepare',
        {
          assetId: EVM_ASSET_ID,
          recipient: '0x2222222222222222222222222222222222222222',
          amountRaw: '1000000000000000'
        },
        { nearIntentsBinding: binding, executionMode: 'private' }
      ],
      ['approve', 'transaction:evm:quote', 'a'.repeat(64)],
      ['reject', 'transaction:evm:quote']
    ])
  })

  test('binds the exact quote assets, amounts, recipient, refund target, and deadline', () => {
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    const deadline = '2026-08-11T01:00:00.000Z'
    const binding = createNearIntentsSwapBinding({
      source,
      tokenIn: token('nep141:eth.omft.near', 'eth', 18),
      tokenOut: token('nep141:zec.omft.near', 'zec', 8),
      amountInRaw: '1000000000000000',
      recipient: 'u1destination',
      quote: {
        amountIn: '1000000000000000',
        amountOut: '900000',
        minAmountOut: '895000',
        amountInFormatted: '0.001',
        amountOutFormatted: '0.009',
        depositAddress: '0x2222222222222222222222222222222222222222',
        deadline
      },
      now: Date.parse('2026-08-11T00:00:00.000Z')
    })

    expect(binding).toEqual({
      schemaVersion: 1,
      provider: 'near-intents',
      kind: 'swap',
      depositAddress: '0x2222222222222222222222222222222222222222',
      refundAddress: '0x1111111111111111111111111111111111111111',
      expiresAt: Date.parse(deadline),
      origin: {
        chainId: EVM_CHAIN_ID,
        assetId: EVM_ASSET_ID,
        protocolAssetId: 'nep141:eth.omft.near'
      },
      destination: {
        chainId: ZCASH_CHAIN_ID,
        assetId: ZCASH_ASSET_ID,
        protocolAssetId: 'nep141:zec.omft.near',
        recipient: 'u1destination',
        expectedAmountRaw: '900000',
        minimumAmountRaw: '895000'
      }
    })
  })

  test('binds the live Optimism ETH to Monad MON route used by REF-13100', () => {
    const source = {
      family: 'evm',
      sourceAssetId: 'nep245:v2_1.omni.hot.tg:10_11111111111111111111',
      asset: {
        asset: { id: OPTIMISM_ETH_ASSET_ID, chainId: OPTIMISM_CHAIN_ID, kind: 'native' },
        metadata: { symbol: 'ETH', decimals: 18 }
      },
      networkFeeAsset: {
        asset: { id: OPTIMISM_ETH_ASSET_ID, chainId: OPTIMISM_CHAIN_ID, kind: 'native' },
        metadata: { symbol: 'ETH', decimals: 18 }
      },
      chain: {
        chain: {
          id: OPTIMISM_CHAIN_ID,
          family: 'evm',
          capabilities: { transaction: { status: 'available' } }
        }
      },
      refundAddress: '0xa22a000000000000000000000000000000921d85'
    }
    const deadline = '2026-08-28T07:49:25.501Z'
    const binding = createNearIntentsSwapBinding({
      source,
      tokenIn: token(source.sourceAssetId, 'op', 18),
      tokenOut: token('nep245:v2_1.omni.hot.tg:143_11111111111111111111', 'monad', 18),
      amountInRaw: '100000000000000',
      recipient: source.refundAddress,
      quote: {
        amountIn: '100000000000000',
        amountOut: '8297834135987235798',
        minAmountOut: '8293685218919242180',
        amountInFormatted: '0.0001',
        amountOutFormatted: '8.297834135987235798',
        depositAddress: '0x555b0000000000000000000000000000006e64fc',
        deadline
      },
      now: Date.parse('2026-08-25T07:49:25.501Z')
    })

    expect(binding.origin).toMatchObject({
      chainId: OPTIMISM_CHAIN_ID,
      assetId: OPTIMISM_ETH_ASSET_ID
    })
    expect(binding.destination).toMatchObject({
      chainId: MONAD_CHAIN_ID,
      assetId: MONAD_ASSET_ID,
      protocolAssetId: 'nep245:v2_1.omni.hot.tg:143_11111111111111111111'
    })
  })

  test('rejects a quote with a mismatched source amount or expired deadline', () => {
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    const create = overrides =>
      createNearIntentsSwapBinding({
        source,
        tokenIn: token('nep141:eth.omft.near', 'eth', 18),
        tokenOut: token('nep141:zec.omft.near', 'zec', 8),
        amountInRaw: '1000',
        recipient: 'u1destination',
        quote: {
          amountIn: '1000',
          amountOut: '900',
          minAmountOut: '895',
          amountInFormatted: '0.000000000000001',
          amountOutFormatted: '0.000009',
          depositAddress: '0x2222222222222222222222222222222222222222',
          deadline: '2026-08-11T01:00:00.000Z',
          ...overrides
        },
        now: Date.parse('2026-08-11T00:00:00.000Z')
      })

    expect(() => create({ amountIn: '999' })).toThrow(/does not match/)
    expect(() => create({ deadline: '2026-08-10T23:59:59.000Z' })).toThrow(/expired/)
  })

  test('binds an existing-MCA EVM supply quote to the RHEA position and exact source transfer', () => {
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    const quote = {
      depositAddress: '0x2222222222222222222222222222222222222222',
      expectedReceived: '0.009',
      minAmountOut: '0.0089',
      amountInRaw: '1000000000000000',
      amountOutRaw: '900000',
      minAmountOutRaw: '890000',
      deadline: '2026-08-11T01:00:00.000Z'
    }
    const binding = createNearIntentsSupplyBinding({
      source,
      amountInRaw: quote.amountInRaw,
      mcaId: 'rhea00000x.multica.near',
      quote,
      destinationAsset: 'nep141:eth.bridge.near',
      now: Date.parse('2026-08-11T00:00:00.000Z')
    })

    expect(binding).toEqual({
      schemaVersion: 1,
      provider: 'near-intents',
      kind: 'supply',
      depositAddress: quote.depositAddress,
      refundAddress: source.refundAddress,
      expiresAt: Date.parse(quote.deadline),
      origin: {
        chainId: EVM_CHAIN_ID,
        assetId: EVM_ASSET_ID,
        protocolAssetId: 'nep141:eth.omft.near'
      },
      destination: {
        chainId: EVM_CHAIN_ID,
        assetId: EVM_ASSET_ID,
        protocolAssetId: 'nep141:eth.bridge.near',
        recipient: 'rhea00000x.multica.near',
        expectedAmountRaw: '900000',
        minimumAmountRaw: '890000'
      }
    })
    expect(() =>
      createNearIntentsSupplyBinding({
        source,
        amountInRaw: '999',
        mcaId: 'rhea00000x.multica.near',
        quote,
        destinationAsset: 'nep141:eth.bridge.near',
        now: Date.parse('2026-08-11T00:00:00.000Z')
      })
    ).toThrow(/does not match/)
  })

  test('routes Bitcoin quote deposits as exact-value PSBT transfers', async () => {
    const calls = []
    const bitcoinReview = review('transaction:bitcoin:quote', 'b'.repeat(64))
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async () => {
          throw new Error('unexpected EVM prepare')
        },
        approveTransfer: async () => {
          throw new Error('unexpected EVM approve')
        },
        rejectTransfer: async () => {
          throw new Error('unexpected EVM reject')
        }
      },
      bitcoin: {
        prepareTransfer: async (intent, protocol) => {
          calls.push(['prepare', intent, protocol])
          return bitcoinReview
        },
        approveTransfer: async (transactionId, fingerprint) => {
          calls.push(['approve', transactionId, fingerprint])
          return { status: 'broadcast', graph: { root: { id: transactionId } } }
        },
        rejectTransfer: async transactionId => ({ root: { id: transactionId } })
      }
    })
    const taprootTargets = {
      ...receiveTargets,
      targets: receiveTargets.targets.map(target =>
        target.kind === 'bitcoin'
          ? { ...target, addressType: 'p2tr', address: 'bc1psource' }
          : target
      )
    }
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:btc.omft.near', 'btc', 8),
      portfolio(),
      taprootTargets,
      mappings
    )
    expect(source).not.toBeNull()

    const binding = nearIntentsBinding(source, 'bc1qdestination', '1200')
    const prepared = await client.prepare({
      source,
      depositAddress: 'bc1qdestination',
      amountRaw: '1200',
      nearIntentsBinding: binding
    })
    await client.approve(prepared)

    expect(calls).toEqual([
      [
        'prepare',
        {
          recipient: 'bc1qdestination',
          amount: { mode: 'exact', valueSats: '1200' }
        },
        { nearIntentsBinding: binding, bitcoinAddressType: 'p2tr' }
      ],
      ['approve', 'transaction:bitcoin:quote', 'b'.repeat(64)]
    ])
  })

  test('rejects zero, signed, fractional, and oversized base-unit amounts before routing', async () => {
    let called = false
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async () => {
          called = true
          return review('transaction:evm:quote')
        },
        approveTransfer: async () => {
          throw new Error('unexpected approve')
        },
        rejectTransfer: async () => {
          throw new Error('unexpected reject')
        }
      },
      bitcoin: {
        prepareTransfer: async () => {
          called = true
          return review('transaction:bitcoin:quote')
        },
        approveTransfer: async () => {
          throw new Error('unexpected approve')
        },
        rejectTransfer: async () => {
          throw new Error('unexpected reject')
        }
      }
    })
    const source = resolveWalletOwnedQuoteAsset(
      token('nep141:eth.omft.near', 'eth', 18),
      portfolio(),
      receiveTargets,
      mappings
    )
    for (const amountRaw of ['0', '-1', '1.5', `1${'0'.repeat(78)}`]) {
      await expect(
        client.prepare({
          source,
          depositAddress: '0x2222222222222222222222222222222222222222',
          amountRaw,
          nearIntentsBinding: nearIntentsBinding(
            source,
            '0x2222222222222222222222222222222222222222',
            '1'
          )
        })
      ).rejects.toThrow(/positive base-unit integer/)
    }
    expect(called).toBe(false)
  })
})
