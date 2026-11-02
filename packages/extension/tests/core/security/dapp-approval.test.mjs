import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const listeners = new Set()
const storage = {
  async get() {
    return {}
  },
  async set() {},
  async remove() {}
}
let approvalUrl = ''
let notifyApprovalOpened

function waitForApprovalOpened() {
  return new Promise(resolve => {
    notifyApprovalOpened = resolve
  })
}

globalThis.location = {
  href: `chrome-extension://${extensionId}/index.html`,
  pathname: '/index.html'
}
globalThis.chrome = {
  storage: {
    local: storage,
    session: storage,
    onChanged: { addListener() {} }
  },
  runtime: {
    id: extensionId,
    ContextType: { TAB: 'TAB', POPUP: 'POPUP' },
    getURL: path => `chrome-extension://${extensionId}${path}`,
    async getContexts() {
      return []
    },
    onMessage: {
      addListener(listener) {
        listeners.add(listener)
      },
      removeListener(listener) {
        listeners.delete(listener)
      }
    }
  },
  windows: {
    async getLastFocused() {
      return null
    },
    create(options, callback) {
      approvalUrl = options.url
      callback({ id: 7 })
      notifyApprovalOpened?.()
      notifyApprovalOpened = undefined
    },
    async remove() {}
  }
}

const [{ DAppHandler }, { pendingRequestsManager }] = await Promise.all([
  import('../../../src/background/dapp-handler.ts'),
  import('../../../src/background/pending-requests.ts')
])

after(() => {
  pendingRequestsManager.cancelAll()
  delete globalThis.chrome
  delete globalThis.location
})

function sendApprovalMessage(requestId, message) {
  const sender = {
    id: extensionId,
    origin: `chrome-extension://${extensionId}`,
    url: `chrome-extension://${extensionId}/index.html#/approval?requestId=${requestId}`,
    tab: { id: 1, windowId: 7 }
  }
  return new Promise(resolve => {
    const listener = [...listeners][0]
    assert.ok(listener, 'approval listener is registered')
    listener({ ...message, requestId }, sender, resolve)
  })
}

test('approval cannot complete while its transaction fee review is changing', async () => {
  let completeFeeUpdate
  const feeUpdate = new Promise(resolve => {
    completeFeeUpdate = resolve
  })
  let completeCustomFeeUpdate
  const customFeeUpdate = new Promise(resolve => {
    completeCustomFeeUpdate = resolve
  })
  const handler = new DAppHandler()
  const approvalOpened = waitForApprovalOpened()
  const approval = handler.requestExternalApproval(
    'https://dapp.example',
    'evmTransaction',
    { feeTier: 'standard' },
    {
      onNetworkFeeTierChange: () => feeUpdate,
      onEvmFeeSelectionChange: () => customFeeUpdate
    }
  )
  await approvalOpened
  const requestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(requestId)

  const pendingFeeResponse = sendApprovalMessage(requestId, {
    type: 'DAPP_NETWORK_FEE_TIER_CHANGE',
    feeTier: 'fast'
  })
  assert.deepEqual(
    await sendApprovalMessage(requestId, {
      type: 'DAPP_APPROVAL_RESULT',
      success: true
    }),
    { error: 'Wait for the network fee update to complete' }
  )
  assert.deepEqual(
    await sendApprovalMessage(requestId, {
      type: 'DAPP_EVM_FEE_SELECTION_CHANGE',
      feeSelection: { kind: 'tier', tier: 'low' }
    }),
    { error: 'Wait for the network fee update to complete' }
  )

  const updatedData = { feeTier: 'fast' }
  completeFeeUpdate(updatedData)
  assert.deepEqual(await pendingFeeResponse, { data: updatedData })
  const pendingCustomFeeResponse = sendApprovalMessage(requestId, {
    type: 'DAPP_EVM_FEE_SELECTION_CHANGE',
    feeSelection: { kind: 'tier', tier: 'low' }
  })
  assert.deepEqual(
    await sendApprovalMessage(requestId, { type: 'DAPP_APPROVAL_RESULT', success: true }),
    { error: 'Wait for the network fee update to complete' }
  )
  const customData = { feeSelection: { kind: 'tier', tier: 'low' } }
  completeCustomFeeUpdate(customData)
  assert.deepEqual(await pendingCustomFeeResponse, { data: customData })
  assert.deepEqual(
    await sendApprovalMessage(requestId, {
      type: 'DAPP_APPROVAL_RESULT',
      success: true
    }),
    { success: true }
  )
  assert.equal((await approval).approved, true)
  assert.equal(listeners.size, 0)
})

test('rejection cancels an approval during fee preparation and discards its late review', async () => {
  let completeFeeUpdate
  const feeUpdate = new Promise(resolve => {
    completeFeeUpdate = resolve
  })
  const handler = new DAppHandler()
  const approvalOpened = waitForApprovalOpened()
  const approval = handler.requestExternalApproval(
    'https://dapp.example',
    'bitcoinTransaction',
    { feeTier: 'standard' },
    { onNetworkFeeTierChange: () => feeUpdate }
  )
  await approvalOpened
  const requestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(requestId)

  const pendingFeeResponse = sendApprovalMessage(requestId, {
    type: 'DAPP_NETWORK_FEE_TIER_CHANGE',
    feeTier: 'fast'
  })
  assert.deepEqual(
    await sendApprovalMessage(requestId, { type: 'DAPP_APPROVAL_RESULT', success: false }),
    { success: true }
  )
  assert.equal((await approval).approved, false)
  assert.equal(listeners.size, 0)
  completeFeeUpdate({ feeTier: 'fast' })
  assert.deepEqual(await pendingFeeResponse, { error: 'Approval request is no longer active' })
  assert.equal(pendingRequestsManager.get(requestId), null)
})
