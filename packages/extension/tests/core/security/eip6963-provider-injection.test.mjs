import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const { rdns: NOIR_WALLET_RDNS } = JSON.parse(
  readFileSync(new URL('../../../../sdk/package.json', import.meta.url), 'utf8')
)

const providerSource = readFileSync(
  new URL('../../../src/content-script/inject-provider.ts', import.meta.url),
  'utf-8'
)
const walletStandardSource = readFileSync(
  new URL('../../../src/content-script/solana-wallet-standard.ts', import.meta.url),
  'utf-8'
)
const nearConnectWalletSource = readFileSync(
  new URL('../../../src/content-script/near-connect-wallet.ts', import.meta.url),
  'utf-8'
)
const providerBrandSource = readFileSync(
  new URL('../../../src/content-script/provider-brand.ts', import.meta.url),
  'utf-8'
)
const providerIconDataUrl = `data:image/png;base64,${readFileSync(
  new URL('../../../public/icons/icon128.png', import.meta.url)
).toString('base64')}`

function withoutImport(source, moduleName) {
  return source.replace(
    new RegExp(
      `import[\\s\\S]*?from '${moduleName.replaceAll('.', '\\.').replaceAll('/', '\\/')}'\\n`
    ),
    ''
  )
}

const executableProviderSource = `${providerBrandSource
  .replace('import.meta.env.NOIR_PROVIDER_ICON_DATA_URL', JSON.stringify(providerIconDataUrl))
  .replaceAll(
    'export ',
    ''
  )}\n${withoutImport(walletStandardSource, './provider-brand').replaceAll('export ', '')}\n${withoutImport(nearConnectWalletSource, './provider-brand').replaceAll('export ', '')}\n${withoutImport(withoutImport(withoutImport(providerSource, './solana-wallet-standard'), './near-connect-wallet'), './provider-brand')}`
  .replace('import.meta.env.NOIR_APP_VERSION', '__APP_VERSION__')
  .replace('import.meta.env.NOIR_NETWORK_MODE', '__NETWORK_MODE__')
  .replace('import.meta.env.NOIR_WALLET_RDNS', JSON.stringify(NOIR_WALLET_RDNS))
  .replace('import.meta.env.NOIR_ENABLED_CHAIN_FEATURE_FLAGS', '__ENABLED_CHAIN_FEATURE_FLAGS__')
const compiledProvider = ts.transpileModule(executableProviderSource, {
  compilerOptions: {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2022
  }
}).outputText

test('does not depend on extension-world globals in the MAIN-world provider', () => {
  expect(providerSource).not.toContain('__NETWORK_MODE__')
})

class TestEvent {
  constructor(type) {
    this.type = type
  }
}

class TestCustomEvent extends TestEvent {
  constructor(type, init = {}) {
    super(type)
    this.detail = init.detail
  }
}

function createHarness(
  enabledChainFeatureFlags = ['chain.evm'],
  authorizedEvmAccounts = [],
  includeExistingEthereum = true
) {
  const listeners = new Map()
  const announcements = []
  const standardWallets = []
  const nearConnectWallets = []
  const pageRequests = []
  const deferredEvmChainIdResponses = []
  let deferNextEvmChainId = false
  const existingEthereum = Object.freeze({ name: 'Existing wallet' })
  const windowMock = {
    ...(includeExistingEthereum ? { ethereum: existingEthereum } : {}),
    location: { origin: 'https://dapp.example' },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? []
      entries.push(listener)
      listeners.set(type, entries)
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(candidate => candidate !== listener)
      )
    },
    dispatchEvent(event) {
      if (event.type === 'eip6963:announceProvider') announcements.push(event.detail)
      if (event.type === 'wallet-standard:register-wallet') {
        event.detail({ register: wallet => standardWallets.push(wallet) })
      }
      if (event.type === 'near-wallet-injected') nearConnectWallets.push(event.detail)
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event)
      return true
    },
    postMessage(message) {
      if (message.target !== 'noir-content-script') return
      pageRequests.push(message)
      const method = message.payload.method
      const response =
        method === 'wallet_createSession'
          ? {
              target: 'noir-provider',
              requestId: message.requestId,
              result: { scopes: message.payload.params.scopes }
            }
          : method === 'wallet_getSession'
            ? {
                target: 'noir-provider',
                requestId: message.requestId,
                result: null
              }
            : method === 'personal_sign'
              ? {
                  target: 'noir-provider',
                  requestId: message.requestId,
                  error: { code: 4001, message: 'User rejected the signature request.' }
                }
              : method === 'connect'
                ? {
                    target: 'noir-provider',
                    requestId: message.requestId,
                    result:
                      message.chainId === 'solana'
                        ? { address: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' }
                        : {
                            address: 'named-account.near',
                            publicKey: `ed25519:${'1'.repeat(32)}`
                          }
                  }
                : method === 'signAndSendTransaction'
                  ? {
                      target: 'noir-provider',
                      requestId: message.requestId,
                      result:
                        message.chainId === 'near'
                          ? { transaction: { hash: 'near-hash' }, status: { SuccessValue: '' } }
                          : '1'.repeat(64)
                    }
                  : {
                      target: 'noir-provider',
                      requestId: message.requestId,
                      result:
                        method === 'eth_chainId'
                          ? '0x1'
                          : method === 'wallet_switchEthereumChain'
                            ? null
                            : method === 'eth_accounts' || method === 'eth_requestAccounts'
                              ? authorizedEvmAccounts
                              : []
                    }
      const sendResponse = () => {
        for (const listener of [...(listeners.get('message') ?? [])]) {
          listener({ source: windowMock, data: response })
        }
      }
      if (method === 'eth_chainId' && deferNextEvmChainId) {
        deferredEvmChainIdResponses.push(sendResponse)
      } else {
        sendResponse()
      }
      deferNextEvmChainId = false
    },
    setTimeout,
    clearTimeout
  }

  vm.runInNewContext(compiledProvider, {
    window: windowMock,
    crypto,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    Event: TestEvent,
    CustomEvent: TestCustomEvent,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
    __APP_VERSION__: '1.0.30',
    __NETWORK_MODE__: 'mainnet',
    __ENABLED_CHAIN_FEATURE_FLAGS__: enabledChainFeatureFlags
  })
  windowMock.dispatchEvent(new TestEvent('noirwallet#bridgeReady'))

  return {
    windowMock,
    existingEthereum,
    announcements,
    pageRequests,
    deferNextEvmChainIdResponse() {
      deferNextEvmChainId = true
    },
    releaseEvmChainIdResponse() {
      const respond = deferredEvmChainIdResponses.shift()
      if (!respond) throw new Error('No deferred eth_chainId response')
      respond()
    },
    standardWallets,
    nearConnectWallets
  }
}

test.describe('EIP-6963 provider injection', () => {
  test('keeps the new chain after an older eth_chainId request resolves', async () => {
    const harness = createHarness()
    await new Promise(resolve => setImmediate(resolve))
    const provider = harness.windowMock.noirwallet.ethereum
    expect(provider.chainId).toBe('0x1')

    harness.deferNextEvmChainIdResponse()
    const oldChainRequest = provider.request({ method: 'eth_chainId' })
    await new Promise(resolve => setImmediate(resolve))
    harness.windowMock.dispatchEvent({
      type: 'message',
      source: harness.windowMock,
      data: {
        target: 'noir-provider',
        type: 'NOIR_EVENT',
        chainId: 'evm',
        eventName: 'chainChanged',
        data: '0xa4b1'
      }
    })
    expect(provider.chainId).toBe('0xa4b1')

    harness.releaseEvmChainIdResponse()
    expect(await oldChainRequest).toBe('0x1')
    expect(provider.chainId).toBe('0xa4b1')
  })

  test('updates chainId from an approved switch when the event is delayed', async () => {
    const harness = createHarness()
    await new Promise(resolve => setImmediate(resolve))
    const provider = harness.windowMock.noirwallet.ethereum
    expect(provider.chainId).toBe('0x1')
    const changes = []
    provider.on('chainChanged', chainId => changes.push(chainId))

    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xA4B1' }]
    })
    expect(provider.chainId).toBe('0xa4b1')
    expect(changes).toEqual(['0xa4b1'])

    harness.windowMock.dispatchEvent({
      type: 'message',
      source: harness.windowMock,
      data: {
        target: 'noir-provider',
        type: 'NOIR_EVENT',
        chainId: 'evm',
        eventName: 'chainChanged',
        data: '0xa4b1'
      }
    })
    expect(changes).toEqual(['0xa4b1'])
  })

  test('keeps the EVM provider absent when the build feature is disabled', async () => {
    const harness = createHarness([])
    await new Promise(resolve => setImmediate(resolve))

    expect(harness.windowMock.ethereum).toBe(harness.existingEthereum)
    expect(harness.windowMock.noirwallet.ethereum).toBeUndefined()
    expect(harness.announcements).toEqual([])

    harness.windowMock.dispatchEvent(new TestEvent('eip6963:requestProvider'))
    expect(harness.announcements).toEqual([])
  })

  test('exposes CAIP-25 on the root wallet and multichain provider', async () => {
    const harness = createHarness([])
    const request = {
      scopes: {
        'bip122:00040fe8ec8471911baa1db1266ea15d': {
          methods: ['zcash_getAccounts'],
          notifications: ['wallet_sessionChanged']
        }
      }
    }
    await harness.windowMock.noirwallet.request({
      method: 'wallet_createSession',
      params: request
    })
    await harness.windowMock.noirwallet.multichain.getSession()

    expect(harness.pageRequests.slice(-2)).toMatchObject([
      {
        chainId: 'multichain',
        payload: { method: 'wallet_createSession', params: request }
      },
      {
        chainId: 'multichain',
        payload: { method: 'wallet_getSession' }
      }
    ])
  })

  test('announces Noir Wallet synchronously without replacing the existing provider', async () => {
    const harness = createHarness()

    expect(harness.windowMock.ethereum).toBe(harness.existingEthereum)
    expect(harness.windowMock.noirwallet.ethereum.isNoirWallet).toBe(true)
    expect(harness.announcements).toHaveLength(1)
    expect(harness.announcements[0].info).toMatchObject({
      name: 'Noir Wallet',
      rdns: NOIR_WALLET_RDNS
    })
    expect(harness.announcements[0].info.icon).toBe(providerIconDataUrl)
    expect(harness.announcements[0].provider).toBe(harness.windowMock.noirwallet.ethereum)

    await new Promise(resolve => setImmediate(resolve))
    harness.windowMock.dispatchEvent(new TestEvent('eip6963:requestProvider'))
    expect(harness.announcements).toHaveLength(2)
  })

  test('allows a later wallet to replace the legacy fallback without hiding Noir Wallet', async () => {
    const harness = createHarness(['chain.evm'], [], false)
    await new Promise(resolve => setImmediate(resolve))

    const noirProvider = harness.windowMock.noirwallet.ethereum
    expect(harness.windowMock.ethereum).toBe(noirProvider)
    expect(Object.getOwnPropertyDescriptor(harness.windowMock, 'ethereum')).toMatchObject({
      writable: true,
      configurable: true
    })

    const metaMaskProvider = Object.freeze({ isMetaMask: true })
    expect(Reflect.set(harness.windowMock, 'ethereum', metaMaskProvider)).toBe(true)
    expect(harness.windowMock.ethereum).toBe(metaMaskProvider)
    expect(harness.windowMock.noirwallet.ethereum).toBe(noirProvider)

    harness.windowMock.dispatchEvent(new TestEvent('eip6963:requestProvider'))
    expect(harness.announcements.at(-1).provider).toBe(noirProvider)
  })

  test('restores an authorized EVM account after reload and emits it on reconnect', async () => {
    const account = '0x1111111111111111111111111111111111111111'
    const harness = createHarness(['chain.evm'], [account])
    const provider = harness.windowMock.noirwallet.ethereum
    const accountEvents = []
    provider.on('accountsChanged', accounts => accountEvents.push(accounts))

    await new Promise(resolve => setImmediate(resolve))

    expect(provider.isConnected()).toBe(true)
    expect(provider.chainId).toBe('0x1')
    expect(provider.selectedAddress).toBe(account)

    await provider.request({ method: 'eth_requestAccounts' })

    expect(provider.selectedAddress).toBe(account)
    expect(accountEvents).toEqual([[account]])
  })

  test('exposes structured EIP-1193 errors to the page', async () => {
    const harness = createHarness()
    await new Promise(resolve => setImmediate(resolve))

    let rejection
    try {
      await harness.windowMock.noirwallet.ethereum.request({
        method: 'personal_sign',
        params: ['0x48656c6c6f', '0x1111111111111111111111111111111111111111']
      })
    } catch (error) {
      rejection = error
    }
    expect({
      name: rejection?.name,
      code: rejection?.code,
      message: rejection?.message
    }).toEqual({
      name: 'ProviderRpcError',
      code: 4001,
      message: 'User rejected the signature request.'
    })
    expect(harness.pageRequests.at(-1).chainId).toBe('evm')
  })

  test('exposes Bitcoin only under the Noir namespace without impersonating another wallet', async () => {
    const disabled = createHarness(['chain.evm'])
    expect(disabled.windowMock.noirwallet.bitcoin).toBeUndefined()

    const enabled = createHarness(['chain.evm', 'chain.bitcoin'])
    expect(enabled.windowMock.noirwallet.bitcoin).toBeDefined()
    expect(enabled.windowMock.unisat).toBeUndefined()
    await enabled.windowMock.noirwallet.bitcoin.getAccounts()
    expect(enabled.pageRequests.find(request => request.chainId === 'bitcoin')).toMatchObject({
      chainId: 'bitcoin',
      payload: { method: 'getAccounts', params: [] }
    })
  })

  test('exposes every injected V2 provider through the public dApp SDK', async () => {
    const harness = createHarness(['chain.evm', 'chain.bitcoin'])
    const previousWindow = globalThis.window
    globalThis.window = harness.windowMock
    try {
      const { detectBitcoinProvider, detectEvmProvider, getNoirWallet, ZcashAPI, ZcashClient } =
        await import('../../../../sdk/src/index.ts')
      const wallet = getNoirWallet()
      expect(ZcashAPI).toBe(ZcashClient)
      expect(wallet?.zcash).toBeInstanceOf(ZcashClient)
      expect(wallet?.ethereum).toBe(harness.windowMock.noirwallet.ethereum)
      expect(wallet?.bitcoin).toBe(harness.windowMock.noirwallet.bitcoin)
      await expect(detectEvmProvider()).resolves.toBe(harness.windowMock.noirwallet.ethereum)
      await expect(detectBitcoinProvider()).resolves.toBe(harness.windowMock.noirwallet.bitcoin)
    } finally {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
    }
  })

  test('registers Solana Wallet Standard and exposes the OKX-compatible NEAR surface', async () => {
    const harness = createHarness(['chain.solana', 'chain.near'])
    await new Promise(resolve => setImmediate(resolve))

    expect(harness.standardWallets).toHaveLength(1)
    expect(harness.standardWallets[0]).toMatchObject({
      name: 'Noir Wallet',
      icon: providerIconDataUrl,
      chains: ['solana:mainnet'],
      features: {
        'standard:connect': { version: '1.0.0' },
        'standard:events': { version: '1.0.0' },
        'solana:signTransaction': { version: '1.0.0' },
        'solana:signAndSendTransaction': { version: '1.0.0' },
        'solana:signMessage': { version: '1.0.0' }
      }
    })
    expect(harness.windowMock.noirwallet.solana).toMatchObject({
      isNoirWallet: true,
      getAccounts: expect.any(Function),
      signTransaction: expect.any(Function),
      signAllTransactions: expect.any(Function),
      signAndSendTransaction: expect.any(Function),
      signMessage: expect.any(Function)
    })
    expect(harness.windowMock.noirwallet.solana.getBalance).toBeUndefined()
    expect(harness.windowMock.noirwallet.near).toMatchObject({
      requestSignIn: expect.any(Function),
      getAccounts: expect.any(Function),
      signOut: expect.any(Function),
      signTransaction: expect.any(Function),
      requestSignTransactions: expect.any(Function),
      signMessage: expect.any(Function)
    })
    expect(harness.windowMock.noirwallet.near.getBalance).toBeUndefined()

    harness.windowMock.dispatchEvent(new TestEvent('near-selector-ready'))
    expect(harness.nearConnectWallets).toHaveLength(1)
    expect(harness.nearConnectWallets[0]).toMatchObject({
      manifest: {
        id: 'noir-wallet',
        name: 'Noir Wallet',
        icon: providerIconDataUrl,
        type: 'injected',
        features: {
          signMessage: true,
          signInWithoutAddKey: true,
          signAndSendTransaction: true,
          signAndSendTransactions: true,
          mainnet: true,
          testnet: false
        }
      },
      signIn: expect.any(Function),
      getAccounts: expect.any(Function),
      signOut: expect.any(Function),
      signMessage: expect.any(Function)
    })
    expect(harness.nearConnectWallets[0].manifest.icon).toBe(harness.standardWallets[0].icon)

    const solanaConnection = await harness.windowMock.noirwallet.solana.connect()
    expect(solanaConnection.publicKey.toString()).toBe(
      'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
    )
    expect(harness.windowMock.noirwallet.solana.publicKey.toString()).toBe(
      'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
    )
    expect(harness.pageRequests.at(-1)).toMatchObject({
      chainId: 'solana',
      payload: { method: 'connect', params: [] }
    })

    const nearConnection = await harness.windowMock.noirwallet.near.requestSignIn()
    expect(nearConnection.accountId).toBe('named-account.near')
    expect(nearConnection.accessKey.publicKey).toBe(`ed25519:${'1'.repeat(32)}`)
    expect(harness.pageRequests.at(-1)).toMatchObject({
      chainId: 'near',
      payload: { method: 'connect', params: [] }
    })

    const nearConnectAccounts = await harness.nearConnectWallets[0].signIn()
    expect(nearConnectAccounts).toEqual([
      {
        accountId: 'named-account.near',
        publicKey: `ed25519:${'1'.repeat(32)}`
      }
    ])

    const nearConnectResult = await harness.nearConnectWallets[0].signAndSendTransaction({
      receiverId: 'x.rhea.near',
      actions: [
        {
          enum: 'functionCall',
          functionCall: {
            methodName: 'stake',
            args: Uint8Array.of(123, 125),
            gas: 300000000000000n,
            deposit: 0n
          }
        }
      ]
    })
    expect(nearConnectResult).toEqual({
      transaction: { hash: 'near-hash' },
      status: { SuccessValue: '' }
    })
    expect(harness.pageRequests.at(-1)).toMatchObject({
      chainId: 'near',
      payload: {
        method: 'signAndSendTransaction',
        params: [
          {
            actions: [
              {
                functionCall: {
                  args: [123, 125],
                  gas: '300000000000000',
                  deposit: '0'
                }
              }
            ]
          }
        ]
      }
    })

    await harness.windowMock.noirwallet.solana.signAndSendTransaction(Uint8Array.of(1), {
      preflightCommitment: 'processed',
      minContextSlot: 42,
      commitment: 'finalized',
      skipPreflight: true,
      maxRetries: 7
    })
    expect(harness.pageRequests.at(-1)).toMatchObject({
      chainId: 'solana',
      payload: {
        method: 'signAndSendTransaction',
        params: [
          'AQ==',
          {
            preflightCommitment: 'processed',
            minContextSlot: 42,
            commitment: 'finalized',
            skipPreflight: true,
            maxRetries: 7
          }
        ]
      }
    })

    await harness.standardWallets[0].features['standard:disconnect'].disconnect()
    expect(harness.pageRequests.at(-1)).toMatchObject({
      chainId: 'solana',
      payload: { method: 'disconnect', params: [] }
    })
  })
})
