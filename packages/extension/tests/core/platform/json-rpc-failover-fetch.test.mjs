import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createJsonRpcFailoverFetch } from '../../../src/infrastructure/chains/json-rpc-failover-fetch.ts'

const endpoints = [{ url: 'https://primary.example' }, { url: 'https://backup.example' }]
const request = method => ({
  method: 'POST',
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] })
})

test('uses an attested backup after an endpoint failure and keeps it active', async () => {
  const calls = []
  const attestations = []
  const rpcFetch = createJsonRpcFailoverFetch(
    endpoints,
    async url => {
      attestations.push(url)
    },
    async url => {
      calls.push(url)
      return url === endpoints[0].url
        ? new Response(null, { status: 503 })
        : Response.json({ jsonrpc: '2.0', id: 1, result: 42 })
    }
  )

  await expect(rpcFetch(endpoints[0].url, request('getBalance'))).resolves.toHaveProperty(
    'status',
    200
  )
  await expect(rpcFetch(endpoints[0].url, request('getBalance'))).resolves.toHaveProperty(
    'status',
    200
  )
  expect(calls).toEqual([endpoints[0].url, endpoints[1].url, endpoints[1].url])
  expect(attestations).toEqual([endpoints[0].url, endpoints[1].url])
})

test('moves past a 200 rate-limit response and a malformed response', async () => {
  const calls = []
  const rpcFetch = createJsonRpcFailoverFetch(
    endpoints,
    async () => {},
    async url => {
      calls.push(url)
      return url === endpoints[0].url
        ? Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit' } })
        : Response.json({ jsonrpc: '2.0', id: 1, result: null })
    }
  )

  await expect(rpcFetch(endpoints[0].url, request('getBalance'))).resolves.toHaveProperty(
    'status',
    200
  )
  expect(calls).toEqual([endpoints[0].url, endpoints[1].url])

  const malformed = createJsonRpcFailoverFetch(
    endpoints,
    async () => {},
    async url =>
      url === endpoints[0].url
        ? new Response('<html>')
        : Response.json({ jsonrpc: '2.0', id: 1, result: 42 })
  )
  await expect(malformed(endpoints[0].url, request('getBalance'))).resolves.toHaveProperty(
    'status',
    200
  )
})

test('skips a wrong-chain node before broadcasting but never retries a submitted broadcast', async () => {
  const calls = []
  const rpcFetch = createJsonRpcFailoverFetch(
    endpoints,
    async url => {
      if (url === endpoints[0].url) throw new Error('wrong chain')
    },
    async url => {
      calls.push(url)
      throw new Error('connection lost')
    }
  )

  await expect(rpcFetch(endpoints[0].url, request('sendTransaction'))).rejects.toThrow(
    'connection lost'
  )
  expect(calls).toEqual([endpoints[1].url])
})
