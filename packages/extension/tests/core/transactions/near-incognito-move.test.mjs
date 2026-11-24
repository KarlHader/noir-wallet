import { test } from 'node:test'
import { expect } from '@playwright/test'

import { nearPeaRequestJson } from '../../../src/infrastructure/keyring/multichain/raw-wallet-engine.ts'
import { assertNearPrivateQuoteRoute } from '../../../src/core/services/rhea-swap/rhea-swap-near-private-route.ts'
import {
  isNearWrappedProtocolAsset,
  NEAR_MAINNET_NATIVE_ASSET_ID,
  NEAR_MAINNET_WRAPPED_ASSET_ID,
  NEAR_WRAPPED_PROTOCOL_ASSET_ID
} from '../../../src/core/chains/near/near-portfolio-assets.ts'
import {
  acceptNearDirectDeposit,
  getNearMoveChainIds,
  nearDirectCatalogToken,
  nearDirectQuoteAsset,
  nearIncognitoMoveExposed,
  nearIncognitoPeaRequestJson,
  nearWrappedClusterAsset,
  planNearIncognitoCluster,
  resolveNearIncognitoMove,
  selectBalanceTransferMethod,
  NEAR_MOVE_DEPOSIT_ADDRESS,
  NEAR_MOVE_MEMO,
  NEAR_MOVE_NO_PEA
} from '../../../src/core/chains/near/near-incognito-move.ts'

const MAIN = 'alice.near'
const PEA = 'ab'.repeat(32)
const EVM = '0x1111111111111111111111111111111111111111'

function account(pea = PEA) {
  return {
    walletSource: { kind: 'software' },
    accountIndex: 0,
    networks: [
      {
        chain: { family: 'near', id: 'near:mainnet' },
        addresses: [{ value: MAIN, preferredForReceive: true }],
        privateExecutionAddress: pea
      }
    ]
  }
}

function clusterInput(overrides = {}) {
  return {
    network: 'mainnet',
    enabledFlags: ['chain.near'],
    from: 'public',
    to: 'private',
    mainAccountId: MAIN,
    peaAccountId: PEA,
    accountIndex: 0,
    walletSource: { kind: 'software' },
    originAsset: 'nep141:wrap.near',
    destinationAsset: 'nep141:wrap.near',
    amountRaw: '1000',
    slippageBps: 50,
    implicitAccountOnChain: false,
    confidentialPrincipal: EVM,
    ...overrides
  }
}

test('mainnet cluster does not build a Main-to-PEA transfer', () => {
  const plan = planNearIncognitoCluster(clusterInput())
  expect(plan.ok).toBe(true)
  if (!plan.ok) return
  expect(plan.method).toBe('cluster')
  expect(plan.fundingTransfers).toEqual([])
  expect(plan.implicitAccountOnChain).toBeUndefined()
  expect(plan.signerChainFamily).toBe('evm')
  expect(plan.intentStandard).toBe('erc191')
  expect(plan.signerId).toBe(EVM)
  expect(plan.deposit.signerId).toBe(EVM)
  expect(plan.deposit.recipient).toBe(EVM)
  expect(plan.deposit.refundTo).toBe(MAIN)
  expect(plan.deposit.recipientType).toBe('CONFIDENTIAL_INTENTS')
  expect(plan.withdraw.recipient).toBe(PEA)
  expect(plan.withdraw.signerId).toBe(EVM)
  expect(JSON.stringify(plan)).not.toMatch(/receiverId|storage_deposit|signer_chain_family/)
  expect(plan.deposit.recipient).not.toBe(PEA)
})

test('a missing PEA stops and keeps the selected method', () => {
  for (const peaAccountId of [null, MAIN, 'ABC'.repeat(10)]) {
    const plan = planNearIncognitoCluster(
      clusterInput({ peaAccountId, from: 'private', to: 'public' })
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) continue
    expect(plan.error).toBe(NEAR_MOVE_NO_PEA)
    expect(plan.method).toBe('cluster')
    expect(plan.fundingTransfers).toEqual([])
  }
  const direct = resolveNearIncognitoMove({
    ...clusterInput({ peaAccountId: null }),
    method: 'directly'
  })
  expect(direct.ok).toBe(false)
  if (!direct.ok) {
    expect(direct.method).toBe('directly')
    expect(direct.error).toBe(NEAR_MOVE_NO_PEA)
  }
  expect(
    selectBalanceTransferMethod({
      family: 'near',
      method: 'cluster',
      clusterUnavailable: true,
      directUnavailable: false,
      clusterQuoted: false,
      directQuoted: true
    })
  ).toBe('cluster')
})

test('directly rejects a memo and a non-64-hex deposit address', () => {
  expect(acceptNearDirectDeposit({ depositAddress: PEA, memo: 'note' })).toEqual({
    ok: false,
    error: NEAR_MOVE_MEMO
  })
  expect(acceptNearDirectDeposit({ depositAddress: PEA, depositMemo: 'memo' }).ok).toBe(false)
  for (const depositAddress of [
    'ABCDEF',
    `0x${'ab'.repeat(20)}`,
    PEA.slice(0, 63),
    PEA.toUpperCase(),
    `${PEA}.near`
  ]) {
    expect(acceptNearDirectDeposit({ depositAddress })).toEqual({
      ok: false,
      error: NEAR_MOVE_DEPOSIT_ADDRESS
    })
  }
  expect(acceptNearDirectDeposit({ depositAddress: PEA })).toEqual({
    ok: true,
    depositAddress: PEA
  })
  let publicRouteCalled = false
  expect(() =>
    assertNearPrivateQuoteRoute(
      {
        fromChain: 'near',
        toChain: 'near',
        tokenIn: { address: 'wrap.near' },
        tokenOut: { address: 'near' },
        sender: MAIN,
        recipient: PEA,
        confidentiality: 'basic'
      },
      {
        walletId: 'wallet',
        accountId: 'account',
        accountIndex: 0,
        walletSource: { kind: 'software' },
        networks: [
          {
            chainId: 'near:mainnet',
            privateExecutionAddress: PEA,
            addresses: [{ value: MAIN }]
          }
        ]
      },
      'confidential-funding',
      { walletId: 'wallet', accountId: 'account' },
      () => {
        publicRouteCalled = true
      }
    )
  ).not.toThrow()
  expect(publicRouteCalled).toBe(false)
})

test('public-private-move accepts a public NEAR sender and rejects the PEA', () => {
  const quoteAccount = {
    walletId: 'wallet',
    accountId: 'account',
    accountIndex: 0,
    walletSource: { kind: 'software' },
    networks: [
      {
        chainId: 'near:mainnet',
        privateExecutionAddress: PEA,
        addresses: [{ value: MAIN }]
      }
    ]
  }
  const scope = { walletId: 'wallet', accountId: 'account' }
  const request = (token, sender) => ({
    fromChain: 'near',
    toChain: 'near',
    tokenIn: { address: token },
    tokenOut: { address: token === 'near' ? 'wrap.near' : token },
    sender,
    recipient: PEA,
    confidentiality: 'basic'
  })
  let publicRouteCalled = false
  const rejectPublic = () => {
    publicRouteCalled = true
    throw new Error('public route')
  }
  for (const token of ['near', 'usdt.tether-token.near']) {
    expect(() =>
      assertNearPrivateQuoteRoute(
        request(token, MAIN),
        quoteAccount,
        'public-private-move',
        scope,
        rejectPublic
      )
    ).not.toThrow()
  }
  expect(publicRouteCalled).toBe(false)
  expect(() =>
    assertNearPrivateQuoteRoute(
      request('usdt.tether-token.near', PEA),
      quoteAccount,
      'public-private-move',
      scope,
      rejectPublic
    )
  ).toThrow('Private quote account changed. Get a new quote.')
  expect(publicRouteCalled).toBe(false)
})

test('flag-off and testnet expose no NEAR Move', () => {
  const funded = account()
  expect(nearIncognitoMoveExposed('mainnet', [])).toBe(false)
  expect(nearIncognitoMoveExposed('testnet', ['chain.near'])).toBe(false)
  expect(nearIncognitoMoveExposed('mainnet', ['chain.near'])).toBe(true)
  expect(getNearMoveChainIds({ account: funded, mainnet: true, enabledFlags: [] })).toEqual([])
  expect(
    getNearMoveChainIds({ account: funded, mainnet: false, enabledFlags: ['chain.near'] })
  ).toEqual([])
  expect(
    getNearMoveChainIds({ account: funded, mainnet: true, enabledFlags: ['chain.near'] })
  ).toEqual(['near:mainnet'])
  expect(
    getNearMoveChainIds({ account: null, mainnet: true, enabledFlags: ['chain.near'] })
  ).toEqual([])
})

test('EVM cluster selection is unchanged', () => {
  expect(
    selectBalanceTransferMethod({
      family: 'evm',
      method: 'cluster',
      clusterUnavailable: true,
      directUnavailable: false,
      clusterQuoted: false,
      directQuoted: true
    })
  ).toBe('directly')
  expect(
    selectBalanceTransferMethod({
      family: 'evm',
      method: 'directly',
      clusterUnavailable: false,
      directUnavailable: true,
      clusterQuoted: true,
      directQuoted: false
    })
  ).toBe('cluster')
  expect(
    selectBalanceTransferMethod({
      family: 'evm',
      method: 'cluster',
      clusterUnavailable: false,
      directUnavailable: false,
      clusterQuoted: true,
      directQuoted: true
    })
  ).toBe('cluster')
  expect(
    selectBalanceTransferMethod({
      family: 'near',
      method: 'directly',
      clusterUnavailable: false,
      directUnavailable: true,
      clusterQuoted: true,
      directQuoted: false
    })
  ).toBe('directly')
})

test('private NEAR source uses the v2 PEA request without an app or chain id', () => {
  const resolved = resolveNearIncognitoMove({
    ...clusterInput({ from: 'private', to: 'public', accountIndex: 0 }),
    method: 'directly'
  })
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) return
  expect(resolved.signingKind).toBe('pea-near-transaction')
  expect(resolved.peaRequestJson).toBe(nearPeaRequestJson(0))
  expect(resolved.peaRequestJson).toBe(nearIncognitoPeaRequestJson(0))
  expect(resolved.peaRequestJson).not.toContain('appId')
  expect(resolved.peaRequestJson).not.toContain('chainId')
  const imported = resolveNearIncognitoMove({
    ...clusterInput({
      from: 'private',
      to: 'public',
      accountIndex: 2,
      walletSource: { kind: 'private-key', chainFamily: 'near', accountIndex: 2 }
    }),
    method: 'directly'
  })
  expect(imported.ok).toBe(false)
  if (!imported.ok) expect(imported.method).toBe('directly')
})

test('direct quotes keep native NEAR and wNEAR distinct from other NEP-141 assets', () => {
  expect(
    nearDirectQuoteAsset({
      id: NEAR_MAINNET_NATIVE_ASSET_ID,
      chainId: 'near:mainnet',
      kind: 'native'
    })
  ).toEqual({
    protocolAssetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    address: 'wrap.near',
    native: true
  })
  expect(
    nearDirectQuoteAsset({
      id: NEAR_MAINNET_WRAPPED_ASSET_ID,
      chainId: 'near:mainnet',
      kind: 'token',
      reference: 'wrap.near'
    })
  ).toEqual({
    protocolAssetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    address: 'wrap.near',
    native: false
  })
  expect(
    nearDirectQuoteAsset({
      id: 'near:mainnet/nep141:other.near',
      chainId: 'near:mainnet',
      kind: 'token',
      reference: 'wrap.near'
    })
  ).toBeNull()
  expect(
    nearDirectQuoteAsset({
      id: 'near:mainnet/nep141:usdt.tether-token.near',
      chainId: 'near:mainnet',
      kind: 'token',
      reference: 'usdt.tether-token.near'
    })
  ).toEqual({
    protocolAssetId: 'nep141:usdt.tether-token.near',
    address: 'usdt.tether-token.near',
    native: false
  })
  expect(
    isNearWrappedProtocolAsset(NEAR_MAINNET_WRAPPED_ASSET_ID, NEAR_WRAPPED_PROTOCOL_ASSET_ID)
  ).toBe(true)
  expect(
    isNearWrappedProtocolAsset(NEAR_MAINNET_NATIVE_ASSET_ID, NEAR_WRAPPED_PROTOCOL_ASSET_ID)
  ).toBe(false)
})

test('direct catalog selection prefers the native flag that matches the quote', () => {
  const wrapped = {
    assetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    rheaAddress: 'wrap.near',
    rheaChainId: 'near',
    isNative: false,
    symbol: 'wNEAR'
  }
  const native = {
    assetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    rheaAddress: 'wrap.near',
    rheaChainId: 'near',
    isNative: true,
    symbol: 'NEAR'
  }
  const quote = nativeFlag => ({
    protocolAssetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    address: 'wrap.near',
    native: nativeFlag
  })
  expect(nearDirectCatalogToken([wrapped, native], quote(true))).toBe(native)
  expect(nearDirectCatalogToken([native, wrapped], quote(false))).toBe(wrapped)
  expect(nearDirectCatalogToken([wrapped], quote(true))).toBe(wrapped)
  const unlabeled = [
    { assetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID, rheaAddress: 'wrap.near', rheaChainId: 'near' },
    {
      assetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
      rheaAddress: 'wrap.near',
      rheaChainId: 'near',
      symbol: 'second'
    }
  ]
  expect(nearDirectCatalogToken(unlabeled, quote(false))).toBe(unlabeled[0])
})

test('cluster mapping accepts on-chain wNEAR and rejects native NEAR and USDT', () => {
  const tokens = [
    {
      assetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
      blockchain: 'near',
      decimals: 24,
      symbol: 'wNEAR'
    }
  ]
  expect(
    nearWrappedClusterAsset(
      { id: NEAR_MAINNET_WRAPPED_ASSET_ID, chainId: 'near:mainnet', decimals: 24 },
      tokens
    )
  ).toEqual({
    assetId: NEAR_MAINNET_WRAPPED_ASSET_ID,
    chainId: 'near:mainnet',
    protocolAssetId: NEAR_WRAPPED_PROTOCOL_ASSET_ID,
    blockchain: 'near'
  })
  expect(
    nearWrappedClusterAsset(
      { id: NEAR_MAINNET_NATIVE_ASSET_ID, chainId: 'near:mainnet', decimals: 24 },
      tokens
    )
  ).toBeNull()
  expect(
    nearWrappedClusterAsset(
      {
        id: 'near:mainnet/nep141:usdt.tether-token.near',
        chainId: 'near:mainnet',
        decimals: 6
      },
      tokens
    )
  ).toBeNull()
  expect(
    nearWrappedClusterAsset(
      { id: NEAR_MAINNET_WRAPPED_ASSET_ID, chainId: 'near:mainnet', decimals: 24 },
      [{ ...tokens[0], symbol: 'wNEAR (DEPRECATED)' }]
    )
  ).toBeNull()
})
