import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getTokenIconCandidates } from '../../../src/popup/components/tokens/token-icon-candidates.ts'

const providerIcon = 'https://tokens.example/provider-eth.png'
const candidates = (assetId, blockchain = 'arb', contractAddress = null) =>
  getTokenIconCandidates({
    assetId,
    token: { blockchain, contractAddress, icon: providerIcon },
    icon: 'https://tokens.example/cached-eth.png'
  })

test('wallet and Swap ETH identities share the same icons across directions and networks', () => {
  const expected = candidates('eip155:1/slip44:60', 'eth')
  for (const assetId of [
    'eip155:42161/slip44:60',
    'eip155:8453/slip44:60',
    'eip155:11155111/slip44:60',
    'nep141:eth.omft.near',
    'nep141:arb.omft.near',
    'nep141:base.omft.near',
    'nep245:v2_1.omni.hot.tg:10_11111111111111111111'
  ]) {
    assert.deepEqual(candidates(assetId), expected, assetId)
  }
  assert.deepEqual(expected, [
    'https://assets-cdn.trustwallet.com/blockchains/ethereum/info/logo.png'
  ])
  assert.ok(!expected.includes(providerIcon))
  assert.deepEqual(
    getTokenIconCandidates({
      assetId: 'nep141:arb.omft.near',
      token: { blockchain: 'arb', contractAddress: null, icon: 'https://tokens.example/to.png' }
    }),
    expected
  )
})

test('native asset fallbacks never use chain badge artwork', () => {
  for (const blockchain of ['eth', 'arb', 'base', 'op', 'btc', 'sol', 'near']) {
    const icons = getTokenIconCandidates({ token: { blockchain, contractAddress: null } })
    assert.ok(icons.length > 0, blockchain)
    assert.ok(
      icons.every(icon => !icon.startsWith('https://assets.zknoir.com/chain/')),
      blockchain
    )
  }
})

test('does not give unrelated native coins or custom contracts the ETH identity', () => {
  for (const [assetId, chain, contract] of [
    ['eip155:196/slip44:60', 'xlayer', null],
    ['eip155:56/slip44:714', 'bsc', null],
    [
      'eip155:42161/erc20:0x3333333333333333333333333333333333333333',
      'arb',
      '0x3333333333333333333333333333333333333333'
    ],
    ['nep141:eth.bridge.near', 'near', 'eth.bridge.near'],
    ['nep141:fake-eth.omft.near', 'eth', null]
  ]) {
    assert.equal(candidates(assetId, chain, contract)[0], providerIcon, assetId)
  }
})
