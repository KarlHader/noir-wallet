import { defineConfig } from '@playwright/test'
import { loadLocalTestWalletEnvironment } from './scripts/lib/test-wallet-env.mjs'

loadLocalTestWalletEnvironment()

export default defineConfig({
  testDir: './tests',
  outputDir: '../../e2e-output/default',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 10_000
  },
  testIgnore: ['**/core/**', '**/helpers/**', '**/fixtures/**', '**/.local/**'],
  projects: [
    {
      name: 'live-services',
      outputDir: '../../e2e-output/live-services',
      testMatch: ['live/services/**/*.spec.{mjs,ts}'],
      use: { screenshot: 'off', trace: 'off' }
    },
    {
      name: 'asset-price-live',
      outputDir: '../../e2e-output/asset-price-live',
      testMatch: ['live/extension/asset-price-live.spec.ts']
    },
    {
      name: 'funding-source-live',
      outputDir: '../../e2e-output/funding-source-live',
      testMatch: ['live/extension/funding-source-live.spec.ts']
    },
    {
      name: 'protocol-live',
      outputDir: '../../e2e-output/protocol-live',
      testMatch: ['live/extension/rhea-swap.spec.ts']
    },
    {
      name: 'extension',
      outputDir: '../../e2e-output/extension',
      testMatch: [
        'extension/extension-smoke-ui.spec.ts',
        'extension/extension-security.spec.ts',
        'extension/multichain-wasm.spec.ts',
        'extension/credential-repository.spec.ts',
        'extension/credential-session-lifecycle.spec.ts',
        'extension/credential-session-resource-budget.spec.ts',
        'extension/keystone-v1-upgrade.spec.ts',
        'extension/mixed-v1-upgrade.spec.ts',
        'extension/v1-golden-upgrade.spec.ts',
        'extension/ledger-v2-provisioning.spec.ts',
        'extension/storage-migration.spec.ts',
        'extension/storage-quarantine.spec.ts',
        'extension/transaction-repository.spec.ts',
        'extension/bitcoin-discovery-repository.spec.ts',
        'extension/wallet-cleanup.spec.ts'
      ]
    },
    {
      name: 'release-default',
      outputDir: '../../e2e-output/release-default',
      testMatch: ['extension/release/**/*.spec.ts']
    },
    {
      name: 'production-dist',
      outputDir: '../../e2e-output/production-dist',
      testMatch: ['extension/production-dist-install.spec.ts']
    },
    {
      name: 'development-extension',
      outputDir: '../../e2e-output/development-extension',
      testMatch: ['extension/development-provider-injection.spec.ts']
    },
    {
      name: 'transaction-testnet',
      outputDir: '../../e2e-output/transaction-testnet',
      testMatch: [
        'extension/transaction-testnet-environment.spec.ts',
        'extension/testnet-wallet-provisioning.spec.ts'
      ]
    },
    {
      name: 'evm-testnet',
      outputDir: '../../e2e-output/evm-testnet',
      testMatch: ['extension/evm-transfer-testnet.spec.ts']
    },
    {
      name: 'evm-testnet-live',
      outputDir: '../../e2e-output/evm-testnet-live',
      testMatch: ['live/extension/evm-transfer-live-testnet.spec.ts']
    },
    {
      name: 'multichain-receive-testnet',
      outputDir: '../../e2e-output/multichain-receive-testnet',
      testMatch: ['extension/multichain-receive-testnet.spec.ts']
    },
    {
      name: 'solana-near-portfolio-testnet',
      outputDir: '../../e2e-output/solana-near-portfolio-testnet',
      testMatch: ['extension/solana-near-portfolio-testnet.spec.ts']
    },
    {
      name: 'solana-near-testnet-live',
      outputDir: '../../e2e-output/solana-near-testnet-live',
      testMatch: ['live/extension/solana-near-transfer-live-testnet.spec.ts'],
      use: { screenshot: 'off', trace: 'off' }
    },
    {
      name: 'private-key-testnet',
      outputDir: '../../e2e-output/private-key-testnet',
      testMatch: ['extension/private-key-wallet-testnet.spec.ts']
    },
    {
      name: 'bitcoin-testnet',
      outputDir: '../../e2e-output/bitcoin-testnet',
      testMatch: [
        'extension/bitcoin-transfer-testnet.spec.ts',
        'extension/bitcoin-dapp-provider-testnet.spec.ts'
      ]
    },
    {
      name: 'bitcoin-testnet-live',
      outputDir: '../../e2e-output/bitcoin-testnet-live',
      testMatch: ['live/extension/bitcoin-transfer-live-testnet.spec.ts'],
      use: { screenshot: 'off', trace: 'off' }
    },
    {
      name: 'protocol-mainnet',
      outputDir: '../../e2e-output/protocol-mainnet',
      testMatch: ['extension/protocol/**/*.spec.ts', 'extension/keystone-v2-provisioning.spec.ts']
    }
  ]
})
