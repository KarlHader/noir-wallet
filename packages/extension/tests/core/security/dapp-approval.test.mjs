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
let approvalWindowCreates = 0
let approvalWindowFocuses = 0

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
      approvalWindowCreates += 1
      approvalUrl = options.url
      callback({ id: 7 })
      notifyApprovalOpened?.()
      notifyApprovalOpened = undefined
    },
    async update() {
      approvalWindowFocuses += 1
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

test('clearing Zcash permissions preserves pending approvals for other chains', async () => {
  const handler = new DAppHandler()
  const actions = [
    'connect',
    'evmConnect',
    'bitcoinConnect',
    'solanaConnect',
    'nearConnect',
    'multichainConnect'
  ]
  const requestIds = actions.map(action =>
    pendingRequestsManager.create(
      'https://dapp.example',
      action,
      {},
      'wallet',
      'account',
      'mainnet',
      0
    )
  )
  try {
    handler.clearPermissions()
    assert.equal(pendingRequestsManager.get(requestIds[0]), null)
    for (const id of requestIds.slice(1)) assert.ok(pendingRequestsManager.get(id))
  } finally {
    for (const id of requestIds) pendingRequestsManager.cancel(id)
  }
})

test('repeated connection focuses one approval and cancellation allows a fresh request', async () => {
  const handler = new DAppHandler()
  const createdBefore = approvalWindowCreates
  const focusedBefore = approvalWindowFocuses
  const opened = waitForApprovalOpened()
  const first = handler.requestExternalApproval('https://dapp.example', 'evmConnect', {
    accounts: []
  })
  await opened
  const requestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(requestId)

  const second = handler.requestExternalApproval('https://dapp.example', 'evmConnect', {
    accounts: []
  })
  assert.equal(
    (
      await sendApprovalMessage(requestId, {
        type: 'DAPP_APPROVAL_RESULT',
        success: false
      })
    ).success,
    true
  )
  assert.deepEqual(await Promise.all([first, second]), [
    { approved: false, requestId },
    { approved: false, requestId }
  ])
  assert.equal(approvalWindowCreates - createdBefore, 1)
  assert.equal(approvalWindowFocuses - focusedBefore, 1)
  assert.equal(listeners.size, 0)

  const reopened = waitForApprovalOpened()
  const retry = handler.requestExternalApproval('https://dapp.example', 'evmConnect', {
    accounts: []
  })
  await reopened
  const nextRequestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(nextRequestId)
  assert.notEqual(nextRequestId, requestId)
  await sendApprovalMessage(nextRequestId, { type: 'DAPP_APPROVAL_RESULT', success: false })
  assert.equal((await retry).approved, false)
  assert.equal(listeners.size, 0)
})

test('cancellation before window creation does not install approval listeners', async () => {
  const handler = new DAppHandler()
  const originalCreate = chrome.windows.create
  chrome.windows.create = (options, callback) => {
    approvalUrl = options.url
    const requestId = new URLSearchParams(options.url.split('?')[1]).get('requestId')
    assert.ok(requestId)
    pendingRequestsManager.cancel(requestId)
    callback({ id: 7 })
  }
  try {
    const decision = await handler.requestExternalApproval('https://dapp.example', 'evmConnect', {
      accounts: []
    })
    assert.equal(decision.approved, false)
    assert.equal(listeners.size, 0)
  } finally {
    chrome.windows.create = originalCreate
  }
})

test('approval popup retries invalid bounds and reports creation failure without user rejection', async () => {
  const handler = new DAppHandler()
  const originalGetLastFocused = chrome.windows.getLastFocused
  const originalCreate = chrome.windows.create
  const options = []
  chrome.windows.getLastFocused = async () => ({ left: 1000, top: 0, width: 1440 })
  chrome.windows.create = (createOptions, callback) => {
    options.push(createOptions)
    approvalUrl = createOptions.url
    if (options.length === 1) {
      chrome.runtime.lastError = {
        message:
          'Invalid value for bounds. Bounds must be at least 50% within visible screen space.'
      }
      callback(undefined)
      delete chrome.runtime.lastError
      return
    }
    callback({ id: 7 })
    notifyApprovalOpened?.()
    notifyApprovalOpened = undefined
  }
  try {
    const opened = waitForApprovalOpened()
    const approval = handler.requestExternalApproval('https://dapp.example', 'evmConnect', {
      accounts: []
    })
    await opened
    const requestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
    assert.ok(requestId)
    assert.equal(options.length, 2)
    assert.equal(typeof options[0].left, 'number')
    assert.equal(Object.hasOwn(options[1], 'left'), false)
    assert.equal(Object.hasOwn(options[1], 'top'), false)
    await sendApprovalMessage(requestId, { type: 'DAPP_APPROVAL_RESULT', success: false })
    assert.equal((await approval).approved, false)

    chrome.windows.create = (createOptions, callback) => {
      approvalUrl = createOptions.url
      chrome.runtime.lastError = { message: 'Window creation failed.' }
      callback(undefined)
      delete chrome.runtime.lastError
    }
    await assert.rejects(
      handler.requestExternalApproval('https://dapp.example', 'evmConnect', { accounts: [] }),
      /Wallet approval window could not be opened/
    )
    const failedRequestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
    assert.equal(pendingRequestsManager.get(failedRequestId), null)
    assert.equal(listeners.size, 0)
  } finally {
    chrome.windows.getLastFocused = originalGetLastFocused
    chrome.windows.create = originalCreate
    delete chrome.runtime.lastError
  }
})

test('concurrent connection requests from different sites leave only the later approval', async () => {
  const handler = new DAppHandler()
  const createdBefore = approvalWindowCreates
  const firstOpened = waitForApprovalOpened()
  const first = handler.requestExternalApproval('https://first.example', 'evmConnect', {
    accounts: []
  })
  const second = handler.requestExternalApproval('https://second.example', 'evmConnect', {
    accounts: []
  })
  await firstOpened
  const firstRequestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(firstRequestId)
  const secondOpened = waitForApprovalOpened()
  await secondOpened
  const secondRequestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(secondRequestId)
  assert.notEqual(secondRequestId, firstRequestId)
  assert.equal(approvalWindowCreates - createdBefore, 2)
  assert.equal((await first).approved, false)
  assert.equal(pendingRequestsManager.get(firstRequestId), null)
  assert.ok(pendingRequestsManager.get(secondRequestId))
  assert.equal(listeners.size, 1)
  await sendApprovalMessage(secondRequestId, { type: 'DAPP_APPROVAL_RESULT', success: false })
  assert.equal((await second).approved, false)
  assert.equal(listeners.size, 0)
})

test('approval cannot complete while its transaction fee review is changing', async () => {
  let completeFeeUpdate
  const feeUpdate = new Promise(resolve => {
    completeFeeUpdate = resolve
  })
  let completeCustomFeeUpdate
  const customFeeUpdate = new Promise(resolve => {
    completeCustomFeeUpdate = resolve
  })
  let completePrivacyUpdate
  const privacyUpdate = new Promise(resolve => {
    completePrivacyUpdate = resolve
  })
  const handler = new DAppHandler()
  const approvalOpened = waitForApprovalOpened()
  const approval = handler.requestExternalApproval(
    'https://dapp.example',
    'evmTransaction',
    { feeTier: 'standard' },
    {
      onNetworkFeeTierChange: () => feeUpdate,
      onEvmFeeSelectionChange: () => customFeeUpdate,
      onEvmTransferPrivacyChange: () => privacyUpdate
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
  const pendingPrivacyResponse = sendApprovalMessage(requestId, {
    type: 'DAPP_EVM_TRANSFER_PRIVACY_CHANGE',
    enabled: true
  })
  assert.deepEqual(
    await sendApprovalMessage(requestId, { type: 'DAPP_APPROVAL_RESULT', success: true }),
    { error: 'Wait for the network fee update to complete' }
  )
  assert.deepEqual(
    await sendApprovalMessage(requestId, {
      type: 'DAPP_EVM_FEE_SELECTION_CHANGE',
      feeSelection: { kind: 'tier', tier: 'fast' }
    }),
    { error: 'Wait for the network fee update to complete' }
  )
  const privateData = {
    sendPrivately: true,
    transferPrivacyRevision: 1,
    privateTransfer: { amountRaw: '101' }
  }
  completePrivacyUpdate(privateData)
  assert.deepEqual(await pendingPrivacyResponse, { data: privateData })
  assert.deepEqual(
    await sendApprovalMessage(requestId, {
      type: 'DAPP_APPROVAL_RESULT',
      success: true,
      transferPrivacyRevision: privateData.transferPrivacyRevision
    }),
    { success: true }
  )
  assert.deepEqual(await approval, {
    approved: true,
    requestId,
    transferPrivacyRevision: 1
  })
  assert.equal(listeners.size, 0)
})

test('rejection cancels an approval during privacy preparation and discards its late review', async () => {
  let completePrivacyUpdate
  const privacyUpdate = new Promise(resolve => {
    completePrivacyUpdate = resolve
  })
  const handler = new DAppHandler()
  const approvalOpened = waitForApprovalOpened()
  const approval = handler.requestExternalApproval(
    'https://dapp.example',
    'evmTransaction',
    { sendPrivately: false },
    { onEvmTransferPrivacyChange: () => privacyUpdate }
  )
  await approvalOpened
  const requestId = new URLSearchParams(approvalUrl.split('?')[1]).get('requestId')
  assert.ok(requestId)

  const pendingPrivacyResponse = sendApprovalMessage(requestId, {
    type: 'DAPP_EVM_TRANSFER_PRIVACY_CHANGE',
    enabled: true
  })
  assert.deepEqual(
    await sendApprovalMessage(requestId, { type: 'DAPP_APPROVAL_RESULT', success: false }),
    { success: true }
  )
  assert.equal((await approval).approved, false)
  assert.equal(listeners.size, 0)
  completePrivacyUpdate({ sendPrivately: true })
  assert.deepEqual(await pendingPrivacyResponse, { error: 'Approval request is no longer active' })
  assert.equal(pendingRequestsManager.get(requestId), null)
})
