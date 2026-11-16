import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  setActiveChainEndpointSettings
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { setActiveBlockExplorerPreferences } from '../../../../src/lib/block-explorer-preferences.ts'
import { getBitcoinChainId, getZcashChainId } from '../../../../src/core/chains/registry/index.ts'
import {
  formatChainAddressExplorerUrl,
  formatChainAssetExplorerUrl,
  formatChainTransactionExplorerUrl,
  resolveChainExplorerTarget
} from '../../../../src/popup/services/chain-explorer.ts'

test.describe('chain explorer resolution', () => {
  test.afterEach(() => {
    setActiveChainEndpointSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS)
    setActiveBlockExplorerPreferences()
  })

  test('preserves the legacy Zcash preference when no chain override exists', () => {
    setActiveBlockExplorerPreferences({ zcash: 'zcashexplorer' })
    expect(
      formatChainTransactionExplorerUrl(getZcashChainId('mainnet'), 'abc 123', 'mainnet')
    ).toBe('https://mainnet.zcashexplorer.app/transactions/abc%20123')
  })

  test('uses chain-scoped explorer URL and transaction path overrides', () => {
    setActiveChainEndpointSettings({
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [
        {
          chainId: getZcashChainId('mainnet'),
          explorer: {
            label: 'Private Zcash explorer',
            baseUrl: 'https://zcash-explorer.example',
            transactionPath: 'transactions'
          }
        },
        {
          chainId: getBitcoinChainId('mainnet'),
          explorer: {
            label: 'Private Bitcoin explorer',
            baseUrl: 'https://bitcoin-explorer.example',
            transactionPath: 'tx'
          }
        },
        {
          chainId: 'eip155:56',
          explorer: {
            label: 'Private BSC explorer',
            baseUrl: 'https://bsc-explorer.example',
            transactionPath: 'transaction'
          }
        },
        {
          chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          explorer: {
            label: 'Private Solana explorer',
            baseUrl: 'https://solana-explorer.example',
            transactionPath: 'transaction'
          }
        },
        {
          chainId: 'near:mainnet',
          explorer: {
            label: 'Private NEAR explorer',
            baseUrl: 'https://near-explorer.example',
            transactionPath: 'transactions'
          }
        }
      ]
    })

    expect(
      formatChainTransactionExplorerUrl(getZcashChainId('mainnet'), 'zec-hash', 'mainnet')
    ).toBe('https://zcash-explorer.example/transactions/zec-hash')
    expect(
      formatChainTransactionExplorerUrl(getBitcoinChainId('mainnet'), 'btc-hash', 'mainnet')
    ).toBe('https://bitcoin-explorer.example/tx/btc-hash')
    expect(formatChainTransactionExplorerUrl('eip155:56', '0xhash', 'mainnet')).toBe(
      'https://bsc-explorer.example/transaction/0xhash'
    )
    expect(formatChainAddressExplorerUrl('eip155:56', '0x1234/5678', 'mainnet')).toBe(
      'https://bsc-explorer.example/address/0x1234%2F5678'
    )
    expect(
      formatChainTransactionExplorerUrl(
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        'sol/hash',
        'mainnet'
      )
    ).toBe('https://solana-explorer.example/transaction/sol%2Fhash')
    expect(
      formatChainAddressExplorerUrl(
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        'sol/address',
        'mainnet'
      )
    ).toBe('https://solana-explorer.example/address/sol%2Faddress')
    expect(formatChainTransactionExplorerUrl('near:mainnet', 'near hash', 'mainnet')).toBe(
      'https://near-explorer.example/transactions/near%20hash'
    )
    expect(formatChainAddressExplorerUrl('near:mainnet', 'alice.near', 'mainnet')).toBe(
      'https://near-explorer.example/address/alice.near'
    )
    expect(
      formatChainAssetExplorerUrl(
        'eip155:56',
        {
          kind: 'token',
          namespace: 'erc20',
          reference: '0x1234'
        },
        'mainnet'
      )
    ).toBe('https://bsc-explorer.example')
    expect(
      formatChainAssetExplorerUrl(
        getBitcoinChainId('mainnet'),
        { kind: 'native', namespace: 'slip44', reference: '0' },
        'mainnet'
      )
    ).toBe('https://bitcoin-explorer.example')
    expect(resolveChainExplorerTarget('eip155:31337', 'mainnet')).toBeNull()
    expect(formatChainTransactionExplorerUrl('eip155:31337', '0xlocal', 'mainnet')).toBe('')
    expect(formatChainAddressExplorerUrl('eip155:31337', '0x1234', 'mainnet')).toBe('')
    expect(
      formatChainAssetExplorerUrl(
        'eip155:31337',
        { kind: 'native', namespace: 'slip44', reference: '60' },
        'mainnet'
      )
    ).toBe('')
  })

  test('links bundled ERC-20 assets to their explorer token page', () => {
    expect(
      formatChainAssetExplorerUrl(
        'eip155:56',
        {
          kind: 'token',
          namespace: 'erc20',
          reference: '0x1234'
        },
        'mainnet'
      )
    ).toBe('https://bscscan.com/token/0x1234')
  })

  test('builds Solana and NEAR Activity explorer links for both global modes', () => {
    const solanaHash = 'solana/hash'
    const nearHash = 'near hash'
    expect(
      formatChainTransactionExplorerUrl(
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        solanaHash,
        'mainnet'
      )
    ).toBe('https://solscan.io/tx/solana%2Fhash')
    expect(
      formatChainTransactionExplorerUrl(
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        solanaHash,
        'testnet'
      )
    ).toBe('https://solscan.io/tx/solana%2Fhash?cluster=devnet')
    expect(formatChainTransactionExplorerUrl('near:mainnet', nearHash, 'mainnet')).toBe(
      'https://nearblocks.io/txns/near%20hash'
    )
    expect(formatChainTransactionExplorerUrl('near:testnet', nearHash, 'testnet')).toBe(
      'https://testnet.nearblocks.io/txns/near%20hash'
    )
  })
})
