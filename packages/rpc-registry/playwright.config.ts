import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  outputDir: '../../e2e-output/rpc-registry',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']]
})
