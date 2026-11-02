import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

import { BUILTIN_EVM_NETWORKS } from '../../../src/config/networks.ts'

const sdkExampleCatalogUrl = new URL(
  '../../../../sdk/example/src/evm-network-catalog.ts',
  import.meta.url
)
const sdkProviderExamplesUrl = new URL(
  '../../../../sdk/example/src/ProviderExamples.tsx',
  import.meta.url
)

function extractExampleChainIds(source, mode) {
  return [
    ...source.matchAll(new RegExp(`network\\('${mode}',[\\s\\S]*?chainId: '(0x[0-9a-f]+)'`, 'g'))
  ]
    .map(match => match[1])
    .sort()
}

function toHexChainIds(networks) {
  return networks
    .map(network => `0x${BigInt(network.chainId.slice('eip155:'.length)).toString(16)}`)
    .sort()
}

test('keeps the SDK Example EVM networks aligned with the wallet catalog', async () => {
  const source = await readFile(sdkExampleCatalogUrl, 'utf8')

  for (const mode of ['mainnet', 'testnet']) {
    expect(extractExampleChainIds(source, mode)).toEqual(toHexChainIds(BUILTIN_EVM_NETWORKS[mode]))
  }
})

test('loads hosted SDK Example chain icons without requiring CORS headers', async () => {
  const source = await readFile(sdkProviderExamplesUrl, 'utf8')
  const componentStart = source.indexOf('export function ExampleChainIcon(')
  const componentEnd = source.indexOf('\nexport function ProviderSwitcher(', componentStart)
  const componentSource = source.slice(componentStart, componentEnd)

  expect(componentStart).toBeGreaterThanOrEqual(0)
  expect(componentEnd).toBeGreaterThan(componentStart)
  expect(componentSource).toContain('<img')
  expect(componentSource).not.toContain('crossOrigin=')
})
