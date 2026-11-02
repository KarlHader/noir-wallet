import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEvmChainIconResolver } from '../../../../src/lib/chain-icon.ts'
import { resolveEvmChainIconAlias } from '../../../../src/config/icons.ts'

test('custom chain icons resolve by chain ID from one shared remote catalog', async () => {
  let calls = 0
  const resolve = createEvmChainIconResolver(async () => {
    calls++
    return Response.json([
      { chainId: 57073, name: 'Ink' },
      { chainId: '5000', name: 'Mantle' },
      { chainId: 9007199254740992, name: 'Invalid' },
      { chainId: 9001, name: '' },
      { chainId: 9002, name: '../../untrusted.example/image' },
      { chainId: { toString: 'invalid' }, name: 'Invalid' }
    ])
  })
  assert.equal(resolveEvmChainIconAlias('eip155:1'), 'eth')
  assert.equal(resolveEvmChainIconAlias('eip155:57073'), 'eip155:57073')
  assert.equal(resolveEvmChainIconAlias('eip155:5000'), 'eip155:5000')
  assert.equal(await resolve('eth'), undefined)
  assert.equal(calls, 0)
  assert.deepEqual(
    await Promise.all([resolve('eip155:57073'), resolve('eip155:5000'), resolve('eip155:31337')]),
    [
      'https://icons.llamao.fi/icons/chains/rsz_ink.jpg',
      'https://icons.llamao.fi/icons/chains/rsz_mantle.jpg',
      undefined
    ]
  )
  assert.equal(calls, 1)
  assert.equal(await resolve('eip155:9001'), undefined)
  assert.equal(new URL(await resolve('eip155:9002')).origin, 'https://icons.llamao.fi')
})

test('unavailable or malformed icon catalogs preserve the fallback and allow retry', async () => {
  const responses = [
    new Response('', { status: 503 }),
    Response.json({ name: 'Ink' }),
    Response.json([{ chainId: 57073, name: 'Ink' }])
  ]
  const resolve = createEvmChainIconResolver(async () => responses.shift())
  assert.equal(await resolve('eip155:57073'), undefined)
  assert.equal(await resolve('eip155:57073'), undefined)
  assert.equal(await resolve('eip155:57073'), 'https://icons.llamao.fi/icons/chains/rsz_ink.jpg')
})
