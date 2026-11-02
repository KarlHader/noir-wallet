import assert from 'node:assert/strict'
import test from 'node:test'
import { getActivityApprovalDetails } from '../../../src/popup/components/transaction/activity-interaction-adapters.ts'
import { getSwapTransactionReference } from '../../../src/popup/components/swap/swap-status-model.ts'

test('approval details match the token contract and network and preserve unknown methods', () => {
  const address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const item = {
    kind: 'approve',
    snapshot: {
      recipient: { chainId: 'eip155:1', address: address.toUpperCase().replace('0X', '0x') },
      evm: { methodSelector: '0x095ea7b3' }
    }
  }
  const asset = chainId => ({
    asset: { kind: 'token', chainId, namespace: 'erc20', reference: address },
    metadata: { symbol: chainId === 'eip155:1' ? 'USDC' : 'Wrong network' }
  })
  const assets = new Map([
    ['other-network', asset('eip155:42161')],
    ['matching', asset('eip155:1')]
  ])
  assert.deepEqual(getActivityApprovalDetails(item, assets), {
    tokenSymbol: 'USDC',
    methodLabel: 'Approve'
  })
  assert.equal(getActivityApprovalDetails({ ...item, kind: 'contract-call' }, assets), null)
  assert.deepEqual(
    getActivityApprovalDetails(item, new Map([['other-network', asset('eip155:42161')]])),
    {
      methodLabel: 'Approve'
    }
  )
  assert.deepEqual(
    getActivityApprovalDetails(
      {
        ...item,
        snapshot: { ...item.snapshot, evm: { methodSelector: '0x12345678' } }
      },
      new Map()
    ),
    {}
  )
})

test('RHEA protocol references use a known mainnet chain hint without overriding canonical networks', () => {
  const asset = 'rhea:56/rhea:nep245%3Av2%5F1.omni.hot.tg%3A56%5F12zbnsg6xndDVj25QyL82YMPudb'
  assert.deepEqual(getSwapTransactionReference(asset, 'bsc', '0x123', 'mainnet'), {
    label: 'BNB Chain',
    url: 'https://bscscan.com/tx/0x123'
  })
  for (const [chain, network] of [
    ['unknown-chain', 'mainnet'],
    ['bsc', 'testnet']
  ]) {
    assert.deepEqual(getSwapTransactionReference(asset, chain, '0x123', network), {
      label: 'rhea',
      url: ''
    })
  }
  assert.deepEqual(getSwapTransactionReference('nep141:eth.omft.near', 'bsc', '0x123', 'mainnet'), {
    label: 'Ethereum',
    url: 'https://etherscan.io/tx/0x123'
  })
  assert.deepEqual(getSwapTransactionReference('eip155:777/slip44:60', 'bsc', '0x123', 'mainnet'), {
    label: 'eip155',
    url: ''
  })
})
