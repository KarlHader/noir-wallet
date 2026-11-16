import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getCrossChainSendTokenGroup,
  isCrossChainSendDestination
} from '../../../src/popup/services/cross-chain-send-assets.ts'

const ethereumUsdc = {
  assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  blockchain: 'eth',
  contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  symbol: 'USDC',
  rheaChainId: '1',
  rheaAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  isNative: false
}
const polygonUsdc = {
  ...ethereumUsdc,
  assetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
  blockchain: 'polygon',
  contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  rheaChainId: '137',
  rheaAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
}

describe('Cross-chain Send USDC identity', () => {
  it('matches known EVM contracts while keeping quote and asset identifiers distinct', () => {
    const capabilities = { evm: true, solana: false }
    assert.equal(getCrossChainSendTokenGroup(ethereumUsdc), 'USDC')
    assert.equal(isCrossChainSendDestination(ethereumUsdc, polygonUsdc, capabilities), true)
    assert.equal(
      getCrossChainSendTokenGroup({
        ...ethereumUsdc,
        rheaAddress: ethereumUsdc.assetId
      }),
      'USDC'
    )
    assert.equal(
      getCrossChainSendTokenGroup({
        ...ethereumUsdc,
        contractAddress: '0x1111111111111111111111111111111111111111'
      }),
      null
    )
    assert.equal(
      getCrossChainSendTokenGroup({
        ...ethereumUsdc,
        contractAddress: null,
        rheaAddress: ethereumUsdc.assetId
      }),
      null
    )
    assert.equal(
      getCrossChainSendTokenGroup({
        ...ethereumUsdc,
        contractAddress: null
      }),
      'USDC'
    )
  })
})
