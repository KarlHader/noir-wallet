import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBetaInviteRequired } from '../../../src/config/beta-invite.ts'
import {
  BetaInviteActivationCoordinator,
  getBetaInviteErrorMessage,
  parseBetaInviteCode,
  selectBetaInviteTarget
} from '../../../src/core/wallet/beta-invite.ts'
import {
  bindBetaInviteCode,
  checkBetaInviteCode
} from '../../../src/infrastructure/wallet/beta-invite-api.ts'
import { FetchTimeoutError } from '../../../src/lib/fetch-utils.ts'
import {
  inviteBindingErrorMessage,
  inviteCheckErrorMessage
} from '../../../src/popup/services/beta-invite-error.ts'

const response = payload => Response.json(payload)
const fetchResult = payload => async () => response(payload)

test('invite gate is enabled for Beta and explicitly opted-in development only', () => {
  assert.equal(resolveBetaInviteRequired('beta'), true)
  assert.equal(resolveBetaInviteRequired('production', '1'), false)
  assert.equal(resolveBetaInviteRequired('development', '1'), true)
  assert.equal(resolveBetaInviteRequired('development', 'true'), false)
})

test('disabled activation never reads storage or calls the service', async () => {
  const unexpected = () => {
    throw new Error('Disabled activation performed I/O')
  }
  const activation = new BetaInviteActivationCoordinator({
    required: false,
    readState: unexpected,
    writeState: unexpected,
    checkCode: unexpected,
    bindCode: unexpected,
    resolveTarget: unexpected
  })
  assert.equal(await activation.isActivated(), true)
  assert.equal((await activation.check('ANY')).required, false)
  assert.equal((await activation.bind()).required, false)
})

test('invite input is trimmed without assuming a server-side alphabet', () => {
  assert.equal(parseBetaInviteCode('  Invite-42_é  '), 'Invite-42_é')
  for (const value of ['', '  ', 'A\nB', 'x'.repeat(257)]) {
    assert.throws(() => parseBetaInviteCode(value), { code: 'invalid-code' })
  }
})

test('check rejects unavailable and used codes, even when HTTP succeeds', async () => {
  await assert.rejects(
    checkBetaInviteCode('ABC123', fetchResult({ code: 0, data: { exists: false, bound: false } })),
    { code: 'invalid-code' }
  )
  await assert.rejects(
    checkBetaInviteCode('ABC123', fetchResult({ code: 0, data: { exists: true, bound: true } })),
    { code: 'used-code' }
  )
  await assert.rejects(
    checkBetaInviteCode('ABC123', fetchResult({ code: 0, data: { exists: true } })),
    { code: 'service-unavailable' }
  )
})

test('bind requires exact successful response and maps business errors', async () => {
  const calls = []
  await bindBetaInviteCode('ABC123', '0xaddress', async (url, init) => {
    calls.push({ url, init })
    return response({ code: 0, data: { code: 'ABC123', bound: true } })
  })
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { wallet_address: '0xaddress' })
  for (const payload of [
    { code: 0, data: { code: 'OTHER', bound: true } },
    { code: 0, data: { code: 'ABC123', bound: false } },
    { code: 0, data: null }
  ]) {
    await assert.rejects(bindBetaInviteCode('ABC123', '0xaddress', fetchResult(payload)))
  }
  await assert.rejects(
    bindBetaInviteCode(
      'ABC123',
      '0xaddress',
      fetchResult({ code: 2004, message: 'invite code has already been bound' })
    ),
    { code: 'used-code' }
  )
  await assert.rejects(
    bindBetaInviteCode('ABC123', '0xaddress', fetchResult({ code: 4004, message: 'missing' })),
    { code: 'invalid-code' }
  )
  const timeout = new FetchTimeoutError(10_000)
  await assert.rejects(
    bindBetaInviteCode('Invite-42_é', '0xaddress', async () => {
      throw timeout
    }),
    error => {
      assert.equal(error.code, 'timeout')
      assert.equal(getBetaInviteErrorMessage(error), 'Invite request timed out. Try again.')
      assert.equal(error.message.includes('Invite-42_é'), false)
      assert.equal(inviteBindingErrorMessage(error), 'Invite request timed out. Try again.')
      return true
    }
  )
  await assert.rejects(
    checkBetaInviteCode('Invite-42_é', async () => {
      throw timeout
    }),
    error => {
      assert.equal(error.code, 'timeout')
      assert.equal(inviteCheckErrorMessage(error), 'Invite request timed out. Try again.')
      return true
    }
  )
  await assert.rejects(
    bindBetaInviteCode('Invite-42_é', '0xaddress', async () => {
      throw new Error('Network failed at https://api.zknoir.com/Invite-42_é/bind')
    }),
    error => {
      assert.equal(error.code, 'service-unavailable')
      assert.equal(getBetaInviteErrorMessage(error), 'Invite service is unavailable. Try again.')
      return true
    }
  )
  assert.equal(
    inviteBindingErrorMessage(new Error('Enter a valid invite code.')),
    'Enter a valid invite code.'
  )
})

test('explicit wallet-address confirmation restores access while unknown conflicts stay generic', async () => {
  await bindBetaInviteCode(
    'UNUSED',
    '0xaddress',
    fetchResult({ code: 2004, message: 'wallet address has already been bound' })
  )
  for (const payload of [
    { code: 2005, message: 'wallet address has already been bound' },
    { code: '2004', message: 'wallet address has already been bound' },
    { message: 'wallet address has already been bound' },
    { code: 0, data: { code: 'UNUSED', bound: false, walletAlreadyBound: true } }
  ]) {
    await assert.rejects(bindBetaInviteCode('UNUSED', '0xaddress', fetchResult(payload)))
  }
  await assert.rejects(
    bindBetaInviteCode('UNUSED', '0xaddress', async () =>
      Response.json(
        { code: 2004, message: 'wallet address has already been bound' },
        { status: 500 }
      )
    ),
    { code: 'service-unavailable' }
  )
  for (const message of ['bound', undefined, { detail: 'wallet address has already been bound' }]) {
    await assert.rejects(
      bindBetaInviteCode('UNUSED', '0xaddress', fetchResult({ code: 2004, message })),
      { code: 'binding-failed' }
    )
  }
  await assert.rejects(
    checkBetaInviteCode(
      'UNUSED',
      fetchResult({ code: 2004, message: 'wallet address has already been bound' })
    ),
    { code: 'service-unavailable' }
  )
})

test('address confirmation restores activation after interrupted persistence and survives reinstall', async () => {
  let state
  let addressBound = false
  let persistedSuccessFails = true
  const target = { walletId: 'wallet', accountId: 'account', walletAddress: '0xexisting' }
  const binds = []
  const make = () =>
    new BetaInviteActivationCoordinator({
      required: true,
      readState: async () => state,
      writeState: async next => {
        if (next.phase === 'activated' && persistedSuccessFails) {
          throw new Error('Activation persistence interrupted')
        }
        state = structuredClone(next)
      },
      checkCode: code =>
        checkBetaInviteCode(code, fetchResult({ code: 0, data: { exists: true, bound: false } })),
      bindCode: (code, address) =>
        bindBetaInviteCode(code, address, async () => {
          binds.push([code, address])
          if (addressBound) {
            return response({ code: 2004, message: 'wallet address has already been bound' })
          }
          addressBound = true
          return response({ code: 0, data: { code, bound: true } })
        }),
      resolveTarget: async () => target
    })
  await make().check('FIRST')
  await assert.rejects(make().bind(), /Activation persistence interrupted/)
  assert.equal(await make().isActivated(), false)
  persistedSuccessFails = false
  assert.deepEqual((await make().bind()).state, {
    phase: 'activated',
    walletAddress: target.walletAddress
  })
  const requestCount = binds.length
  await make().bind()
  assert.equal(binds.length, requestCount)
  state = undefined
  await make().check('NEW-INSTALLATION')
  assert.equal((await make().bind()).state.phase, 'activated')
  assert.deepEqual(binds, [
    ['FIRST', target.walletAddress],
    ['FIRST', target.walletAddress],
    ['NEW-INSTALLATION', target.walletAddress]
  ])
})

test('used-code conflicts never activate a wallet even when the code check was unused', async () => {
  let state
  const activation = new BetaInviteActivationCoordinator({
    required: true,
    readState: async () => state,
    writeState: async next => {
      state = structuredClone(next)
    },
    checkCode: code =>
      checkBetaInviteCode(code, fetchResult({ code: 0, data: { exists: true, bound: false } })),
    bindCode: (code, address) =>
      bindBetaInviteCode(
        code,
        address,
        fetchResult({ code: 2004, message: 'invite code has already been bound' })
      ),
    resolveTarget: async () => ({
      walletId: 'wallet',
      accountId: 'account',
      walletAddress: '0xaddress'
    })
  })
  await activation.check('USED')
  await assert.rejects(activation.bind(), { code: 'used-code' })
  assert.equal(await activation.isActivated(), false)
  assert.equal(state.phase, 'verified')
})

function coordinator(options = {}) {
  let state
  const writes = []
  const binds = []
  let bindFailure = false
  let target = { walletId: 'wallet-1', accountId: 'account-5', walletAddress: '0xfirst' }
  const make = () =>
    new BetaInviteActivationCoordinator({
      required: true,
      readState: async () => state,
      writeState: async next => {
        state = structuredClone(next)
        writes.push(state)
      },
      checkCode: async code => {
        if (code === 'BAD') throw Object.assign(new Error('Invalid'), { code: 'invalid-code' })
      },
      bindCode: async (code, address) => {
        binds.push([code, address])
        if (bindFailure) throw new Error('offline')
      },
      resolveTarget: async () => options.target ?? target
    })
  return {
    make,
    writes,
    binds,
    setBindFailure: value => {
      bindFailure = value
    },
    setTarget: value => {
      target = value
    }
  }
}

test('verification survives restart; changing code retains the pinned wallet after a failed bind', async () => {
  const fixture = coordinator()
  const first = fixture.make()
  await assert.rejects(first.bind(), { code: 'verification-required' })
  await first.check('ABC123')
  await assert.rejects(first.check('BAD'))
  assert.equal((await first.getStatus()).state.inviteCode, 'ABC123')
  fixture.setBindFailure(true)
  await assert.rejects(first.bind())
  assert.deepEqual((await fixture.make().getStatus()).state.target, {
    walletId: 'wallet-1',
    accountId: 'account-5',
    walletAddress: '0xfirst'
  })
  fixture.setTarget({ walletId: 'wallet-2', accountId: 'account-0', walletAddress: '0xsecond' })
  await fixture.make().check('NEW456')
  assert.deepEqual((await first.getStatus()).state.target, {
    walletId: 'wallet-1',
    accountId: 'account-5',
    walletAddress: '0xfirst'
  })
  fixture.setBindFailure(false)
  const second = fixture.make()
  assert.equal((await second.bind()).state.phase, 'activated')
  assert.deepEqual(fixture.binds, [
    ['ABC123', '0xfirst'],
    ['NEW456', '0xfirst']
  ])
  assert.equal(await second.isActivated(), true)
  await second.check('ANOTHER')
  await second.bind()
  assert.equal(fixture.binds.length, 2)
})

test('concurrent binds share one request and code checks retain call order', async () => {
  const fixture = coordinator()
  const activation = fixture.make()
  await Promise.all([activation.check('FIRST'), activation.check('SECOND')])
  assert.equal((await activation.getStatus()).state.inviteCode, 'SECOND')
  await Promise.all([activation.bind(), activation.bind()])
  assert.deepEqual(fixture.binds, [['SECOND', '0xfirst']])
})

test('a code change waits for an in-flight bind and keeps its original target after failure', async () => {
  let state
  let target = { walletId: 'wallet-1', accountId: 'account-5', walletAddress: '0xfirst' }
  const requests = []
  let signalStarted
  let rejectBinding
  const started = new Promise(resolve => {
    signalStarted = resolve
  })
  const heldBinding = new Promise((_, reject) => {
    rejectBinding = reject
  })
  const activation = new BetaInviteActivationCoordinator({
    required: true,
    readState: async () => state,
    writeState: async next => {
      state = structuredClone(next)
    },
    checkCode: async () => {},
    bindCode: async (code, address) => {
      requests.push([code, address])
      if (code === 'FIRST') {
        signalStarted()
        await heldBinding
      }
    },
    resolveTarget: async () => target
  })
  await activation.check(' FIRST ')
  const binding = activation.bind()
  await started
  target = { walletId: 'wallet-2', accountId: 'account-0', walletAddress: '0xsecond' }
  const changingCode = activation.check('SECOND')
  assert.equal((await activation.getStatus()).state.inviteCode, 'FIRST')
  rejectBinding(new Error('Request failed'))
  await assert.rejects(binding)
  assert.deepEqual((await changingCode).state.target, {
    walletId: 'wallet-1',
    accountId: 'account-5',
    walletAddress: '0xfirst'
  })
  await activation.bind()
  assert.deepEqual(requests, [
    ['FIRST', '0xfirst'],
    ['SECOND', '0xfirst']
  ])
})

test('normalized invite code is used for both request path and bind success comparison', async () => {
  const code = 'Invite-42_é'
  const requested = []
  const activation = new BetaInviteActivationCoordinator({
    required: true,
    readState: async () => undefined,
    writeState: async () => {},
    checkCode: async normalized => {
      await checkBetaInviteCode(normalized, async url => {
        requested.push(url)
        return response({ code: 0, data: { exists: true, bound: false } })
      })
    },
    bindCode: async () => {},
    resolveTarget: async () => null
  })
  assert.equal((await activation.check(` ${code} `)).state.inviteCode, code)
  assert.equal(requested[0].endsWith('/Invite-42_%C3%A9/check'), true)
  await bindBetaInviteCode(code, '0xaddress', fetchResult({ code: 0, data: { code, bound: true } }))
})

test('binding cannot reach the service until its target is persisted', async () => {
  let state
  let bindCalls = 0
  const activation = new BetaInviteActivationCoordinator({
    required: true,
    readState: async () => state,
    writeState: async next => {
      if (next.phase === 'verified' && next.target) throw new Error('Storage unavailable')
      state = next
    },
    checkCode: async () => {},
    bindCode: async () => {
      bindCalls += 1
    },
    resolveTarget: async () => ({
      walletId: 'wallet',
      accountId: 'account',
      walletAddress: '0xaddress'
    })
  })
  await activation.check('ABC')
  await assert.rejects(activation.bind(), /Storage unavailable/)
  assert.equal(bindCalls, 0)
  assert.equal((await activation.getStatus()).state.phase, 'verified')
})

function snapshot(source = { kind: 'software' }, addresses = []) {
  return {
    keyDomains: [
      { id: 'new-wallet', createdAt: 20, source },
      { id: 'first-wallet', createdAt: 10, source }
    ],
    accounts: [
      { id: 'account-9', keyDomainId: 'first-wallet', accountIndex: 9 },
      { id: 'account-5', keyDomainId: 'first-wallet', accountIndex: 5 },
      { id: 'account-0', keyDomainId: 'new-wallet', accountIndex: 0 }
    ],
    chainAccounts: [
      {
        id: 'evm-5',
        scope: { keyDomainId: 'first-wallet', accountId: 'account-5', chainId: 'eip155:1' }
      },
      {
        id: 'evm-9',
        scope: { keyDomainId: 'first-wallet', accountId: 'account-9', chainId: 'eip155:1' }
      },
      {
        id: 'evm-new',
        scope: { keyDomainId: 'new-wallet', accountId: 'account-0', chainId: 'eip155:1' }
      },
      {
        id: 'zcash-5',
        scope: {
          keyDomainId: 'first-wallet',
          accountId: 'account-5',
          chainId: 'bip122:00040fe8ec8471911baa1db1266ea15d'
        }
      }
    ],
    addresses
  }
}

const chains = { evmChainIds: ['eip155:1'], solanaChainId: 'solana:mainnet' }

test('target chooses earliest wallet and actual lowest account, using ordinary EVM identity', () => {
  const addresses = [
    {
      id: 'a1',
      chainAccountId: 'evm-9',
      scheme: 'evm',
      purpose: 'identity',
      preferredForReceive: true,
      privacy: 'transparent',
      walletCompatibility: 'broad',
      value: '0xaccount9'
    },
    {
      id: 'a2',
      chainAccountId: 'evm-new',
      scheme: 'evm',
      purpose: 'identity',
      preferredForReceive: true,
      privacy: 'transparent',
      walletCompatibility: 'broad',
      value: '0xnew'
    },
    {
      id: 'a3',
      chainAccountId: 'evm-5',
      scheme: 'evm',
      purpose: 'identity',
      preferredForReceive: true,
      privacy: 'transparent',
      walletCompatibility: 'broad',
      value: '0xaccount5'
    },
    {
      id: 'pea',
      chainAccountId: 'evm-5',
      scheme: 'evm',
      purpose: 'identity',
      preferredForReceive: true,
      privacy: 'mixed',
      walletCompatibility: 'limited',
      value: '0xpea'
    }
  ]
  assert.deepEqual(selectBetaInviteTarget(snapshot(undefined, addresses), 'mainnet', chains), {
    walletId: 'first-wallet',
    accountId: 'account-5',
    walletAddress: '0xaccount5'
  })
})

test('software waits for EVM; hardware uses network-specific transparent fallback', () => {
  const addresses = [
    {
      id: 'z',
      chainAccountId: 'zcash-5',
      scheme: 'zcash-transparent-p2pkh',
      purpose: 'receive',
      preferredForReceive: false,
      value: 't1hardware'
    }
  ]
  assert.equal(selectBetaInviteTarget(snapshot(undefined, addresses), 'mainnet', chains), null)
  assert.equal(
    selectBetaInviteTarget(snapshot({ kind: 'hardware' }, addresses), 'mainnet', chains)
      ?.walletAddress,
    't1hardware'
  )
  assert.equal(
    selectBetaInviteTarget(snapshot({ kind: 'hardware' }, addresses), 'testnet', chains),
    null
  )
})
