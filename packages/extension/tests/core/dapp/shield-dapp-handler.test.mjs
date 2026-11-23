import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  handleShieldDAppRequest,
  resolveShieldDappScope
} from '../../../src/background/shield-dapp-handler.ts'
import { ShieldProviderError } from '../../../src/core/dapp/shield-provider.ts'

const scope = {
  network: 'mainnet',
  keyDomainId: 'wallet:one',
  accountId: 'account:one'
}
const operationId = 'd065c72d-9db6-411d-ab1b-f5e977b5c55a'
const site = 'https://shop.example'

function authorizedShieldInput(method, coordinator, extras = {}) {
  return {
    method,
    params: { layer: 'near-confidential' },
    coordinator,
    origin: site,
    scope,
    readScope: async () => scope,
    ...extras
  }
}

function grantedSite(input) {
  return {
    origin: site,
    readScope: async () => scope,
    ...input,
    coordinator: { shieldDappAuthorized: async () => true, ...input.coordinator }
  }
}

test('refresh status reads the stored Shield operation for the active account', async () => {
  let queried = null
  const result = await handleShieldDAppRequest(
    grantedSite({
      method: 'shield_getTransactionStatus',
      params: { layer: 'near-confidential', operationId },
      coordinator: {
        readShieldDappStatus: async input => {
          queried = input
          return {
            id: input.operationId,
            layer: 'near-confidential',
            action: 'receive',
            status: 'processing',
            providerStatus: 'PROCESSING'
          }
        }
      },
      scope
    })
  )

  assert.deepEqual(queried, { scope, operationId })
  assert.deepEqual(result, {
    id: operationId,
    layer: 'near-confidential',
    action: 'receive',
    status: 'processing',
    providerStatus: 'PROCESSING'
  })
})

test('public Shield transfer prepares, asks for approval, and confirms', async () => {
  const calls = []
  const result = await handleShieldDAppRequest(
    grantedSite({
      method: 'shield_transfer',
      params: {
        layer: 'near-confidential',
        token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10',
        destination: {
          kind: 'public',
          chainId: 'eip155:1',
          address: '0x1111111111111111111111111111111111111111'
        }
      },
      coordinator: {
        prepareShieldDappTransfer: async input => {
          calls.push(['prepare', input])
          return {
            planId: operationId,
            payloadFingerprint: 'a'.repeat(64),
            amount: '0.10',
            symbol: 'BNB',
            chainName: 'BNB Smart Chain',
            assetId: 'eip155:56/slip44:714',
            sourceAddress: '0x2222222222222222222222222222222222222222',
            expectedReceive: '0.05',
            expectedSymbol: 'ETH',
            quoteDifference: '0.001',
            destinationAddress: '0x1111111111111111111111111111111111111111',
            destinationChainName: 'Ethereum',
            destinationSymbol: 'ETH',
            destinationAssetId: 'eip155:1/slip44:60'
          }
        },
        confirm: async (planId, fingerprint) => {
          calls.push(['confirm', planId, fingerprint])
          return {
            planId,
            phase: 'authorized',
            operation: 'withdraw'
          }
        },
        reportStoredShieldDappPlan: plan => ({
          id: plan.planId,
          layer: 'near-confidential',
          action: 'transfer',
          status: 'authorized',
          source: {
            chainId: 'eip155:56',
            assetId: 'eip155:56/slip44:714',
            symbol: 'BNB',
            amount: '0.10'
          },
          destination: {
            chainId: 'eip155:1',
            assetId: 'eip155:1/slip44:60',
            symbol: 'ETH',
            amount: '0.05'
          },
          references: { transactionHashes: ['0xabc'], orderId: 'order-1' }
        }),
        cancel: async planId => {
          calls.push(['cancel', planId])
        }
      },
      scope,
      requestApproval: async (action, summary) => {
        calls.push(['approval', action, summary])
        return true
      }
    })
  )

  assert.equal(calls[0][0], 'prepare')
  assert.equal(calls[0][1].origin, site)
  assert.equal(calls[0][1].amount, '0.10')
  assert.equal(calls[0][1].destination.address, '0x1111111111111111111111111111111111111111')
  assert.equal(calls[1][0], 'approval')
  assert.equal(calls[1][1], 'shieldTransfer')
  assert.equal(calls[1][2].destinationChainName, 'Ethereum')
  assert.equal(calls[1][2].layer, 'near-confidential')
  assert.equal(calls[1][2].sourceAddress, '0x2222222222222222222222222222222222222222')
  assert.equal(calls[1][2].quoteDifference, '0.001')
  assert.equal(calls[1][2].networkFee, undefined)
  assert.equal(calls[1][2].planId, undefined)
  assert.equal(calls[2][0], 'confirm')
  assert.deepEqual(result, {
    id: operationId,
    layer: 'near-confidential',
    action: 'transfer',
    status: 'authorized',
    source: {
      chainId: 'eip155:56',
      assetId: 'eip155:56/slip44:714',
      symbol: 'BNB',
      amount: '0.10'
    },
    destination: {
      chainId: 'eip155:1',
      assetId: 'eip155:1/slip44:60',
      symbol: 'ETH',
      amount: '0.05'
    },
    references: { transactionHashes: ['0xabc'], orderId: 'order-1' }
  })
})

test('Shield receive approval shows the source account, quote, and network fee', async () => {
  let summary = null
  await handleShieldDAppRequest(
    grantedSite({
      method: 'shield_receive',
      params: {
        layer: 'near-confidential',
        source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10'
      },
      coordinator: {
        prepareShieldDappReceive: async () => ({
          planId: operationId,
          payloadFingerprint: 'b'.repeat(64),
          amount: '0.10',
          symbol: 'BNB',
          chainName: 'BNB Smart Chain',
          assetId: 'eip155:56/slip44:714',
          sourceAddress: '0x2222222222222222222222222222222222222222',
          expectedReceive: '0.099',
          expectedSymbol: 'BNB',
          quoteDifference: '0.001',
          networkFee: '0.0001',
          networkFeeSymbol: 'BNB'
        }),
        confirm: async () => ({ planId: operationId, operation: 'deposit', phase: 'authorized' }),
        reportStoredShieldDappPlan: plan => ({
          id: plan.planId,
          layer: 'near-confidential',
          action: 'receive',
          status: 'authorized'
        }),
        cancel: async () => {
          throw new Error('not called')
        }
      },
      scope,
      requestApproval: async (action, approval) => {
        summary = { action, approval }
        return true
      }
    })
  )

  assert.deepEqual(summary, {
    action: 'shieldReceive',
    approval: {
      layer: 'near-confidential',
      amount: '0.10',
      symbol: 'BNB',
      chainName: 'BNB Smart Chain',
      assetId: 'eip155:56/slip44:714',
      sourceAddress: '0x2222222222222222222222222222222222222222',
      expectedReceive: '0.099',
      expectedSymbol: 'BNB',
      quoteDifference: '0.001',
      networkFee: '0.0001',
      networkFeeSymbol: 'BNB'
    }
  })
})

test('rejected Shield receive cancels the prepared plan and returns 4001', async () => {
  const calls = []
  await assert.rejects(
    handleShieldDAppRequest(
      grantedSite({
        method: 'shield_receive',
        params: {
          layer: 'near-confidential',
          source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
          amount: '0.10'
        },
        coordinator: {
          prepareShieldDappReceive: async () => {
            calls.push('prepare')
            return {
              planId: operationId,
              payloadFingerprint: 'c'.repeat(64),
              amount: '0.10',
              symbol: 'BNB',
              chainName: 'BNB Smart Chain',
              assetId: 'eip155:56/slip44:714',
              sourceAddress: '0x2222222222222222222222222222222222222222',
              expectedReceive: '0.099',
              expectedSymbol: 'BNB'
            }
          },
          cancel: async planId => {
            calls.push(['cancel', planId])
          },
          confirm: async () => {
            throw new Error('not called')
          },
          reportStoredShieldDappPlan: () => {
            throw new Error('not called')
          }
        },
        scope,
        requestApproval: async () => false
      })
    ),
    error => error instanceof ShieldProviderError && error.code === 4001
  )
  assert.deepEqual(calls, ['prepare', ['cancel', operationId]])
})

test('confidential Shield transfer accepts another EVM account', async () => {
  const accountId = '0x3333333333333333333333333333333333333333'
  const calls = []
  await handleShieldDAppRequest(
    grantedSite({
      method: 'shield_getQuote',
      params: {
        layer: 'near-confidential',
        action: 'transfer',
        token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10',
        destination: { kind: 'confidential', accountId }
      },
      coordinator: {
        quoteShieldDapp: async input => {
          calls.push(input.destination)
          return {
            layer: 'near-confidential',
            action: 'transfer',
            amount: '0.10',
            fee: '0',
            expectedReceive: '0.10',
            expiresAt: 1,
            source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714', symbol: 'BNB' },
            destination: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714', symbol: 'BNB' }
          }
        }
      },
      scope
    })
  )
  const prepared = await handleShieldDAppRequest(
    grantedSite({
      method: 'shield_transfer',
      params: {
        layer: 'near-confidential',
        token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10',
        destination: {
          kind: 'confidential',
          accountId,
          chainId: 'eip155:1'
        }
      },
      coordinator: {
        prepareShieldDappTransfer: async input => {
          calls.push(input.destination)
          return {
            planId: operationId,
            payloadFingerprint: 'c'.repeat(64),
            amount: '0.10',
            symbol: 'BNB',
            chainName: 'BNB Smart Chain',
            assetId: 'eip155:56/slip44:714',
            destinationAddress: accountId,
            destinationChainName: 'NEAR Confidential',
            destinationSymbol: 'BNB',
            destinationAssetId: 'eip155:56/slip44:714',
            sourceAddress: '0x2222222222222222222222222222222222222222',
            expectedReceive: '0.099',
            expectedSymbol: 'BNB'
          }
        },
        confirm: async () => ({ planId: operationId, operation: 'confidential-transfer' }),
        reportStoredShieldDappPlan: () => ({
          id: operationId,
          layer: 'near-confidential',
          action: 'transfer',
          status: 'authorized'
        }),
        cancel: async () => {
          throw new Error('not called')
        }
      },
      scope,
      requestApproval: async (_action, summary) => {
        calls.push(summary.destinationChainName)
        return true
      }
    })
  )
  assert.deepEqual(calls, [
    { kind: 'confidential', accountId },
    {
      kind: 'confidential',
      accountId,
      chainId: 'eip155:1'
    },
    'NEAR Confidential'
  ])
  assert.equal(prepared.status, 'authorized')
})

test('confidential Shield transfer returns a started plan without confirming again', async () => {
  const calls = []
  const report = await handleShieldDAppRequest(
    grantedSite({
      method: 'shield_transfer',
      params: {
        layer: 'near-confidential',
        token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10',
        destination: {
          kind: 'confidential',
          accountId: '0x3333333333333333333333333333333333333333'
        }
      },
      coordinator: {
        prepareShieldDappTransfer: async () => ({
          planId: operationId,
          phase: 'submitting',
          payloadFingerprint: 'c'.repeat(64),
          amount: '0.10',
          symbol: 'BNB',
          chainName: 'BNB Smart Chain',
          assetId: 'eip155:56/slip44:714',
          destinationAddress: '0x3333333333333333333333333333333333333333',
          destinationChainName: 'NEAR Confidential',
          destinationSymbol: 'BNB',
          destinationAssetId: 'eip155:56/slip44:714',
          sourceAddress: '0x2222222222222222222222222222222222222222',
          expectedReceive: '0.099',
          expectedSymbol: 'BNB'
        }),
        getPlan: async planId => {
          calls.push(['get', planId])
          return { planId, phase: 'submitting' }
        },
        reportStoredShieldDappPlan: plan => ({
          id: plan.planId,
          layer: 'near-confidential',
          action: 'transfer',
          status: 'submitting'
        }),
        confirm: async () => {
          throw new Error('not called')
        }
      },
      scope,
      requestApproval: async () => {
        throw new Error('not called')
      }
    })
  )
  assert.deepEqual(calls, [['get', operationId]])
  assert.equal(report.status, 'submitting')
})

test('Shield transfer rejects a selected destination token', async () => {
  await assert.rejects(
    handleShieldDAppRequest(
      grantedSite({
        method: 'shield_transfer',
        params: {
          layer: 'near-confidential',
          token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
          amount: '0.10',
          destination: {
            kind: 'public',
            chainId: 'eip155:1',
            assetId: 'eip155:1/slip44:60',
            address: '0x1111111111111111111111111111111111111111'
          }
        },
        coordinator: {
          prepareShieldDappTransfer: async () => {
            throw new Error('not called')
          }
        },
        scope,
        requestApproval: async () => true
      })
    ),
    error =>
      error instanceof ShieldProviderError &&
      error.code === -32602 &&
      error.message === 'Shield destination token cannot be selected.'
  )
})

test('confidential Shield transfer rejects a non-EVM or zero account', async () => {
  for (const accountId of ['someone.near', '0x0000000000000000000000000000000000000000']) {
    await assert.rejects(
      handleShieldDAppRequest(
        grantedSite({
          method: 'shield_transfer',
          params: {
            layer: 'near-confidential',
            token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
            amount: '0.10',
            destination: { kind: 'confidential', accountId }
          },
          coordinator: {
            prepareShieldDappTransfer: async () => {
              throw new Error('not called')
            }
          },
          scope,
          requestApproval: async () => true
        })
      ),
      error => error instanceof ShieldProviderError && error.code === -32602
    )
  }
})

test('status refresh rejects a missing or malformed operation id', async () => {
  const coordinator = {
    readShieldDappStatus: async () => {
      throw new Error('not called')
    }
  }
  await assert.rejects(
    handleShieldDAppRequest(
      grantedSite({
        method: 'shield_getTransactionStatus',
        params: { layer: 'near-confidential' },
        coordinator,
        scope
      })
    ),
    error => error instanceof ShieldProviderError && error.code === -32602
  )
  await assert.rejects(
    handleShieldDAppRequest(
      grantedSite({
        method: 'shield_getTransactionStatus',
        params: { layer: 'near-confidential', operationId: 'not an id' },
        coordinator,
        scope
      })
    ),
    error => error instanceof ShieldProviderError && error.code === -32602
  )
})

test('imported EVM account supplies a Shield scope after the retained pointer is cleared', () => {
  assert.deepEqual(
    resolveShieldDappScope({
      network: 'mainnet',
      activeAccount: { walletId: 'wallet:private-key-v2:evm', accountId: 'account:evm' },
      retainedWalletId: null,
      retainedAccountId: null
    }),
    {
      network: 'mainnet',
      keyDomainId: 'wallet:private-key-v2:evm',
      accountId: 'account:evm'
    }
  )
})

test('Shield scope stays empty when neither active nor retained account is selected', () => {
  assert.equal(
    resolveShieldDappScope({
      network: 'mainnet',
      activeAccount: null,
      retainedWalletId: null,
      retainedAccountId: null
    }),
    null
  )
})

test('an unauthorized site cannot refresh Shield balances or create a session', async () => {
  let refreshed = false
  await assert.rejects(
    () =>
      handleShieldDAppRequest(
        authorizedShieldInput('shield_refreshBalances', {
          shieldDappAuthorized: async () => false,
          refreshShieldDappBalances: async () => {
            refreshed = true
            return []
          },
          grantShieldDapp: async () => {
            throw new Error('session must not be created')
          }
        })
      ),
    error => error instanceof ShieldProviderError && error.code === 4100
  )
  assert.equal(refreshed, false)
})

test('an unauthorized site cannot quote, read status, receive, or transfer', async () => {
  const touched = []
  const coordinator = {
    shieldDappAuthorized: async () => false,
    quoteShieldDapp: async () => touched.push('quote'),
    readShieldDappStatus: async () => touched.push('status'),
    prepareShieldDappReceive: async () => touched.push('receive'),
    prepareShieldDappTransfer: async () => touched.push('transfer')
  }
  const requests = [
    [
      'shield_getQuote',
      {
        layer: 'near-confidential',
        action: 'receive',
        amount: '0.10',
        source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' }
      }
    ],
    ['shield_getTransactionStatus', { layer: 'near-confidential', operationId }],
    [
      'shield_receive',
      {
        layer: 'near-confidential',
        source: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10'
      }
    ],
    [
      'shield_transfer',
      {
        layer: 'near-confidential',
        token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
        amount: '0.10',
        destination: {
          kind: 'public',
          chainId: 'eip155:1',
          address: '0x1111111111111111111111111111111111111111'
        }
      }
    ]
  ]
  for (const [method, params] of requests) {
    await assert.rejects(
      handleShieldDAppRequest(
        authorizedShieldInput(method, coordinator, {
          params,
          requestApproval: async () => true
        })
      ),
      error => error instanceof ShieldProviderError && error.code === 4100
    )
  }
  assert.deepEqual(touched, [])
})

test('a Shield transfer revoked during approval is cancelled before confirmation', async () => {
  const calls = []
  let authorized = true
  await assert.rejects(
    handleShieldDAppRequest(
      authorizedShieldInput(
        'shield_transfer',
        {
          shieldDappAuthorized: async () => authorized,
          prepareShieldDappTransfer: async () => ({
            planId: operationId,
            payloadFingerprint: 'd'.repeat(64),
            amount: '0.10',
            symbol: 'BNB',
            chainName: 'BNB Smart Chain',
            assetId: 'eip155:56/slip44:714',
            sourceAddress: '0x2222222222222222222222222222222222222222',
            expectedReceive: '0.05',
            expectedSymbol: 'ETH',
            destinationAddress: '0x1111111111111111111111111111111111111111',
            destinationChainName: 'Ethereum'
          }),
          cancel: async planId => {
            calls.push(['cancel', planId])
          },
          confirm: async () => {
            calls.push('confirm')
          }
        },
        {
          params: {
            layer: 'near-confidential',
            token: { chainId: 'eip155:56', assetId: 'eip155:56/slip44:714' },
            amount: '0.10',
            destination: {
              kind: 'public',
              chainId: 'eip155:1',
              address: '0x1111111111111111111111111111111111111111'
            }
          },
          requestApproval: async () => {
            authorized = false
            return true
          }
        }
      )
    ),
    error => error instanceof ShieldProviderError && error.code === 4100
  )
  assert.deepEqual(calls, [['cancel', operationId]])
})

test('Shield connect unlocks and retries the grant without asking again', async () => {
  const calls = []
  let locked = true
  const result = await handleShieldDAppRequest(
    authorizedShieldInput(
      'shield_connect',
      {
        grantShieldDapp: async (origin, granted) => {
          calls.push(['grant', origin, granted])
          if (locked) throw new Error('Wallet is locked')
        }
      },
      {
        requestApproval: async action => {
          calls.push(['approval', action])
          return true
        },
        unlock: async () => {
          calls.push('unlock')
          locked = false
        }
      }
    )
  )
  assert.deepEqual(calls, [
    ['approval', 'shieldConnect'],
    ['grant', site, scope],
    'unlock',
    ['grant', site, scope]
  ])
  assert.deepEqual(result, { layer: 'near-confidential', connected: true })
})

test('Shield connect records the site only after approval', async () => {
  const calls = []
  const coordinator = {
    grantShieldDapp: async (origin, granted) => {
      calls.push(['grant', origin, granted])
    }
  }
  await assert.rejects(
    () =>
      handleShieldDAppRequest(
        authorizedShieldInput('shield_connect', coordinator, {
          requestApproval: async () => false
        })
      ),
    error => error instanceof ShieldProviderError && error.code === 4001
  )
  assert.deepEqual(calls, [])

  const result = await handleShieldDAppRequest(
    authorizedShieldInput('shield_connect', coordinator, {
      requestApproval: async (action, summary) => {
        calls.push(['approval', action, summary])
        return true
      }
    })
  )
  assert.deepEqual(calls, [
    ['approval', 'shieldConnect', { layer: 'near-confidential' }],
    ['grant', site, scope]
  ])
  assert.deepEqual(result, { layer: 'near-confidential', connected: true })
})

test('Shield disconnect revokes only the current site', async () => {
  let revoked = null
  const result = await handleShieldDAppRequest(
    authorizedShieldInput('shield_disconnect', {
      revokeShieldDapp: async (origin, revokedScope) => {
        revoked = { origin, revokedScope }
      },
      closeShieldDappSession: async () => {
        throw new Error('account session must stay')
      }
    })
  )
  assert.deepEqual(revoked, { origin: site, revokedScope: scope })
  assert.deepEqual(result, { layer: 'near-confidential', connected: false })
})

test('an authorized site refreshes Shield balances without creating a session', async () => {
  let authorize = null
  const result = await handleShieldDAppRequest(
    authorizedShieldInput('shield_refreshBalances', {
      shieldDappAuthorized: async (origin, granted) => origin === site && granted === scope,
      refreshShieldDappBalances: async (granted, shouldAuthorize) => {
        authorize = { granted, shouldAuthorize }
        return [{ chainId: 'eip155:1', symbol: 'ETH', amount: '1' }]
      }
    })
  )
  assert.deepEqual(authorize, { granted: scope, shouldAuthorize: false })
  assert.equal(result.balances.length, 1)
})

test('Shield scope prefers the Storage V2 account over a stale retained pointer', () => {
  assert.deepEqual(
    resolveShieldDappScope({
      network: 'mainnet',
      activeAccount: { walletId: 'wallet:private-key-v2:evm', accountId: 'account:evm' },
      retainedWalletId: 'wallet:mnemonic',
      retainedAccountId: 'account:mnemonic'
    }),
    {
      network: 'mainnet',
      keyDomainId: 'wallet:private-key-v2:evm',
      accountId: 'account:evm'
    }
  )
})
