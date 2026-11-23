import { test as it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {
  DAPP_RUNTIME_METHODS,
  getOwnExtensionSenderContext,
  parseDAppRuntimeRequestMessage
} from '../../../src/lib/runtime-message-security.ts'

const describe = it.describe
const contentScriptSource = readFileSync(
  new URL('../../../src/content-script/index.ts', import.meta.url),
  'utf-8'
)
const backgroundSource = readFileSync(
  new URL('../../../src/background/index.ts', import.meta.url),
  'utf-8'
)
const executableContentScriptSource = contentScriptSource.replace(
  /import\s*\{[\s\S]*?\}\s*from '@\/lib\/runtime-message-security'\s*/,
  ''
)
const compiledContentScript = ts.transpileModule(executableContentScriptSource, {
  compilerOptions: {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2022
  }
}).outputText

function createBridgeHarness(
  responses,
  enabledChainFeatureFlags = ['chain.evm'],
  faviconUrl = undefined
) {
  const messageListeners = []
  const postedMessages = []
  const sentMessages = []
  const warnings = []
  const queuedResponses = [...responses]

  const windowMock = {
    location: { origin: 'https://example.com' },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener)
    },
    dispatchEvent() {},
    postMessage(message) {
      postedMessages.push(message)
    }
  }

  const chromeMock = {
    runtime: {
      async sendMessage(message) {
        sentMessages.push(message)
        const response = queuedResponses.shift()
        if (response instanceof Error) throw response
        return response
      },
      onMessage: {
        addListener() {}
      }
    }
  }

  vm.runInNewContext(compiledContentScript, {
    window: windowMock,
    document: {
      querySelector: () => (faviconUrl === undefined ? null : { href: faviconUrl })
    },
    chrome: chromeMock,
    URL,
    DAPP_RUNTIME_METHODS,
    getOwnExtensionSenderContext,
    parseDAppRuntimeRequestMessage: value =>
      parseDAppRuntimeRequestMessage(JSON.parse(JSON.stringify(value))),
    __ENABLED_CHAIN_FEATURE_FLAGS__: enabledChainFeatureFlags,
    Event,
    console: {
      log() {},
      warn(...args) {
        warnings.push(args)
      }
    },
    clearTimeout,
    setTimeout
  })

  assert.equal(messageListeners.length, 1)

  return {
    async request(method, requestId = 'request-1', chainId = 'zcash') {
      await messageListeners[0]({
        source: windowMock,
        data: {
          target: 'noir-content-script',
          type: 'NOIR_REQUEST',
          requestId,
          chainId,
          payload: { method }
        }
      })
    },
    postedMessages,
    sentMessages,
    warnings
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

describe('dApp message bridge', () => {
  it('forwards the document favicon through the validated runtime envelope', async () => {
    const harness = createBridgeHarness(
      [{ requestId: 'request-1', result: [] }],
      ['chain.evm'],
      'https://example.com/favicon.ico'
    )

    await harness.request('zcash_requestAccounts')

    assert.deepEqual(plain(harness.sentMessages), [
      {
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'zcash',
        siteMetadata: { faviconUrl: 'https://example.com/favicon.ico' },
        request: { method: 'zcash_requestAccounts' }
      }
    ])
  })

  it('returns a stable error when Chrome returns an empty response', async () => {
    const harness = createBridgeHarness([null])

    await harness.request('zcash_getAccounts')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.warnings.length, 1)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: 'No response from Noir Wallet background. Reload the page and try again.'
      }
    ])
  })

  it('rejects a response correlated to another request', async () => {
    const harness = createBridgeHarness([{ requestId: 'another-request', result: null }])

    await harness.request('zcash_getAccounts')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.warnings.length, 1)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: 'No response from Noir Wallet background. Reload the page and try again.'
      }
    ])
  })

  it('preserves a Chrome runtime error', async () => {
    const harness = createBridgeHarness([new Error('Extension context invalidated.')])

    await harness.request('zcash_getAccounts')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.warnings.length, 0)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: 'Extension context invalidated.'
      }
    ])
  })

  it('preserves a correlated business error from the background', async () => {
    const harness = createBridgeHarness([
      {
        requestId: 'request-1',
        error: 'Not authorized. Call zcash_requestAccounts first.'
      }
    ])

    await harness.request('zcash_getBalance')

    assert.equal(harness.sentMessages.length, 1)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: 'Not authorized. Call zcash_requestAccounts first.'
      }
    ])
  })

  it('preserves a structured EIP-1193 error from the background', async () => {
    const harness = createBridgeHarness([
      {
        requestId: 'request-1',
        error: { code: 4100, message: 'This site is not authorized.' }
      }
    ])

    await harness.request('eth_accounts', 'request-1', 'evm')

    assert.equal(harness.sentMessages.length, 1)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: { code: 4100, message: 'This site is not authorized.' }
      }
    ])
  })

  it('forwards a Shield balance refresh to the background', async () => {
    const harness = createBridgeHarness([{ requestId: 'request-1', result: { balances: [] } }])

    await harness.request('shield_refreshBalances', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].chainId, 'shield')
    assert.equal(harness.sentMessages[0].request.method, 'shield_refreshBalances')
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        result: { balances: [] }
      }
    ])
  })

  it('forwards a Shield quote to the background', async () => {
    const harness = createBridgeHarness([
      {
        requestId: 'request-1',
        result: { layer: 'near-confidential', action: 'receive', amount: '0.1' }
      }
    ])

    await harness.request('shield_getQuote', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_getQuote')
  })

  it('forwards a Shield chain catalog request to the background', async () => {
    const harness = createBridgeHarness([
      { requestId: 'request-1', result: { chains: [{ chainId: 'eip155:1', name: 'Ethereum' }] } }
    ])

    await harness.request('shield_getSupportedChains', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_getSupportedChains')
  })

  it('forwards a Shield receive to the background', async () => {
    const harness = createBridgeHarness([
      {
        requestId: 'request-1',
        result: { id: 'plan-1', layer: 'near-confidential', action: 'receive', status: 'processing' }
      }
    ])

    await harness.request('shield_receive', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_receive')
  })

  it('forwards a Shield status refresh to the background', async () => {
    const harness = createBridgeHarness([
      {
        requestId: 'request-1',
        result: {
          id: 'd065c72d-9db6-411d-ab1b-f5e977b5c55a',
          layer: 'near-confidential',
          action: 'receive',
          status: 'processing'
        }
      }
    ])

    await harness.request('shield_getTransactionStatus', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_getTransactionStatus')
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        result: {
          id: 'd065c72d-9db6-411d-ab1b-f5e977b5c55a',
          layer: 'near-confidential',
          action: 'receive',
          status: 'processing'
        }
      }
    ])
  })

  it('forwards Shield connect to the background', async () => {
    const harness = createBridgeHarness([
      { requestId: 'request-1', result: { layer: 'near-confidential', connected: true } }
    ])

    await harness.request('shield_connect', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_connect')
  })

  it('forwards Shield transfer to the background', async () => {
    const harness = createBridgeHarness([
      {
        requestId: 'request-1',
        result: {
          id: 'd065c72d-9db6-411d-ab1b-f5e977b5c55a',
          layer: 'near-confidential',
          action: 'transfer',
          status: 'signing'
        }
      }
    ])

    await harness.request('shield_transfer', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_transfer')
  })

  it('forwards Shield disconnect to the background', async () => {
    const harness = createBridgeHarness([
      { requestId: 'request-1', result: { layer: 'near-confidential', connected: false } }
    ])

    await harness.request('shield_disconnect', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 1)
    assert.equal(harness.sentMessages[0].request.method, 'shield_disconnect')
  })

  it('returns code 4200 for an unsupported Shield method', async () => {
    const harness = createBridgeHarness([])

    await harness.request('shield_sign', 'request-1', 'shield')

    assert.equal(harness.sentMessages.length, 0)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: { code: 4200, message: 'The requested Shield method is not supported.' }
      }
    ])
  })

  it('returns EIP-1193 code 4200 for an unsupported EVM method', async () => {
    const harness = createBridgeHarness([])

    await harness.request('eth_sign', 'request-1', 'evm')

    assert.equal(harness.sentMessages.length, 0)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: { code: 4200, message: 'The requested EVM method is not supported.' }
      }
    ])
  })

  it('does not forward the retired transaction history method', async () => {
    const harness = createBridgeHarness([])

    await harness.request('zcash_getTransactionHistory')

    assert.equal(harness.sentMessages.length, 0)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: 'Invalid or unsupported method'
      }
    ])
  })

  it('keeps EVM requests closed when the build feature is disabled', async () => {
    const harness = createBridgeHarness([], [])

    await harness.request('eth_chainId', 'request-1', 'evm')

    assert.equal(harness.sentMessages.length, 0)
    assert.deepEqual(plain(harness.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-1',
        error: { code: 4200, message: 'The EVM provider is unavailable in this wallet build.' }
      }
    ])
  })

  it('allows a burst of EVM connection reads without blocking an account request', async () => {
    const responses = Array.from({ length: 41 }, (_, index) => ({
      requestId: `request-${index}`,
      result: index === 40 ? ['0x0000000000000000000000000000000000000001'] : []
    }))
    const harness = createBridgeHarness(responses)

    for (let index = 0; index < 40; index += 1) {
      await harness.request('eth_accounts', `request-${index}`, 'evm')
    }
    await harness.request('eth_requestAccounts', 'request-40', 'evm')

    assert.equal(harness.sentMessages.length, 41)
    assert.equal(harness.postedMessages.filter(message => message.error).length, 0)
  })

  it('routes enabled Bitcoin requests and closes the provider when disabled', async () => {
    const enabled = createBridgeHarness(
      [{ requestId: 'request-1', result: ['bc1qaccount'] }],
      ['chain.evm', 'chain.bitcoin']
    )
    await enabled.request('getAccounts', 'request-1', 'bitcoin')
    assert.deepEqual(plain(enabled.sentMessages), [
      {
        type: 'DAPP_REQUEST',
        requestId: 'request-1',
        chainId: 'bitcoin',
        request: { method: 'getAccounts' }
      }
    ])

    const disabled = createBridgeHarness([], ['chain.evm'])
    await disabled.request('getAccounts', 'request-2', 'bitcoin')
    assert.equal(disabled.sentMessages.length, 0)
    assert.deepEqual(plain(disabled.postedMessages), [
      {
        target: 'noir-provider',
        requestId: 'request-2',
        error: { code: 4200, message: 'The Bitcoin provider is unavailable in this wallet build.' }
      }
    ])
  })

  it('correlates every background response with the provider request ID', () => {
    assert.match(
      backgroundSource,
      /sendResponse\(\{ requestId: parsedMessage\.requestId, \.\.\.response \}\)/
    )
    assert.match(backgroundSource, /requestId: parsedMessage\.requestId/)
    assert.match(
      backgroundSource,
      /chainId === 'evm' && !evmFeatureRuntimePolicy\.newOperationsEnabled/
    )
    assert.match(
      backgroundSource,
      /chainId === 'bitcoin' && !bitcoinFeatureRuntimePolicy\.newOperationsEnabled/
    )
  })
})
