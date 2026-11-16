import { test } from 'node:test'
import { expect } from '@playwright/test'

import { filterLocalGraphsForActiveBitcoinAddress } from '../../../../src/background/activity.ts'

const bitcoinChainId = 'bip122:000000000019d6689c085ae165831e93'
const ethereumChainId = 'eip155:1'
const activeAddress = 'bc1qactiveaddress'

function graph({ originChainId, senderChainId, sender, recipientChainId, recipient }) {
  return Object.freeze({
    root: Object.freeze({
      intent: Object.freeze({
        sender: Object.freeze({ chainId: senderChainId, address: sender }),
        recipient: Object.freeze({ chainId: recipientChainId, address: recipient })
      })
    }),
    segments: Object.freeze([
      Object.freeze({
        role: 'origin',
        target: Object.freeze({ kind: 'onchain', chainId: originChainId })
      }),
      Object.freeze({
        role: 'destination',
        target: Object.freeze({ kind: 'onchain', chainId: recipientChainId })
      })
    ])
  })
}

test('filters Bitcoin-origin graphs by the active address without hiding inbound Bitcoin swaps', () => {
  const activeBitcoinTransfer = graph({
    originChainId: bitcoinChainId,
    senderChainId: bitcoinChainId,
    sender: activeAddress,
    recipientChainId: bitcoinChainId,
    recipient: 'bc1qrecipient'
  })
  const inactiveBitcoinTransfer = graph({
    originChainId: bitcoinChainId,
    senderChainId: bitcoinChainId,
    sender: 'bc1qinactiveaddress',
    recipientChainId: bitcoinChainId,
    recipient: 'bc1qrecipient'
  })
  const inboundBitcoinSwap = graph({
    originChainId: ethereumChainId,
    senderChainId: ethereumChainId,
    sender: '0x1111111111111111111111111111111111111111',
    recipientChainId: bitcoinChainId,
    recipient: activeAddress
  })

  expect(
    filterLocalGraphsForActiveBitcoinAddress(
      [activeBitcoinTransfer, inactiveBitcoinTransfer, inboundBitcoinSwap],
      bitcoinChainId,
      new Set([activeAddress])
    )
  ).toEqual([activeBitcoinTransfer, inboundBitcoinSwap])
})
