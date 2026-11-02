import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  getContentScriptSenderOrigin,
  getOwnExtensionSenderContext,
  isOwnExtensionRouteSender,
  isOwnExtensionServiceWorkerSender,
  isTrustedExtensionSender,
  isTrustedRuntimeMessageSender,
  parseDAppApprovalResultMessage,
  parseDAppRuntimeRequestMessage,
  parseHardwareSignResultMessage,
  parseKeyringWorkerRpcRuntimeMessage,
  parseNoirRuntimeEventMessage,
  parseTrustedExtensionRuntimeMessage,
  parseWorkerRpcRuntimeMessage
} from '../../../src/lib/runtime-message-security.ts'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'

test.describe('Runtime message security', () => {
  test('keeps backup verification inside extension pages and bounds its word payload', () => {
    const verification = { wordIndices: [0, 11], words: ['abandon', 'about'] }
    const message = { type: 'CONFIRM_WALLET_BACKUP', walletId: 'wallet:1', verification }
    expect(parseTrustedExtensionRuntimeMessage(message)).toEqual(message)
    expect(
      isTrustedRuntimeMessageSender(
        message.type,
        { id: extensionId, url: `chrome-extension://${extensionId}/index.html` },
        extensionId
      )
    ).toBe(true)
    expect(
      isTrustedRuntimeMessageSender(
        message.type,
        { id: extensionId, url: 'https://dapp.example/' },
        extensionId
      )
    ).toBe(false)
    for (const invalid of [
      { ...verification, wordIndices: [0, 0] },
      { ...verification, wordIndices: [0, 24] },
      { ...verification, words: ['abandon'] },
      { ...verification, words: ['x'.repeat(65), 'about'] },
      { ...verification, walletId: 'wallet:other' }
    ]) {
      expect(() =>
        parseTrustedExtensionRuntimeMessage({ ...message, verification: invalid })
      ).toThrow()
    }
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ ...message, verification: undefined })
    ).toThrow()
  })

  test('accepts a scoped activity recheck while rejecting extra identity fields', () => {
    const message = {
      type: 'RECHECK_PENDING_TRANSACTIONS',
      accountKey: 'mainnet_wallet:1_account:1'
    }
    expect(parseTrustedExtensionRuntimeMessage(message)).toEqual(message)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ ...message, walletId: 'wallet:other' })
    ).toThrow()
  })

  test('bounds preparation trace IDs on extension-only runtime messages', () => {
    const feeRequest = {
      type: 'ESTIMATE_ZCASH_TRANSFER_FEE',
      to: 'u1test',
      amount: '0.1',
      marginalFeeZats: 5_000,
      fundingSource: 'shielded',
      debugRequestId: 'swap-prepare-1'
    }
    expect(parseTrustedExtensionRuntimeMessage(feeRequest)).toEqual(feeRequest)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ ...feeRequest, debugRequestId: 'x'.repeat(10_000) })
    ).toThrow()
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: {},
        debugRequestId: 'swap-prepare-1'
      })
    ).toMatchObject({ debugRequestId: 'swap-prepare-1' })
  })

  test('accepts bounded CAIP-25 requests and multichain session events', () => {
    const request = parseDAppRuntimeRequestMessage({
      type: 'DAPP_REQUEST',
      requestId: 'caip25-1',
      chainId: 'multichain',
      request: {
        method: 'wallet_createSession',
        params: {
          scopes: {
            'eip155:1': { methods: ['eth_accounts'], notifications: [] }
          }
        }
      }
    })
    expect(request.chainId).toBe('multichain')
    expect(request.request.method).toBe('wallet_createSession')

    expect(
      parseNoirRuntimeEventMessage({
        type: 'NOIR_EVENT',
        chainId: 'multichain',
        eventName: 'wallet_sessionChanged',
        data: { scopes: {} }
      })
    ).toMatchObject({ chainId: 'multichain', eventName: 'wallet_sessionChanged' })
  })

  test('validates account selections independently for every approved scope', () => {
    expect(
      parseDAppApprovalResultMessage(
        {
          type: 'DAPP_APPROVAL_RESULT',
          requestId: 'caip25-approval',
          success: true,
          selectedScopes: {
            'eip155:1': ['wallet-1'],
            'near:mainnet': ['wallet-1']
          }
        },
        'caip25-approval'
      ).selectedScopes
    ).toEqual({
      'eip155:1': ['wallet-1'],
      'near:mainnet': ['wallet-1']
    })
    expect(() =>
      parseDAppApprovalResultMessage(
        {
          type: 'DAPP_APPROVAL_RESULT',
          requestId: 'caip25-approval',
          success: false,
          selectedScopes: { 'eip155:1': ['wallet-1'] }
        },
        'caip25-approval'
      )
    ).toThrow(/Rejected approval/)
  })

  test('separates extension pages, service workers, and content scripts', () => {
    const popupSender = {
      id: extensionId,
      origin: `chrome-extension://${extensionId}`,
      url: `chrome-extension://${extensionId}/index.html#/approval?requestId=request-1`,
      tab: { id: 4, windowId: 8 }
    }
    const serviceWorkerSender = {
      id: extensionId,
      origin: `chrome-extension://${extensionId}`,
      url: `chrome-extension://${extensionId}/service-worker-loader.js`
    }
    const contentScriptSender = {
      id: extensionId,
      origin: 'https://wallet.example',
      url: 'https://wallet.example/app',
      documentUrl: 'https://wallet.example/app',
      frameId: 0,
      tab: { id: 4, url: 'https://wallet.example/app', windowId: 8 }
    }

    expect(isTrustedExtensionSender(popupSender, extensionId)).toBe(true)
    expect(isTrustedExtensionSender(contentScriptSender, extensionId)).toBe(false)
    expect(isOwnExtensionRouteSender(popupSender, extensionId, '/approval', { windowId: 8 })).toBe(
      true
    )
    expect(
      isOwnExtensionRouteSender(popupSender, extensionId, '/hardware/sign', { tabId: 4 })
    ).toBe(false)
    expect(
      isOwnExtensionServiceWorkerSender(
        serviceWorkerSender,
        extensionId,
        'service-worker-loader.js'
      )
    ).toBe(true)
    expect(
      isOwnExtensionServiceWorkerSender(popupSender, extensionId, 'service-worker-loader.js')
    ).toBe(false)
    expect(getOwnExtensionSenderContext(popupSender, extensionId)).toBe('extension-page')
    expect(getOwnExtensionSenderContext(serviceWorkerSender, extensionId)).toBe('service-worker')
    expect(
      isTrustedRuntimeMessageSender('PORTFOLIO_UPDATED', serviceWorkerSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('PORTFOLIO_UPDATED', popupSender, extensionId)).toBe(false)
    expect(isTrustedRuntimeMessageSender('WALLET_LOCKED', popupSender, extensionId)).toBe(true)
    expect(
      isTrustedRuntimeMessageSender('GET_BACKGROUND_INITIALIZATION_STATE', popupSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('GET_EVM_PORTFOLIO', popupSender, extensionId)).toBe(true)
    expect(isTrustedRuntimeMessageSender('GET_EVM_TOKEN_ALLOWANCE', popupSender, extensionId)).toBe(
      true
    )
    expect(
      isTrustedRuntimeMessageSender('GET_EVM_TOKEN_ALLOWANCE', contentScriptSender, extensionId)
    ).toBe(false)
    expect(isTrustedRuntimeMessageSender('GET_PORTFOLIO', popupSender, extensionId)).toBe(true)
    expect(isTrustedRuntimeMessageSender('GET_ACTIVITY', popupSender, extensionId)).toBe(true)
    expect(isTrustedRuntimeMessageSender('GET_BITCOIN_ACTIVITY', popupSender, extensionId)).toBe(
      true
    )
    expect(
      isTrustedRuntimeMessageSender('GET_BITCOIN_WALLET_IDENTITY', popupSender, extensionId)
    ).toBe(true)
    expect(
      isTrustedRuntimeMessageSender('GET_ZCASH_LENDING_PUBLIC_KEY', popupSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('ADD_SOFTWARE_WALLET', popupSender, extensionId)).toBe(
      true
    )
    expect(isTrustedRuntimeMessageSender('RESYNC_ZCASH_WALLET', popupSender, extensionId)).toBe(
      true
    )
    expect(
      isTrustedRuntimeMessageSender('GET_ADDITIONAL_RECEIVE_TARGETS', popupSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('GET_ACCOUNT_NETWORKS', popupSender, extensionId)).toBe(
      true
    )
    expect(
      isTrustedRuntimeMessageSender('GET_BITCOIN_ADDRESS_BALANCES', popupSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('GET_NETWORK_MODE', popupSender, extensionId)).toBe(true)
    expect(isTrustedRuntimeMessageSender('SWITCH_NETWORK_MODE', popupSender, extensionId)).toBe(
      true
    )
    expect(isTrustedRuntimeMessageSender('PREPARE_EVM_TRANSFER', popupSender, extensionId)).toBe(
      true
    )
    expect(isTrustedRuntimeMessageSender('PREPARE_SOLANA_TRANSFER', popupSender, extensionId)).toBe(
      true
    )
    expect(isTrustedRuntimeMessageSender('PREPARE_NEAR_TRANSFER', popupSender, extensionId)).toBe(
      true
    )
    expect(
      isTrustedRuntimeMessageSender('PREPARE_BITCOIN_TRANSFER', popupSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('QUOTE_RHEA_SWAP', popupSender, extensionId)).toBe(true)
    expect(
      isTrustedRuntimeMessageSender('PREPARE_RHEA_SWAP_EVM_SIGNATURE', popupSender, extensionId)
    ).toBe(true)
    expect(
      isTrustedRuntimeMessageSender('GET_RHEA_SWAP_EVM_SIGNATURE_PLAN', popupSender, extensionId)
    ).toBe(true)
    expect(
      isTrustedRuntimeMessageSender('PREPARE_RHEA_SWAP_SOLANA', popupSender, extensionId)
    ).toBe(true)
    expect(
      isTrustedRuntimeMessageSender('CONFIRM_RHEA_SWAP_SOLANA', popupSender, extensionId)
    ).toBe(true)
    expect(isTrustedRuntimeMessageSender('PREPARE_RHEA_SWAP_NEAR', popupSender, extensionId)).toBe(
      true
    )
    expect(isTrustedRuntimeMessageSender('CONFIRM_RHEA_SWAP_NEAR', popupSender, extensionId)).toBe(
      true
    )
    expect(
      isTrustedRuntimeMessageSender(
        'GET_BACKGROUND_INITIALIZATION_STATE',
        contentScriptSender,
        extensionId
      )
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('GET_EVM_PORTFOLIO', contentScriptSender, extensionId)
    ).toBe(false)
    expect(isTrustedRuntimeMessageSender('GET_PORTFOLIO', contentScriptSender, extensionId)).toBe(
      false
    )
    expect(
      isTrustedRuntimeMessageSender('PREPARE_NEAR_TRANSFER', contentScriptSender, extensionId)
    ).toBe(false)
    expect(isTrustedRuntimeMessageSender('GET_ACTIVITY', contentScriptSender, extensionId)).toBe(
      false
    )
    expect(
      isTrustedRuntimeMessageSender('GET_BITCOIN_ACTIVITY', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('GET_BITCOIN_WALLET_IDENTITY', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender(
        'GET_ZCASH_LENDING_PUBLIC_KEY',
        contentScriptSender,
        extensionId
      )
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('ADD_SOFTWARE_WALLET', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('RESYNC_ZCASH_WALLET', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender(
        'GET_ADDITIONAL_RECEIVE_TARGETS',
        contentScriptSender,
        extensionId
      )
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('GET_ACCOUNT_NETWORKS', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender(
        'GET_BITCOIN_ADDRESS_BALANCES',
        contentScriptSender,
        extensionId
      )
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('SWITCH_NETWORK_MODE', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('APPROVE_EVM_TRANSFER', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('APPROVE_BITCOIN_TRANSFER', contentScriptSender, extensionId)
    ).toBe(false)
    expect(isTrustedRuntimeMessageSender('QUOTE_RHEA_SWAP', contentScriptSender, extensionId)).toBe(
      false
    )
    expect(
      isTrustedRuntimeMessageSender(
        'CONFIRM_RHEA_SWAP_EVM_SIGNATURE',
        contentScriptSender,
        extensionId
      )
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('CONFIRM_RHEA_SWAP_SOLANA', contentScriptSender, extensionId)
    ).toBe(false)
    expect(
      isTrustedRuntimeMessageSender('CONFIRM_RHEA_SWAP_NEAR', contentScriptSender, extensionId)
    ).toBe(false)
    expect(isTrustedRuntimeMessageSender('FORWARD_WALLET_LOG', popupSender, extensionId)).toBe(
      false
    )
  })

  test('derives dApp origin only from a consistent top-level HTTP sender', () => {
    const sender = {
      id: extensionId,
      origin: 'https://wallet.example',
      url: 'https://wallet.example/app',
      documentUrl: 'https://wallet.example/app',
      frameId: 0,
      tab: { id: 4, url: 'https://wallet.example/app' }
    }

    expect(getContentScriptSenderOrigin(sender, extensionId)).toBe('https://wallet.example')
    expect(
      getContentScriptSenderOrigin(
        { ...sender, tab: { id: 4, url: 'https://forged.example/app' } },
        extensionId
      )
    ).toBeNull()
    expect(getContentScriptSenderOrigin({ ...sender, frameId: 1 }, extensionId)).toBeNull()
    expect(getContentScriptSenderOrigin({ ...sender, origin: 'null' }, extensionId)).toBeNull()
  })

  test('accepts only the exact dApp request envelope and bounded params', () => {
    const parsed = parseDAppRuntimeRequestMessage({
      type: 'DAPP_REQUEST',
      requestId: 'request-1',
      chainId: 'zcash',
      siteMetadata: { faviconUrl: 'https://wallet.example/favicon.ico' },
      request: {
        method: 'zcash_getBalance',
        params: [{ address: 'u1example' }]
      }
    })

    expect(parsed.request.method).toBe('zcash_getBalance')
    expect(parsed.request.params).toEqual([{ address: 'u1example' }])
    expect(parsed.siteMetadata).toEqual({
      faviconUrl: 'https://wallet.example/favicon.ico'
    })
    expect(
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-2',
        chainId: 'evm',
        request: { method: 'eth_accounts' }
      })
    ).toMatchObject({ chainId: 'evm', request: { method: 'eth_accounts' } })
    expect(
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-2b',
        chainId: 'evm',
        request: {
          method: 'eth_call',
          params: { to: '0x1111111111111111111111111111111111111111', data: '0x' }
        }
      })
    ).toMatchObject({ chainId: 'evm', request: { method: 'eth_call', params: { data: '0x' } } })
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-2c',
        chainId: 'bitcoin',
        request: { method: 'getBalance', params: {} }
      })
    ).toThrow(/params/i)
    expect(
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-3',
        chainId: 'bitcoin',
        request: { method: 'signMessage', params: ['hello', 'bip322-simple'] }
      })
    ).toMatchObject({ chainId: 'bitcoin', request: { method: 'signMessage' } })
    expect(
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-4',
        chainId: 'solana',
        request: { method: 'signMessage', params: ['aGVsbG8='] }
      })
    ).toMatchObject({ chainId: 'solana', request: { method: 'signMessage' } })
    expect(
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-4b',
        chainId: 'solana',
        request: { method: 'signAndSendTransaction', params: ['AQ=='] }
      })
    ).toMatchObject({ chainId: 'solana', request: { method: 'signAndSendTransaction' } })
    expect(
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-5',
        chainId: 'near',
        request: { method: 'signTransaction', params: [{ receiverId: 'app.near', actions: [] }] }
      })
    ).toMatchObject({ chainId: 'near', request: { method: 'signTransaction' } })
    for (const [chainId, method] of [
      ['solana', 'getBalance'],
      ['solana', 'sendTransfer'],
      ['near', 'getBalance'],
      ['near', 'sendTransfer']
    ]) {
      expect(() =>
        parseDAppRuntimeRequestMessage({
          type: 'DAPP_REQUEST',
          requestId: `removed-${chainId}-${method}`,
          chainId,
          request: { method }
        })
      ).toThrow(/method/i)
    }
    expect(() =>
      parseDAppRuntimeRequestMessage({
        ...parsed,
        origin: 'https://forged.example'
      })
    ).toThrow(/invalid/i)
    expect(() =>
      parseDAppRuntimeRequestMessage({
        ...parsed,
        siteMetadata: { faviconUrl: 'javascript:alert(1)' }
      })
    ).toThrow(/favicon/i)
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'zcash',
        request: { method: 'zcash_exportPrivateKey' }
      })
    ).toThrow(/method/i)
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'zcash',
        request: { method: 'eth_accounts' }
      })
    ).toThrow(/provider/i)
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'bitcoin',
        request: { method: 'signAllTransactions', params: [['AQ==']] }
      })
    ).toThrow(/provider/i)
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'bitcoin',
        request: { method: 'eth_accounts' }
      })
    ).toThrow(/provider/i)
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'evm',
        request: { method: 'zcash_getAccounts' }
      })
    ).toThrow(/provider/i)

    let nested = {}
    for (let depth = 0; depth < 20; depth += 1) nested = { nested }
    expect(() =>
      parseDAppRuntimeRequestMessage({
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'zcash',
        request: { method: 'zcash_getBalance', params: [nested] }
      })
    ).toThrow(/limits/i)
  })

  test('keeps the public and Background-to-Offscreen Worker routes distinct', () => {
    const publicMessage = {
      type: 'WORKER_RPC',
      method: 'wallet.getBalance',
      payload: { walletId: 'wallet-1' }
    }
    const internalMessage = {
      ...publicMessage,
      type: 'KEYRING_WORKER_RPC'
    }

    expect(parseWorkerRpcRuntimeMessage(publicMessage).type).toBe('WORKER_RPC')
    expect(parseKeyringWorkerRpcRuntimeMessage(internalMessage).type).toBe('KEYRING_WORKER_RPC')
    expect(() => parseWorkerRpcRuntimeMessage(internalMessage)).toThrow(/invalid/i)
    expect(() => parseKeyringWorkerRpcRuntimeMessage(publicMessage)).toThrow(/invalid/i)
    expect(() =>
      parseWorkerRpcRuntimeMessage({
        ...publicMessage,
        payload: { walletId: 'wallet-1', invalid: Number.POSITIVE_INFINITY }
      })
    ).toThrow(/non-finite/i)
  })

  test('validates each trusted Background message against its declared outer schema', () => {
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST',
        transactionId: 'transaction:evm:1'
      })
    ).toEqual({
      type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST',
      transactionId: 'transaction:evm:1'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_KEYSTONE_EVM_SIGNATURE',
        transactionId: 'transaction:evm:1',
        payloadFingerprint: 'a'.repeat(64),
        signatureCborBase64: 'oQEC'
      })
    ).toMatchObject({ type: 'SUBMIT_KEYSTONE_EVM_SIGNATURE' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_KEYSTONE_EVM_SIGNATURE',
        transactionId: 'transaction:evm:1',
        payloadFingerprint: 'a'.repeat(64),
        signatureCborBase64: 'not-base64'
      })
    ).toThrow()
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'UPDATE_TRANSACTION',
        accountKey: 'mainnet_wallet-1_account-1',
        transactionId: 'transaction-1',
        updates: { status: 'pending' }
      })
    ).toMatchObject({ type: 'UPDATE_TRANSACTION', transactionId: 'transaction-1' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'UPDATE_TRANSACTION',
        accountKey: 'mainnet_wallet-1_account-1',
        transactionId: 'transaction-1',
        updates: { status: 'pending' },
        unexpected: true
      })
    ).toThrow(/schema/i)
    const solanaTransferIntent = {
      assetId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/slip44:501',
      recipient: 'SysvarRent111111111111111111111111111111111',
      amountRaw: '5000'
    }
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_SOLANA_TRANSFER',
        intent: solanaTransferIntent
      })
    ).toEqual({ type: 'PREPARE_SOLANA_TRANSFER', intent: solanaTransferIntent })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'APPROVE_SOLANA_TRANSFER',
        transactionId: 'transaction:solana:1',
        payloadFingerprint: 'a'.repeat(64)
      })
    ).toMatchObject({ type: 'APPROVE_SOLANA_TRANSFER' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_SOLANA_TRANSFER',
        intent: solanaTransferIntent,
        accountIndex: 99
      })
    ).toThrow(/schema/i)
    const nearTransferIntent = {
      assetId: 'near:testnet/slip44:397',
      recipient: 'alice.testnet',
      amountRaw: '1000000000000000000000'
    }
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_NEAR_TRANSFER',
        intent: nearTransferIntent
      })
    ).toEqual({ type: 'PREPARE_NEAR_TRANSFER', intent: nearTransferIntent })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'APPROVE_NEAR_TRANSFER',
        transactionId: 'transaction:near:1',
        payloadFingerprint: 'b'.repeat(64)
      })
    ).toMatchObject({ type: 'APPROVE_NEAR_TRANSFER' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_NEAR_TRANSFER',
        intent: nearTransferIntent,
        accountIndex: 99
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SWITCH_NETWORK_MODE',
        networkMode: 'testnet'
      })
    ).toEqual({ type: 'SWITCH_NETWORK_MODE', networkMode: 'testnet' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_EXTENSION_DISPLAY_MODE',
        sidePanelMode: true
      })
    ).toEqual({ type: 'SET_EXTENSION_DISPLAY_MODE', sidePanelMode: true })
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_EXTENSION_DISPLAY_MODE' })).toEqual({
      type: 'GET_EXTENSION_DISPLAY_MODE'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_EXTENSION_DISPLAY_MODE',
        sidePanelMode: 'side-panel'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SWITCH_NETWORK_MODE',
        networkMode: 'preview'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ASSET_MARKET_HISTORY',
        assetId: 'eip155:1/slip44:60',
        range: '1m',
        action: 'refresh'
      })
    ).toEqual({
      type: 'GET_ASSET_MARKET_HISTORY',
      assetId: 'eip155:1/slip44:60',
      range: '1m',
      action: 'refresh'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ASSET_MARKET_HISTORY',
        assetId: 'eip155:1/slip44:60',
        range: '5y',
        action: 'refresh'
      })
    ).toThrow(/schema/i)
    const bitcoinIntent = {
      recipient: 'bc1qexample',
      amount: { mode: 'max' }
    }
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_BITCOIN_TRANSFER',
        intent: bitcoinIntent
      })
    ).toEqual({ type: 'PREPARE_BITCOIN_TRANSFER', intent: bitcoinIntent })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_PENDING_BITCOIN_TRANSFER',
        transactionId: 'transaction:bitcoin:1'
      })
    ).toEqual({
      type: 'GET_PENDING_BITCOIN_TRANSFER',
      transactionId: 'transaction:bitcoin:1'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'APPROVE_BITCOIN_TRANSFER',
        transactionId: 'transaction:bitcoin:1',
        payloadFingerprint: 'b'.repeat(64)
      })
    ).toMatchObject({
      type: 'APPROVE_BITCOIN_TRANSFER',
      transactionId: 'transaction:bitcoin:1'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST',
        transactionId: 'transaction:bitcoin:1'
      })
    ).toEqual({
      type: 'GET_KEYSTONE_BITCOIN_SIGNING_REQUEST',
      transactionId: 'transaction:bitcoin:1'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE',
        transactionId: 'transaction:bitcoin:1',
        payloadFingerprint: 'b'.repeat(64),
        signedPsbtBase64: 'cHNidP8BAAoAAAAA'
      })
    ).toMatchObject({ type: 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_KEYSTONE_BITCOIN_SIGNATURE',
        transactionId: 'transaction:bitcoin:1',
        payloadFingerprint: 'b'.repeat(64),
        signedPsbtBase64: 'not-base64',
        unsignedPsbtBase64: 'must-not-cross'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'REJECT_BITCOIN_TRANSFER',
        transactionId: 'transaction:bitcoin:1'
      })
    ).toEqual({
      type: 'REJECT_BITCOIN_TRANSFER',
      transactionId: 'transaction:bitcoin:1'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'RESUME_BITCOIN_TRANSFER',
        transactionId: 'transaction:bitcoin:1'
      })
    ).toEqual({
      type: 'RESUME_BITCOIN_TRANSFER',
      transactionId: 'transaction:bitcoin:1'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_BITCOIN_TRANSFER',
        intent: bitcoinIntent,
        addressType: 'p2tr'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'UNKNOWN_PRIVILEGED_OPERATION'
      })
    ).toThrow(/unsupported/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'BACKGROUND_ZCASH_TX',
        action: 'send',
        walletId: 'wallet-1',
        accountId: 'account-1',
        accountKey: 'mainnet_wallet-1_account-1',
        transactionId: 'transaction-1',
        sendParams: { amount: Number.NaN }
      })
    ).toThrow(/non-finite/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'HW_PCZT_BUILD',
        requestId: 'hardware-request-1',
        walletId: 'wallet-1',
        accountId: 'account-1',
        kind: 'send',
        to: 'u1recipient',
        amount: '1',
        maxTransfer: true
      })
    ).toMatchObject({ type: 'HW_PCZT_BUILD', requestId: 'hardware-request-1', maxTransfer: true })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'HW_PCZT_BUILD',
        requestId: 'hardware-request-1',
        walletId: 'wallet-1',
        accountId: 'account-1',
        kind: 'send',
        amount: '1',
        maxTransfer: 'true'
      })
    ).toThrow()
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'HW_PCZT_BUILD',
        walletId: 'wallet-1',
        accountId: 'account-1',
        kind: 'send'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_HARDWARE_PCZT',
        requestId: 'hardware-request-1',
        signedPcztBase64: 'ZWZnaA=='
      })
    ).toMatchObject({ type: 'SUBMIT_HARDWARE_PCZT' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_LEDGER_SIGNATURES',
        requestId: 'hardware-request-1',
        signatures: { orchard: [], transparentInputSigs: [], ironwood: [] }
      })
    ).toMatchObject({ type: 'SUBMIT_LEDGER_SIGNATURES' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_HARDWARE_PCZT',
        requestId: 'hardware-request-1',
        signedPcztBase64: 'not base64'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_HARDWARE_PCZT',
        requestId: 'hardware-request-1',
        origin: 'https://dapp.example',
        signedPcztBase64: 'ZWZnaA=='
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'INSPECT_NEXT_ZCASH_ACCOUNT_HISTORY',
        walletId: 'wallet-1'
      })
    ).toMatchObject({
      type: 'INSPECT_NEXT_ZCASH_ACCOUNT_HISTORY',
      walletId: 'wallet-1'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'ADD_ACCOUNT',
        walletId: 'wallet-1',
        accountName: 'Savings',
        birthdayHeight: 2_000_000,
        expectedDerivationIndex: 1
      })
    ).toMatchObject({
      type: 'ADD_ACCOUNT',
      walletId: 'wallet-1',
      accountName: 'Savings',
      birthdayHeight: 2_000_000,
      expectedDerivationIndex: 1
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'ADD_ACCOUNT',
        walletId: 'wallet-1',
        birthdayHeight: 0
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'ADD_ACCOUNT',
        accountName: 'Savings'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SWITCH_ACCOUNT',
        walletId: 'wallet-1',
        accountId: 'account-2'
      })
    ).toMatchObject({
      type: 'SWITCH_ACCOUNT',
      walletId: 'wallet-1',
      accountId: 'account-2'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SWITCH_ACCOUNT',
        walletId: 'wallet-1'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'WALLET_CREATED',
        password: 'legacy-compatible-password'
      })
    ).toMatchObject({ type: 'WALLET_CREATED' })
    expect(() => parseTrustedExtensionRuntimeMessage({ type: 'WALLET_CREATED' })).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GENERATE_ADD_WALLET_MNEMONIC',
        wordCount: 24
      })
    ).toEqual({ type: 'GENERATE_ADD_WALLET_MNEMONIC', wordCount: 24 })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GENERATE_ADD_WALLET_MNEMONIC',
        wordCount: 15
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PROVISION_PRIMARY_SOFTWARE_WALLET',
        mnemonic: `${'abandon '.repeat(11)}about`,
        password: 'legacy-compatible-password',
        accountName: 'Primary Account'
      })
    ).toMatchObject({
      type: 'PROVISION_PRIMARY_SOFTWARE_WALLET',
      accountName: 'Primary Account'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'ADD_SOFTWARE_WALLET',
        mode: 'import',
        mnemonic: `${'abandon '.repeat(11)}about`,
        accountName: 'Imported Account',
        birthdayHeight: 3_000_000
      })
    ).toMatchObject({ type: 'ADD_SOFTWARE_WALLET', mode: 'import' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREVIEW_PRIVATE_KEY_WALLET',
        privateKey: `[${Array.from({ length: 64 }, (_, index) => index).join(',')}]`,
        chainFamily: 'solana'
      })
    ).toMatchObject({ type: 'PREVIEW_PRIVATE_KEY_WALLET', chainFamily: 'solana' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'IMPORT_PRIVATE_KEY_WALLET',
        privateKey: `ed25519:${'1'.repeat(44)}`,
        chainFamily: 'near',
        displayName: 'Imported NEAR Wallet'
      })
    ).toMatchObject({ type: 'IMPORT_PRIVATE_KEY_WALLET', chainFamily: 'near' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREVIEW_PRIVATE_KEY_WALLET',
        privateKey: '1'.repeat(513),
        chainFamily: 'solana'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'RESYNC_ZCASH_WALLET',
        walletId: 'wallet-1',
        accountId: 'account-1',
        birthdayHeight: 3_000_000
      })
    ).toEqual({
      type: 'RESYNC_ZCASH_WALLET',
      walletId: 'wallet-1',
      accountId: 'account-1',
      birthdayHeight: 3_000_000
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'RESYNC_ZCASH_WALLET',
        walletId: 'wallet-1',
        accountId: 'account-1',
        birthdayHeight: 0
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'ADD_SOFTWARE_WALLET',
        mode: 'restore',
        mnemonic: `${'abandon '.repeat(11)}about`,
        accountName: 'Imported Account'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'ADD_SOFTWARE_WALLET',
        mode: 'create',
        mnemonic: `${'abandon '.repeat(11)}about`,
        accountName: 'Created Account',
        password: 'must-not-cross-the-popup-boundary'
      })
    ).toThrow(/schema/i)
    expect(() => parseTrustedExtensionRuntimeMessage({ type: 'RECOVER_WALLET_SESSION' })).toThrow(
      /unsupported/i
    )
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_WALLET_SESSION_STATE' })).toMatchObject(
      { type: 'GET_WALLET_SESSION_STATE' }
    )
    expect(
      parseTrustedExtensionRuntimeMessage({ type: 'GET_BACKGROUND_INITIALIZATION_STATE' })
    ).toMatchObject({ type: 'GET_BACKGROUND_INITIALIZATION_STATE' })
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_ACTIVITY' })).toEqual({
      type: 'GET_ACTIVITY'
    })
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_ACTIVITY', action: 'read' })).toEqual({
      type: 'GET_ACTIVITY',
      action: 'read'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ACTIVITY',
        action: 'refresh',
        executionMode: 'private',
        chainIds: ['eip155:1']
      })
    ).toEqual({
      type: 'GET_ACTIVITY',
      action: 'refresh',
      executionMode: 'private',
      chainIds: ['eip155:1']
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'RECHECK_FAST_PENDING_TRANSACTIONS',
        family: 'evm'
      })
    ).toEqual({ type: 'RECHECK_FAST_PENDING_TRANSACTIONS', family: 'evm' })
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_BITCOIN_ACTIVITY' })).toEqual({
      type: 'GET_BITCOIN_ACTIVITY'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({ type: 'GET_BITCOIN_ACTIVITY', action: 'refresh' })
    ).toEqual({ type: 'GET_BITCOIN_ACTIVITY', action: 'refresh' })
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_BITCOIN_WALLET_IDENTITY' })).toEqual({
      type: 'GET_BITCOIN_WALLET_IDENTITY'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ZCASH_LENDING_PUBLIC_KEY',
        walletId: 'wallet-1',
        accountId: 'account-1',
        signingMode: 'derived'
      })
    ).toEqual({
      type: 'GET_ZCASH_LENDING_PUBLIC_KEY',
      walletId: 'wallet-1',
      accountId: 'account-1',
      signingMode: 'derived'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ZCASH_LENDING_PUBLIC_KEY',
        walletId: 'wallet-1',
        accountId: 'account-1',
        signingMode: 'current'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'GET_ACTIVITY', accountId: 'account-1' })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'GET_ACTIVITY', action: 'cached' })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_BITCOIN_ACTIVITY',
        accountId: 'account-1'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ADDITIONAL_RECEIVE_TARGETS',
        walletId: 'wallet-1',
        accountId: 'account-1'
      })
    ).toEqual({
      type: 'GET_ADDITIONAL_RECEIVE_TARGETS',
      walletId: 'wallet-1',
      accountId: 'account-1'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ADDITIONAL_RECEIVE_TARGETS',
        walletId: 'wallet-1'
      })
    ).toThrow(/schema/i)
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_ACCOUNT_NETWORKS' })).toEqual({
      type: 'GET_ACCOUNT_NETWORKS'
    })
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_BITCOIN_ADDRESS_BALANCES' })).toEqual({
      type: 'GET_BITCOIN_ADDRESS_BALANCES'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential: { schemaVersion: 2 },
        displayName: 'Keystone',
        password: 'global-password',
        birthdayHeight: 2_000_000
      })
    ).toMatchObject({ type: 'PROVISION_KEYSTONE_HARDWARE', displayName: 'Keystone' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential: { schemaVersion: 2 },
        displayName: 'Keystone',
        password: 'global-password',
        firmwareProfile: 'forged'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_ACCOUNT_NETWORKS',
        walletId: 'wallet-1'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_BITCOIN_ADDRESS_BALANCES',
        accountId: 'account-1'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({ type: 'GET_EVM_PORTFOLIO', action: 'read' })
    ).toEqual({ type: 'GET_EVM_PORTFOLIO', action: 'read' })
    const allowanceRequest = {
      type: 'GET_EVM_TOKEN_ALLOWANCE',
      chainId: 'eip155:1',
      token: '0x1111111111111111111111111111111111111111',
      spender: '0x2222222222222222222222222222222222222222',
      expectedOwner: '0x3333333333333333333333333333333333333333',
      executionMode: 'private'
    }
    expect(parseTrustedExtensionRuntimeMessage(allowanceRequest)).toEqual(allowanceRequest)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ ...allowanceRequest, token: 'not-an-address' })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({ type: 'GET_PORTFOLIO', action: 'refresh' })
    ).toEqual({ type: 'GET_PORTFOLIO', action: 'refresh' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_PORTFOLIO',
        action: 'refresh',
        forceDiscovery: true
      })
    ).toEqual({ type: 'GET_PORTFOLIO', action: 'refresh', forceDiscovery: true })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_PORTFOLIO',
        action: 'refresh',
        chainIds: ['eip155:1', 'near:mainnet']
      })
    ).toEqual({
      type: 'GET_PORTFOLIO',
      action: 'refresh',
      chainIds: ['eip155:1', 'near:mainnet']
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_PORTFOLIO',
        action: 'refresh',
        chainIds: ['eip155:1', 'eip155:1']
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PORTFOLIO_UPDATED',
        walletId: 'wallet-1',
        accountId: 'account-1'
      })
    ).toEqual({ type: 'PORTFOLIO_UPDATED', walletId: 'wallet-1', accountId: 'account-1' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PORTFOLIO_UPDATED',
        walletId: 'wallet-1'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'GET_PORTFOLIO', action: 'write' })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'GET_EVM_PORTFOLIO', action: 'write' })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_EVM_PORTFOLIO',
        action: 'refresh',
        chainId: 'eip155:1'
      })
    ).toThrow(/schema/i)
    const transferIntent = {
      assetId: 'eip155:1/slip44:60',
      recipient: '0x2222222222222222222222222222222222222222',
      amountRaw: '1'
    }
    const nearIntentsBinding = {
      schemaVersion: 1,
      provider: 'near-intents',
      kind: 'swap'
    }
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        feeTier: 'fast',
        executionMode: 'private'
      })
    ).toEqual({
      type: 'PREPARE_EVM_TRANSFER',
      intent: transferIntent,
      feeTier: 'fast',
      executionMode: 'private'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        executionMode: 'scoped'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        feeTier: 'instant'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        feeSelection: { kind: 'custom', maxPriorityFeePerGasWei: '1500000000' }
      })
    ).toEqual({
      type: 'PREPARE_EVM_TRANSFER',
      intent: transferIntent,
      feeSelection: { kind: 'custom', maxPriorityFeePerGasWei: '1500000000' }
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        feeSelection: { kind: 'custom', maxPriorityFeePerGasWei: '0' }
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        feeSelection: { kind: 'tier', tier: 'fast', forged: true }
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        nearIntentsBinding
      })
    ).toEqual({ type: 'PREPARE_EVM_TRANSFER', intent: transferIntent, nearIntentsBinding })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        nearIntentsBinding: 'forged'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_PENDING_EVM_TRANSFER',
        transactionId: 'transaction:evm:1'
      })
    ).toEqual({ type: 'GET_PENDING_EVM_TRANSFER', transactionId: 'transaction:evm:1' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'APPROVE_EVM_TRANSFER',
        transactionId: 'transaction:evm:1',
        payloadFingerprint: 'a'.repeat(64)
      })
    ).toMatchObject({ type: 'APPROVE_EVM_TRANSFER', transactionId: 'transaction:evm:1' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'REJECT_EVM_TRANSFER',
        transactionId: 'transaction:evm:1'
      })
    ).toEqual({ type: 'REJECT_EVM_TRANSFER', transactionId: 'transaction:evm:1' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'RESUME_EVM_TRANSFER',
        transactionId: 'transaction:evm:1'
      })
    ).toEqual({ type: 'RESUME_EVM_TRANSFER', transactionId: 'transaction:evm:1' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'APPROVE_EVM_TRANSFER',
        transactionId: 'transaction:evm:1',
        payloadFingerprint: `0x${'a'.repeat(64)}`
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_TRANSFER',
        intent: transferIntent,
        chainAccountId: 'forged'
      })
    ).toThrow(/schema/i)
    const bitcoinQuoteIntent = {
      recipient: 'bc1qdestination',
      amount: { mode: 'exact', valueSats: '1000' }
    }
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_BITCOIN_TRANSFER',
        intent: bitcoinQuoteIntent,
        nearIntentsBinding,
        feeTier: 'low',
        bitcoinAddressType: 'p2tr'
      })
    ).toEqual({
      type: 'PREPARE_BITCOIN_TRANSFER',
      intent: bitcoinQuoteIntent,
      nearIntentsBinding,
      feeTier: 'low',
      bitcoinAddressType: 'p2tr'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_BITCOIN_TRANSFER',
        intent: bitcoinQuoteIntent,
        feeTier: 'economy'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_BITCOIN_TRANSFER',
        intent: bitcoinQuoteIntent,
        bitcoinAddressType: 'p2wsh'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_BITCOIN_TRANSFER',
        intent: bitcoinQuoteIntent,
        nearIntentsBinding: null
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'REMOVE_ACCOUNT',
        walletId: 'wallet-1',
        accountId: 'account-1'
      })
    ).toMatchObject({
      type: 'REMOVE_ACCOUNT',
      walletId: 'wallet-1',
      accountId: 'account-1'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'REMOVE_ACCOUNT',
        walletId: 'wallet-1'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'RENAME_ACCOUNT',
        walletId: 'wallet-1',
        accountId: 'account-1',
        displayName: 'Trading Account'
      })
    ).toEqual({
      type: 'RENAME_ACCOUNT',
      walletId: 'wallet-1',
      accountId: 'account-1',
      displayName: 'Trading Account'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_ACCOUNT_PINNED',
        walletId: 'wallet-1',
        accountId: 'account-1',
        pinned: true
      })
    ).toMatchObject({ type: 'SET_ACCOUNT_PINNED', pinned: true })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_ACCOUNT_HIDDEN',
        walletId: 'wallet-1',
        accountId: 'account-1',
        hidden: false
      })
    ).toMatchObject({ type: 'SET_ACCOUNT_HIDDEN', hidden: false })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_ACCOUNT_PINNED',
        walletId: 'wallet-1',
        accountId: 'account-1',
        pinned: 'true'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'RENAME_WALLET',
        walletId: 'wallet-1',
        displayName: 'Daily Hardware'
      })
    ).toEqual({
      type: 'RENAME_WALLET',
      walletId: 'wallet-1',
      displayName: 'Daily Hardware'
    })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'RENAME_WALLET',
        walletId: 'wallet-1',
        displayName: 'Daily Hardware',
        password: 'must-not-cross-runtime'
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'RESET_WALLET_DATA',
        walletId: 'wallet-1'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'CHANGE_WALLET_PASSWORD',
        currentPassword: 'old-password',
        newPassword: 'new-password'
      })
    ).toMatchObject({ type: 'CHANGE_WALLET_PASSWORD' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'CHANGE_WALLET_PASSWORD',
        currentPassword: 'old-password',
        newPassword: 'new-password',
        walletId: 'forged-wallet'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'WALLET_UNLOCK',
        password: 'x'.repeat(4_097)
      })
    ).toMatchObject({ type: 'WALLET_UNLOCK' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'WALLET_UNLOCK',
        password: 'x'.repeat(1024 * 1024 + 1)
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'WORKER_LOG',
        level: 'trace',
        message: 'forged level'
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'FORWARD_WALLET_LOG',
        payload: { level: 'warn', walletId: 'wallet-1', message: 'diagnostic' }
      })
    ).toMatchObject({ type: 'FORWARD_WALLET_LOG' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'FORWARD_WALLET_LOG',
        payload: { level: 'warn', walletId: 'wallet-1', message: 'diagnostic', args: [] }
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'FORWARD_LOG',
        payload: { level: 'log', args: [] }
      })
    ).toThrow(/unsupported/i)
  })

  test('accepts only bounded Noir events emitted by the service worker', () => {
    expect(
      parseNoirRuntimeEventMessage({
        type: 'NOIR_EVENT',
        chainId: 'zcash',
        eventName: 'accountsChanged',
        data: [{ accountId: 'account-1' }]
      })
    ).toMatchObject({ chainId: 'zcash', eventName: 'accountsChanged' })
    expect(
      parseNoirRuntimeEventMessage({
        type: 'NOIR_EVENT',
        chainId: 'evm',
        eventName: 'connect',
        data: { chainId: '0x1' }
      })
    ).toMatchObject({ chainId: 'evm', eventName: 'connect' })
    expect(() =>
      parseNoirRuntimeEventMessage({
        type: 'NOIR_EVENT',
        chainId: 'zcash',
        eventName: 'privateKeyChanged',
        data: null
      })
    ).toThrow(/invalid/i)
    expect(() =>
      parseNoirRuntimeEventMessage({
        type: 'NOIR_EVENT',
        chainId: 'zcash',
        eventName: 'chainChanged',
        data: null,
        origin: 'https://forged.example'
      })
    ).toThrow(/invalid/i)
    let nested = {}
    for (let depth = 0; depth < 20; depth += 1) nested = { nested }
    expect(() =>
      parseNoirRuntimeEventMessage({
        type: 'NOIR_EVENT',
        chainId: 'zcash',
        eventName: 'accountsChanged',
        data: nested
      })
    ).toThrow(/limits/i)
  })

  test('binds approval and hardware results to one request shape', () => {
    expect(
      parseDAppApprovalResultMessage(
        {
          type: 'DAPP_APPROVAL_RESULT',
          requestId: 'request-1',
          success: true,
          selectedIds: ['account-1']
        },
        'request-1'
      )
    ).toMatchObject({ success: true, selectedIds: ['account-1'] })
    expect(() =>
      parseDAppApprovalResultMessage(
        {
          type: 'DAPP_APPROVAL_RESULT',
          requestId: 'request-1',
          success: false,
          selectedIds: ['account-1']
        },
        'request-1'
      )
    ).toThrow(/rejected/i)
    expect(() =>
      parseDAppApprovalResultMessage(
        {
          type: 'DAPP_APPROVAL_RESULT',
          requestId: 'request-2',
          success: true
        },
        'request-1'
      )
    ).toThrow(/invalid/i)

    expect(
      parseHardwareSignResultMessage(
        {
          type: 'HW_SIGN_RESULT',
          requestId: 'request-1',
          success: true,
          txHash: 'tx-hash'
        },
        'request-1'
      )
    ).toMatchObject({ success: true, txHash: 'tx-hash' })
    expect(() =>
      parseHardwareSignResultMessage(
        {
          type: 'HW_SIGN_RESULT',
          requestId: 'request-1',
          success: true,
          txHash: 'tx-hash',
          error: 'forged'
        },
        'request-1'
      )
    ).toThrow(/invalid/i)
  })

  test('accepts only bounded extension-page RHEA Swap requests', () => {
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_RHEA_SWAP_TOKENS',
        direction: 'from',
        tokenListChainIds: [1, 900010]
      })
    ).toEqual({
      type: 'GET_RHEA_SWAP_TOKENS',
      direction: 'from',
      tokenListChainIds: [1, 900010]
    })

    const request = {
      fromChain: 'zcash',
      toChain: '1',
      tokenIn: { chain: 'zcash', address: 'nep141:zec.omft.near' },
      tokenOut: { chain: '1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
      amountIn: '100000000',
      slippageBps: 100,
      sender: 't1Sender',
      recipient: '0x1111111111111111111111111111111111111111'
    }
    expect(parseTrustedExtensionRuntimeMessage({ type: 'QUOTE_RHEA_SWAP', request })).toEqual({
      type: 'QUOTE_RHEA_SWAP',
      request
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_RHEA_SWAP',
        quoteHandle: 'rhea-quote:session_1'
      })
    ).toMatchObject({ type: 'PREPARE_RHEA_SWAP' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_RHEA_SWAP_EVM_PLAN',
        quoteHandle: 'rhea-quote:session_1'
      })
    ).toMatchObject({ type: 'GET_RHEA_SWAP_EVM_PLAN' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_RHEA_SWAP_EVM_SIGNATURE_PLAN',
        quoteHandle: 'rhea-quote:session_1'
      })
    ).toMatchObject({ type: 'GET_RHEA_SWAP_EVM_SIGNATURE_PLAN' })
    const rheaSwapBinding = {
      schemaVersion: 1,
      provider: 'rhea-cross-chain-dex',
      kind: 'swap',
      quoteHandle: 'rhea-quote:session_1',
      executionId: 'execution-one',
      router: 'one-inch',
      sourceTarget: '0x1111111111111111111111111111111111111111',
      sender: '0x1111111111111111111111111111111111111111',
      originAmountRaw: '1000',
      expiresAt: 2_000,
      isCrossChain: true,
      origin: {
        chainId: 'eip155:1',
        assetId: 'eip155:1/slip44:60',
        protocolChainId: '1',
        protocolAssetId: 'native'
      },
      destination: {
        chainId: 'zcash:mainnet',
        assetId: 'zcash:mainnet/slip44:133',
        protocolChainId: 'zcash',
        protocolAssetId: 'nep141:zec.omft.near',
        recipient: 'u1destination',
        expectedAmountRaw: '900',
        minimumAmountRaw: '850'
      }
    }
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_RHEA_SWAP_EVM_SIGNATURE',
        quoteHandle: 'rhea-quote:session_1',
        binding: rheaSwapBinding
      })
    ).toMatchObject({ type: 'PREPARE_RHEA_SWAP_EVM_SIGNATURE', binding: rheaSwapBinding })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'CONFIRM_RHEA_SWAP_EVM_SIGNATURE',
        quoteHandle: 'rhea-quote:session_1',
        payloadFingerprint: 'a'.repeat(64)
      })
    ).toMatchObject({ type: 'CONFIRM_RHEA_SWAP_EVM_SIGNATURE' })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'CANCEL_RHEA_SWAP_EVM_SIGNATURE',
        quoteHandle: 'rhea-quote:session_1'
      })
    ).toMatchObject({ type: 'CANCEL_RHEA_SWAP_EVM_SIGNATURE' })
    for (const family of ['SOLANA', 'NEAR']) {
      expect(
        parseTrustedExtensionRuntimeMessage({
          type: `PREPARE_RHEA_SWAP_${family}`,
          quoteHandle: 'rhea-quote:session_1',
          binding: rheaSwapBinding
        })
      ).toMatchObject({ type: `PREPARE_RHEA_SWAP_${family}` })
      expect(
        parseTrustedExtensionRuntimeMessage({
          type: `CONFIRM_RHEA_SWAP_${family}`,
          quoteHandle: 'rhea-quote:session_1',
          payloadFingerprint: 'b'.repeat(64)
        })
      ).toMatchObject({ type: `CONFIRM_RHEA_SWAP_${family}` })
      expect(
        parseTrustedExtensionRuntimeMessage({
          type: `CANCEL_RHEA_SWAP_${family}`,
          quoteHandle: 'rhea-quote:session_1'
        })
      ).toMatchObject({ type: `CANCEL_RHEA_SWAP_${family}` })
    }
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SUBMIT_RHEA_SWAP_ORDER',
        quoteHandle: 'rhea-quote:session_1',
        signature: `0x${'ab'.repeat(65)}`
      })
    ).toThrow(/unsupported/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_RHEA_SWAP_EVM_SIGNATURE',
        quoteHandle: 'rhea-quote:session_1',
        binding: { ...rheaSwapBinding, sourceTarget: '0x2222222222222222222222222222222222222222' },
        signature: `0x${'ab'.repeat(65)}`
      })
    ).toThrow(/schema/i)
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'PREPARE_EVM_CONTRACT_CALL',
        intent: {},
        rheaSwapBinding: {},
        feeTier: 'standard'
      })
    ).toMatchObject({ type: 'PREPARE_EVM_CONTRACT_CALL' })
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'GET_RHEA_SWAP_TOKENS',
        direction: 'from',
        tokenListChainIds: [1, 1]
      })
    ).toThrow(/schema/i)
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'QUOTE_RHEA_SWAP',
        request: { ...request, appFees: [{ recipient: 'forged', fee: 20 }] }
      })
    ).toThrow(/schema/i)
  })
})
