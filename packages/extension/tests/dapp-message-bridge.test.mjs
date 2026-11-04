import { test as it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const contentScriptSource = readFileSync(
  new URL('../src/content-script/index.ts', import.meta.url),
  'utf-8'
)
const compiledContentScript = ts.transpileModule(contentScriptSource, {
  compilerOptions: {
    module: ts.ModuleKind.None,
    target: ts.ScriptTarget.ES2022
  }
}).outputText

function createBridgeHarness(responses) {
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
    chrome: chromeMock,
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
    async request(method, requestId = 'request-1') {
      await messageListeners[0]({
        source: windowMock,
        data: {
          target: 'noir-content-script',
          type: 'NOIR_REQUEST',
          requestId,
          chainId: 'zcash',
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
  it('rejects transaction history requests without forwarding them to the background', async () => {
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
})
