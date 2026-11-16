import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  Eip1193ProviderError,
  parseEip1193ChainRequest,
  parseEip1193Transfer,
  parseEthAccountsPermissionRequest,
  parsePersonalSignRequest,
  parseTypedDataV4Request,
  toEip1193ChainId
} from '../../../src/core/dapp/eip1193.ts'

const chain = {
  chainId: 'eip155:1',
  nativeAssetId: 'eip155:1/slip44:60',
  trustedErc20Contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  trustedErc20AssetId: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
}
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'

test.describe('EIP-1193 request policy', () => {
  test('canonicalizes configured chain IDs and restricts permissions to eth_accounts', () => {
    expect(toEip1193ChainId(1)).toBe('0x1')
    expect(parseEip1193ChainRequest([{ chainId: '0x1' }])).toEqual({
      chainId: '0x1',
      numericChainId: 1
    })
    expect(
      parseEip1193ChainRequest(
        [
          {
            chainId: '0x1',
            chainName: 'Ethereum',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://rpc.example'],
            blockExplorerUrls: ['https://explorer.example']
          }
        ],
        { allowAddChainMetadata: true }
      )
    ).toMatchObject({
      chainId: '0x1',
      numericChainId: 1,
      metadata: {
        chainName: 'Ethereum',
        rpcUrls: ['https://rpc.example/'],
        blockExplorerUrls: ['https://explorer.example/']
      }
    })
    expect(() =>
      parseEip1193ChainRequest([{ chainId: '0x1', unknown: true }], {
        allowAddChainMetadata: true
      })
    ).toThrow(/chain ID is invalid/)
    expect(
      parseEip1193ChainRequest(
        [
          {
            chainId: '0x539',
            chainName: 'Six Decimal Chain',
            nativeCurrency: { name: 'Six Coin', symbol: 'SIX', decimals: 6 },
            rpcUrls: ['http://localhost:8545']
          }
        ],
        { allowAddChainMetadata: true }
      ).metadata.nativeCurrency.decimals
    ).toBe(6)
    for (const decimals of [-1, 1.5, 256]) {
      expect(() =>
        parseEip1193ChainRequest(
          [
            {
              chainId: '0x539',
              chainName: 'Invalid Decimals',
              nativeCurrency: { name: 'Coin', symbol: 'COIN', decimals },
              rpcUrls: ['https://rpc.example']
            }
          ],
          { allowAddChainMetadata: true }
        )
      ).toThrow(/decimals/)
    }
    for (const rpcUrl of [
      'https://user:password@rpc.example',
      'https://rpc.example?apiKey=secret',
      'https://rpc.example/#fragment',
      'http://rpc.example'
    ]) {
      expect(() =>
        parseEip1193ChainRequest(
          [
            {
              chainId: '0x539',
              chainName: 'Unsafe RPC',
              nativeCurrency: { name: 'Coin', symbol: 'COIN', decimals: 18 },
              rpcUrls: [rpcUrl]
            }
          ],
          { allowAddChainMetadata: true }
        )
      ).toThrow(/HTTPS/)
    }
    expect(() => parseEthAccountsPermissionRequest([{ eth_accounts: {} }])).not.toThrow()
    expect(() =>
      parseEthAccountsPermissionRequest([{ eth_accounts: {}, snap_dialog: {} }])
    ).toThrow(/Only the eth_accounts/)
  })

  test('converts native and trusted ERC-20 transfers into bounded wallet intents', () => {
    expect(parseEip1193Transfer([{ from: sender, to: recipient, value: '0x2a' }], chain)).toEqual({
      from: sender,
      kind: 'native-transfer',
      intent: {
        assetId: chain.nativeAssetId,
        recipient,
        amountRaw: '42'
      }
    })

    const calldata = `0xa9059cbb${'0'.repeat(24)}${recipient.slice(2)}${'0'.repeat(63)}a`
    expect(
      parseEip1193Transfer(
        [{ from: sender, to: chain.trustedErc20Contract, value: '0x0', data: calldata }],
        chain
      )
    ).toEqual({
      from: sender,
      kind: 'erc20-transfer',
      tokenContract: chain.trustedErc20Contract.toLowerCase(),
      intent: {
        assetId: chain.trustedErc20AssetId,
        recipient,
        amountRaw: '10'
      }
    })
  })

  test('converts calldata transactions into chain-bound contract call intents', () => {
    expect(
      parseEip1193Transfer(
        [{ from: sender, to: recipient, value: '0x2a', data: '0xAABBCCDD' }],
        chain
      )
    ).toEqual({
      from: sender,
      kind: 'contract-call',
      intent: {
        chainId: chain.chainId,
        contractAddress: recipient,
        valueRaw: '42',
        calldata: '0xaabbccdd'
      }
    })
  })

  test('accepts validated dapp fee hints while keeping them out of wallet intents', () => {
    expect(
      parseEip1193Transfer(
        [
          {
            from: sender,
            to: recipient,
            value: '0x1',
            gas: '0x5208',
            gasPrice: '0x3b9aca00',
            maxFeePerGas: '0x77359400',
            maxPriorityFeePerGas: '0x3b9aca00',
            type: '0x2'
          }
        ],
        chain
      )
    ).toEqual({
      from: sender,
      kind: 'native-transfer',
      intent: {
        assetId: chain.nativeAssetId,
        recipient,
        amountRaw: '1'
      }
    })
    expect(() =>
      parseEip1193Transfer([{ from: sender, to: recipient, value: '0x1', gas: '21000' }], chain)
    ).toThrow(/gas limit/i)
  })

  test('classifies dynamic ERC-20 transfers and PEA-owned transferFrom calls', () => {
    const token = '0x3333333333333333333333333333333333333333'
    const transfer = `0xa9059cbb${'0'.repeat(24)}${recipient.slice(2)}${'0'.repeat(63)}1`
    expect(
      parseEip1193Transfer([{ from: sender, to: token, value: '0x0', data: transfer }], chain)
    ).toMatchObject({
      kind: 'erc20-transfer',
      tokenContract: token,
      intent: {
        assetId: `eip155:1/erc20:${token}`,
        recipient,
        amountRaw: '1'
      }
    })

    const transferFrom =
      `0x23b872dd${'0'.repeat(24)}${sender.slice(2)}` +
      `${'0'.repeat(24)}${recipient.slice(2)}${'0'.repeat(63)}2`
    expect(
      parseEip1193Transfer([{ from: sender, to: token, value: '0x0', data: transferFrom }], chain)
    ).toMatchObject({
      kind: 'erc20-transfer-from',
      tokenContract: token,
      transferFromOwner: sender,
      intent: { recipient, amountRaw: '2' }
    })

    const otherOwnerTransferFrom = transferFrom.replace(sender.slice(2), token.slice(2))
    expect(() =>
      parseEip1193Transfer(
        [{ from: sender, to: token, value: '0x0', data: otherOwnerTransferFrom }],
        chain
      )
    ).toThrow(/connected account/i)

    for (const malformed of [
      `${transfer}00`,
      transfer.slice(0, -2),
      `${transferFrom}00`,
      transferFrom.slice(0, -2)
    ]) {
      expect(() =>
        parseEip1193Transfer([{ from: sender, to: token, value: '0x0', data: malformed }], chain)
      ).toThrow(/calldata/i)
    }
  })

  test('rejects unsupported fields, contract creation, wrong chains, and zero transfers', () => {
    expect(() =>
      parseEip1193Transfer([{ from: sender, to: recipient, value: '0x1', nonce: '0x1' }], chain)
    ).toThrow(Eip1193ProviderError)
    expect(() => parseEip1193Transfer([{ from: sender, data: '0x1234' }], chain)).toThrow(
      /recipient/i
    )
    expect(() =>
      parseEip1193Transfer(
        [{ from: sender, to: recipient, value: '0x1', chainId: '0xaa36a7' }],
        chain
      )
    ).toThrow(/not active/)
    expect(() =>
      parseEip1193Transfer([{ from: sender, to: recipient, value: '0x0' }], chain)
    ).toThrow(/non-zero/)
  })

  test('decodes personal_sign display text while preserving the signed bytes', () => {
    const parsed = parsePersonalSignRequest(['0x48656c6c6f', sender])
    expect(parsed.address).toBe(sender)
    expect([...parsed.message]).toEqual([72, 101, 108, 108, 111])
    expect(parsed.displayMessage).toBe('Hello')
  })

  test('requires an EIP-712 domain bound to the active chain', () => {
    const typedData = JSON.stringify({
      types: {
        EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
        Message: [{ name: 'contents', type: 'string' }]
      },
      primaryType: 'Message',
      domain: { chainId: 1 },
      message: { contents: 'Noir Wallet' }
    })
    expect(parseTypedDataV4Request([sender, typedData], 1)).toMatchObject({
      address: sender,
      primaryType: 'Message'
    })
    expect(() =>
      parseTypedDataV4Request([sender, typedData.replace('"chainId":1', '"chainId":2')], 1)
    ).toThrow(/active chain/)
  })
})
