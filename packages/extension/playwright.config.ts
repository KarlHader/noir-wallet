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
      name: 'extension',
      outputDir: '../../e2e-output/extension',
      testMatch: [
        'extension/extension-security.spec.ts',
        'extension/multichain-wasm.spec.ts',
        'extension/credential-repository.spec.ts',
        'extension/credential-session-resource-budget.spec.ts',
        'extension/keystone-v1-upgrade.spec.ts',
        'extension/mixed-v1-upgrade.spec.ts',
        'extension/v1-golden-upgrade.spec.ts',
        'extension/storage-migration.spec.ts',
        'extension/storage-quarantine.spec.ts',
        'extension/transaction-repository.spec.ts',
        'extension/bitcoin-discovery-repository.spec.ts',
        'extension/wallet-cleanup.spec.ts'
      ]
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
      testMatch: ['extension/transaction-testnet-environment.spec.ts']
    },
    {
      name: 'live-services',
      outputDir: '../../e2e-output/live-services',
      testMatch: ['live/services/**/*.spec.{mjs,ts}'],
      use: { screenshot: 'off', trace: 'off' }
    }
  ]
})
