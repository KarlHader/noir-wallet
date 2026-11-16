import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  withActiveEvmChainId
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import { createChainEndpointSettingsClient } from '../../../../src/popup/services/chain-endpoint-settings-client.ts'

test('full endpoint updates send the expected settings snapshot for conflict detection', async () => {
  const expectedSettings = DEFAULT_CHAIN_ENDPOINT_SETTINGS
  const settings = withActiveEvmChainId(expectedSettings, 'eip155:1')
  let sent
  const client = createChainEndpointSettingsClient(async message => {
    sent = message
    return { result: settings }
  })

  assert.deepEqual(await client.apply(settings, expectedSettings), settings)
  assert.deepEqual(sent, {
    type: 'APPLY_CHAIN_ENDPOINT_SETTINGS',
    settings,
    expectedSettings
  })
})

test('full endpoint update exposes a stale settings rejection', async () => {
  const client = createChainEndpointSettingsClient(async () => ({
    error: 'Network settings changed. Reopen and try again.'
  }))
  await assert.rejects(
    client.apply(DEFAULT_CHAIN_ENDPOINT_SETTINGS, DEFAULT_CHAIN_ENDPOINT_SETTINGS),
    /Network settings changed/
  )
})
