import { test } from 'node:test'
import { expect } from '@playwright/test'
import { attestZcashLightwalletdEndpoint } from '../../../../src/infrastructure/chains/zcash/zcash-network-attestation.ts'

function lightwalletdInfoResponse(chainName) {
  const name = new TextEncoder().encode(chainName)
  const protobuf = new Uint8Array(2 + name.length)
  protobuf[0] = 0x22
  protobuf[1] = name.length
  protobuf.set(name, 2)
  const body = new Uint8Array(5 + protobuf.length)
  new DataView(body.buffer).setUint32(1, protobuf.length)
  body.set(protobuf, 5)
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/grpc-web+proto' }
  })
}

test.describe('Zcash lightwalletd network attestation', () => {
  test('accepts only the expected GetLightdInfo chain identity', async () => {
    const originalFetch = globalThis.fetch
    const requests = []
    try {
      globalThis.fetch = async (input, init) => {
        requests.push({ input, init })
        return lightwalletdInfoResponse('main')
      }
      await expect(
        attestZcashLightwalletdEndpoint({
          network: 'mainnet',
          baseUrl: 'https://lightwalletd.example/'
        })
      ).resolves.toBeUndefined()
      await expect(
        attestZcashLightwalletdEndpoint({
          network: 'testnet',
          baseUrl: 'https://lightwalletd.example'
        })
      ).rejects.toThrow(/network does not match/)
      expect(requests[0].input).toBe(
        'https://lightwalletd.example/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo'
      )
      expect(requests[0].init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects non-gRPC-Web responses and unsafe endpoint URLs', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
      await expect(
        attestZcashLightwalletdEndpoint({
          network: 'mainnet',
          baseUrl: 'https://lightwalletd.example'
        })
      ).rejects.toThrow(/content type/)
      await expect(
        attestZcashLightwalletdEndpoint({
          network: 'mainnet',
          baseUrl: 'https://user:password@lightwalletd.example'
        })
      ).rejects.toThrow(/credential-free HTTPS/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
