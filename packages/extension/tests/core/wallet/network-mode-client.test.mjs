import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createNetworkModeClient } from '../../../src/popup/services/network-mode-client.ts'

test.describe('Network mode Popup client', () => {
  test('reads and switches only canonical global modes', async () => {
    const messages = []
    const client = createNetworkModeClient(async message => {
      messages.push(message)
      return message.type === 'GET_NETWORK_MODE'
        ? { result: { networkMode: 'mainnet', restartRequired: false } }
        : { result: { restartRequired: true } }
    })
    await expect(client.read()).resolves.toEqual({ networkMode: 'mainnet', restartRequired: false })
    await expect(client.switch('testnet')).resolves.toEqual({ restartRequired: true })
    expect(messages).toEqual([
      { type: 'GET_NETWORK_MODE' },
      { type: 'SWITCH_NETWORK_MODE', networkMode: 'testnet' }
    ])
  })

  test('fails closed for malformed and explicit error responses', async () => {
    await expect(
      createNetworkModeClient(async () => ({ result: { networkMode: 'preview' } })).read()
    ).rejects.toThrow('Invalid network mode result')
    await expect(
      createNetworkModeClient(async () => ({ error: 'Wallet is locked' })).switch('testnet')
    ).rejects.toThrow('Wallet is locked')
  })
})
