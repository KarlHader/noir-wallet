import { test } from 'node:test'
import { expect } from '@playwright/test'
import { blake2b } from '@noble/hashes/blake2b'

import { BackgroundQuantusDAppHandler } from '../../../src/background/quantus-dapp-handler.ts'
import { bytesToHex, hexToBytes } from '../../../src/lib/bytes.ts'
import {
  parseQuantusBroadcastExtrinsicRequest,
  parseQuantusSendRequest
} from '../../../src/core/dapp/quantus-provider.ts'
import { QuantusTransferError } from '../../../src/infrastructure/chains/quantus/quantus-transfer-preparer.ts'

const origin = 'https://dapp.example'
const address = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'
const reference = { walletId: 'wallet:quantus:test', accountId: 'account:quantus:test:0' }
const chainId = 'quantus:planck'
const activeChainAccount = {
  id: 'chain-account:quantus:1',
  scope: { keyDomainId: reference.walletId, accountId: reference.accountId, chainId },
  derivation: { scheme: 'ml-dsa-87', path: "m/44'/189189'/0'" },
  identity: { kind: 'account-identifier', value: address },
  createdAt: 1
}
const transactionId = 'transaction:quantus:dapp-test'
const extrinsicHash = `0x${'ab'.repeat(32)}`
const payloadFingerprint = '33'.repeat(32)
// A signed-v4 SCALE envelope; only the node validates the signature and call.
const extrinsic = '0x088400'
const hash = `0x${bytesToHex(blake2b(hexToBytes(extrinsic), { dkLen: 32 }))}`

function reviewSummary({ recipient = address, amountRaw = '1000' } = {}) {
  return {
    schema: 'quantus.transfer.v1',
    chainId,
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      signerAddress: address,
      signerAccountId: `0x${'11'.repeat(32)}`,
      scheme: 'ml-dsa-87',
      recipient,
      amountRaw,
      feeLimitRaw: '10000000000',
      keepAlive: true,
      nonce: '0',
      tipRaw: '0',
      eraPeriod: 64,
      blockNumber: 1,
      callHash: `0x${'22'.repeat(32)}`,
      callLength: 20
    }
  }
}

function preparedTransfer(intent = {}) {
  return {
    graph: {
      root: {
        id: transactionId,
        scope: { keyDomainId: reference.walletId, accountId: reference.accountId },
        kind: 'transfer',
        status: 'prepared',
        revision: 1,
        updatedAt: 1
      },
      segments: [
        {
          id: 'segment:quantus:dapp-test',
          role: 'origin',
          status: 'prepared',
          revision: 1,
          target: { kind: 'onchain', chainId },
          events: []
        }
      ]
    },
    review: {
      chainId,
      operation: 'transaction',
      summary: reviewSummary(intent),
      payloadFingerprint: { algorithm: 'sha256', digestHex: payloadFingerprint },
      expiresAt: Date.now() + 60_000
    }
  }
}

function submittedGraph(status = 'broadcast') {
  return {
    root: {
      id: transactionId,
      scope: { keyDomainId: reference.walletId, accountId: reference.accountId },
      kind: 'transfer',
      status,
      revision: 2,
      updatedAt: 2
    },
    segments: [
      {
        id: 'segment:quantus:dapp-test',
        role: 'origin',
        status,
        revision: 2,
        target: { kind: 'onchain', chainId },
        events: [],
        evidence: { transactionHash: extrinsicHash }
      }
    ]
  }
}

function harness({
  attest = async () => {},
  authorized = true,
  unlocked = true,
  submit = async () => hash,
  transferController,
  approval
} = {}) {
  const calls = []
  const analytics = []
  const handler = new BackgroundQuantusDAppHandler({
    analytics: (name, options) => analytics.push({ name, options }),
    network: { chainId, networkMode: 'testnet', displayName: 'Planck' },
    manager: {
      getChainAuthorization: async () => {
        const isAuthorized = typeof authorized === 'function' ? authorized() : authorized
        return isAuthorized ? { accounts: [reference] } : null
      }
    },
    approval: approval ?? {},
    ...(transferController === undefined ? {} : { transferController }),
    loadActiveAccount: async () => ({
      keyDomainId: reference.walletId,
      accountId: reference.accountId,
      accountIndex: 0,
      address,
      publicKey: '0x1234',
      reference
    }),
    hasUnlockSession: async () => unlocked,
    runActiveOperation: operation => operation(),
    rpc: {
      async assertExpectedChain() {
        calls.push('attest')
        await attest()
      },
      async getAccountInfo() {
        calls.push('balance')
        return { free: 1n, reserved: 0n, nonce: 0 }
      },
      async submitExtrinsic(value) {
        calls.push(['submit', value])
        return submit(value)
      }
    }
  })
  return { handler, calls, analytics }
}

function sendHarness({
  decision = { approved: true },
  status = 'broadcast',
  prepare,
  approve,
  sign,
  authorizeContext = activeChainAccount,
  authorized = true,
  onApproval
} = {}) {
  const prepared = []
  const approved = []
  const signed = []
  const rejected = []
  const approvalCalls = []
  const transferController = {
    async prepare(intent) {
      prepared.push(intent)
      if (prepare) return prepare(intent)
      return preparedTransfer(intent)
    },
    async approveForDApp(id, fingerprint, authorize) {
      approved.push({ id, fingerprint })
      if (approve) return approve({ id, fingerprint, authorize })
      await authorize({
        chainAccount: authorizeContext,
        accountIndex: 0,
        keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
      })
      return {
        status,
        graph: submittedGraph(status === 'broadcast' ? 'broadcast' : 'signed')
      }
    },
    async findSignedOnlyForDApp() {
      return null
    },
    async signForDApp(id, fingerprint, authorize) {
      if (sign) return sign({ id, fingerprint, authorize })
      await authorize({
        chainAccount: authorizeContext,
        accountIndex: 0,
        keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
      })
      signed.push({ id, fingerprint })
      return {
        status: 'signed',
        signedExtrinsicHex: extrinsic,
        extrinsicHash: extrinsicHash,
        graph: submittedGraph('signed')
      }
    },
    async reject(id) {
      rejected.push(id)
      return { root: { id, status: 'failed' }, segments: [] }
    }
  }
  const approval = {
    async requestExternalApproval(requestOrigin, action, data) {
      approvalCalls.push({ origin: requestOrigin, action, data })
      if (onApproval) onApproval()
      return { approved: decision.approved, requestId: 'approval-1' }
    },
    async broadcastProviderEvent() {},
    cancelPendingApprovals() {
      return 0
    }
  }
  return {
    ...harness({ transferController, approval, authorized }),
    prepared,
    approved,
    signed,
    rejected,
    approvalCalls
  }
}

test('Quantus dApp recovers signed-only bytes for the same authorized intent without reopening approval', async () => {
  const state = sendHarness()
  state.handler.options.transferController.findSignedOnlyForDApp = async (
    intent,
    requestOrigin
  ) => {
    expect(intent).toEqual({ recipient: address, amountRaw: '2500', keepAlive: true })
    expect(requestOrigin).toBe(origin)
    return extrinsic
  }
  await expect(
    state.handler.request({ method: 'signQuantusTransfer', params: [address, '2500'] }, origin, {})
  ).resolves.toBe(extrinsic)
  expect(state.approvalCalls).toHaveLength(0)
  expect(state.prepared).toHaveLength(0)
  expect(state.signed).toHaveLength(0)
})

test('Quantus dApp balance attests the RPC before reading chain state', async () => {
  const state = harness()
  await expect(state.handler.request({ method: 'getBalance' }, origin, {})).resolves.toMatchObject({
    free: '1'
  })
  expect(state.calls).toEqual(['attest', 'balance'])
})

test('Quantus dApp relays an external signed envelope only after authorization and chain attestation', async () => {
  const state = harness()
  await expect(
    state.handler.request(
      { method: 'broadcastExtrinsic', params: [extrinsic.toUpperCase().replace('0X', '0x')] },
      origin,
      {}
    )
  ).resolves.toBe(hash)
  expect(state.calls).toEqual(['attest', ['submit', extrinsic]])
})

test('Quantus dApp does not submit when locked, disconnected, or on the wrong RPC chain', async () => {
  for (const settings of [{ authorized: false }, { unlocked: false }]) {
    const state = harness(settings)
    await expect(
      state.handler.request({ method: 'broadcastExtrinsic', params: [extrinsic] }, origin, {})
    ).rejects.toMatchObject({ code: 4100 })
    expect(state.calls).toEqual([])
  }
  const state = harness({
    attest: async () => {
      throw new Error('chain-mismatch')
    }
  })
  await expect(
    state.handler.request({ method: 'broadcastExtrinsic', params: [extrinsic] }, origin, {})
  ).rejects.toThrow('chain-mismatch')
  expect(state.calls).toEqual(['attest'])
})

test('Quantus dApp rechecks authorization after RPC attestation', async () => {
  let authorized = true
  const state = harness({
    authorized: () => authorized,
    attest: async () => {
      authorized = false
    }
  })
  await expect(
    state.handler.request({ method: 'broadcastExtrinsic', params: [extrinsic] }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
  expect(state.calls).toEqual(['attest'])
})

test('Quantus dApp rejects malformed or unsigned SCALE envelopes before RPC', async () => {
  const state = harness()
  for (const invalid of ['not-hex', '0x1234', '0x08840000', '0x080400', '0x088600']) {
    await expect(
      state.handler.request({ method: 'broadcastExtrinsic', params: [invalid] }, origin, {})
    ).rejects.toMatchObject({ code: -32602 })
  }
  expect(state.calls).toEqual([])
  expect(() => parseQuantusBroadcastExtrinsicRequest(['0x' + 'ff'.repeat(128 * 1024)])).toThrow()
})

test('Quantus dApp rejects a mismatched RPC hash and deduplicates in-flight identical bytes', async () => {
  const wrong = harness({ submit: async () => `0x${'a'.repeat(64)}` })
  await expect(
    wrong.handler.request({ method: 'broadcastExtrinsic', params: [extrinsic] }, origin, {})
  ).rejects.toMatchObject({ code: -32603 })
  expect(wrong.calls).toEqual(['attest', ['submit', extrinsic]])

  let release
  const state = harness({
    submit: () =>
      new Promise(resolve => {
        release = resolve
      })
  })
  const first = state.handler.request(
    { method: 'broadcastExtrinsic', params: [extrinsic] },
    origin,
    {}
  )
  const second = state.handler.request(
    { method: 'broadcastExtrinsic', params: [extrinsic] },
    origin,
    {}
  )
  // Wait for the submission before resolving it; both requests must share one RPC call.
  while (!release) await new Promise(resolve => setImmediate(resolve))
  release(hash)
  await expect(Promise.all([first, second])).resolves.toEqual([hash, hash])
  expect(state.calls).toEqual(['attest', ['submit', extrinsic]])
})

test('Quantus dApp reviews a fixed keep-alive native transfer and returns a submitted hash', async () => {
  const state = sendHarness()
  await expect(
    state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {
      favIconUrl: 'https://dapp.example/icon.png',
      pageUrl: 'https://dapp.example/app'
    })
  ).resolves.toBe(extrinsicHash)

  expect(state.prepared).toEqual([{ recipient: address, amountRaw: '1000', keepAlive: true }])
  expect(state.calls).toEqual([])
  expect(state.approvalCalls).toHaveLength(1)
  expect(state.approvalCalls[0]).toMatchObject({
    origin,
    action: 'quantusTransaction',
    data: {
      chainId,
      chainName: 'Planck',
      favicon: 'https://dapp.example/icon.png',
      faviconPageUrl: 'https://dapp.example/app'
    }
  })
  expect(state.approvalCalls[0].data.review.summary.schema).toBe('quantus.transfer.v1')
  expect(state.approved).toEqual([{ id: transactionId, fingerprint: payloadFingerprint }])
  expect(state.rejected).toEqual([])
  expect(state.analytics.map(entry => entry.name)).toContain('dapp_transaction_sent')
  expect(state.analytics.every(entry => entry.options.chain === 'quantus')).toBe(true)
})

test('Quantus dApp rejects invalid send arguments before preparing or approving', async () => {
  const state = sendHarness()
  const invalidParams = [
    [address],
    [address, '1000', 'extra'],
    [address, '0'],
    [address, '01'],
    [address, '1.5'],
    [address, '-1'],
    [address, '1000 '],
    [address, (2n ** 128n).toString()],
    ['not-an-ss58-address', '1000']
  ]
  for (const params of invalidParams) {
    await expect(
      state.handler.request({ method: 'sendQuantus', params }, origin, {})
    ).rejects.toMatchObject({ code: -32602 })
  }
  expect(state.prepared).toEqual([])
  expect(state.approvalCalls).toEqual([])
  expect(() => parseQuantusSendRequest([address, '1'])).not.toThrow()
})

test('Quantus dApp keeps sendQuantus closed for locked or unauthorized sites', async () => {
  for (const settings of [{ authorized: false }, { unlocked: false }]) {
    const state = harness({
      ...settings,
      transferController: {
        prepare: async () => {
          throw new Error('prepare must not run without authorization')
        }
      }
    })
    await expect(
      state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
    ).rejects.toMatchObject({ code: 4100 })
  }
})

test('Quantus dApp reports unavailable transfers when Quantus operations are off', async () => {
  const state = harness()
  await expect(
    state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4200 })
})

test('Quantus dApp cancels the reviewed transfer without signing when the user rejects', async () => {
  const state = sendHarness({ decision: { approved: false } })
  await expect(
    state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4001 })
  expect(state.approved).toEqual([])
  expect(state.rejected).toEqual([transactionId])
  expect(state.calls).toEqual([])
})

test('Quantus dApp refuses to sign after authorization changes during approval', async () => {
  let authorized = true
  const state = sendHarness({
    authorized: () => authorized,
    onApproval: () => (authorized = false)
  })
  await expect(
    state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
  expect(state.calls).toEqual([])
})

test('Quantus dApp refuses a confirmation bound to a different account scope', async () => {
  const state = sendHarness({
    authorizeContext: {
      ...activeChainAccount,
      scope: { ...activeChainAccount.scope, accountId: 'account:quantus:test:1' }
    }
  })
  await expect(
    state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
})

test('Quantus dApp reports a pending broadcast without a hash and keeps recovery alive', async () => {
  const state = sendHarness({ status: 'signed-pending-broadcast' })
  await expect(
    state.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4900 })
  expect(state.rejected).toEqual([])
  expect(state.analytics.map(entry => entry.name)).not.toContain('dapp_transaction_sent')
})

test('Quantus dApp maps preparation failures onto provider errors without approving', async () => {
  const insufficient = sendHarness({
    prepare: async () => {
      throw new QuantusTransferError('insufficient-funds', 'Quantus balance is insufficient')
    }
  })
  await expect(
    insufficient.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: -32603 })
  expect(insufficient.approvalCalls).toEqual([])

  const unavailable = sendHarness({
    prepare: async () => {
      throw new Error('The active Account has no Quantus ChainAccount')
    }
  })
  await expect(
    unavailable.handler.request({ method: 'sendQuantus', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
  expect(unavailable.approvalCalls).toEqual([])
})

test('Quantus dApp returns reviewed signed bytes without submitting or claiming a send', async () => {
  const state = sendHarness()
  await expect(
    state.handler.request({ method: 'signQuantusTransfer', params: [address, '2500'] }, origin, {})
  ).resolves.toBe(extrinsic)

  expect(state.prepared).toEqual([{ recipient: address, amountRaw: '2500', keepAlive: true }])
  expect(state.approvalCalls).toHaveLength(1)
  expect(state.approvalCalls[0]).toMatchObject({
    origin,
    action: 'quantusSignTransfer',
    data: { chainId, chainName: 'Planck', operation: 'sign-only' }
  })
  expect(state.signed).toEqual([{ id: transactionId, fingerprint: payloadFingerprint }])
  expect(state.approved).toEqual([])
  // No wallet broadcast path runs for a signed-only handoff.
  expect(state.calls).toEqual([])
  expect(state.rejected).toEqual([])
  expect(state.analytics.map(entry => entry.name)).not.toContain('dapp_transaction_sent')
})

test('Quantus dApp needs its own approval for a signed-only handoff', async () => {
  const state = sendHarness({ decision: { approved: false } })
  await expect(
    state.handler.request({ method: 'signQuantusTransfer', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4001 })
  expect(state.signed).toEqual([])
  expect(state.rejected).toEqual([transactionId])
})

test('Quantus dApp refuses to hand off bytes for a different transfer', async () => {
  const state = sendHarness({
    sign: async ({ authorize }) => {
      await authorize({
        chainAccount: activeChainAccount,
        accountIndex: 0,
        keyDomainSource: { kind: 'software', mnemonicWordCount: 24 }
      })
      return {
        status: 'signed',
        signedExtrinsicHex: extrinsic,
        extrinsicHash: extrinsicHash,
        graph: {
          ...submittedGraph('signed'),
          root: { ...submittedGraph('signed').root, id: 'transaction:quantus:other' }
        }
      }
    }
  })
  await expect(
    state.handler.request({ method: 'signQuantusTransfer', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: -32603 })
  expect(state.analytics.map(entry => entry.name)).not.toContain('dapp_transaction_sent')
})

test('Quantus dApp refuses signed-only handoff after account changes during approval', async () => {
  let authorized = true
  const state = sendHarness({
    authorized: () => authorized,
    onApproval: () => (authorized = false)
  })
  await expect(
    state.handler.request({ method: 'signQuantusTransfer', params: [address, '1000'] }, origin, {})
  ).rejects.toMatchObject({ code: 4100 })
  expect(state.signed).toEqual([])
})

test('Quantus dApp rejects signed-only arguments before preparing', async () => {
  const state = sendHarness()
  for (const params of [[address], [address, '0'], [address, '1000', 'extra'], ['nope', '1']]) {
    await expect(
      state.handler.request({ method: 'signQuantusTransfer', params }, origin, {})
    ).rejects.toMatchObject({ code: -32602 })
  }
  expect(state.prepared).toEqual([])
  expect(state.approvalCalls).toEqual([])
})
