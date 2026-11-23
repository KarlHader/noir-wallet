import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { describeNearPrivateSendRoute } from '../../../../src/popup/services/near-send-routing.ts'
import {
  NEAR_INCOGNITO_RECEIVE_NOTICE,
  NEAR_PRIVATE_SEND_TOGGLE_MESSAGE,
  buildNearPrivateSendRouteInput,
  decideNearSendPage,
  guardNearPublicPrepare,
  nearIncognitoReceiveUnavailableMessage,
  nearPrivatePreparationMatches,
  readNearSendAccount,
  selectNearReceiveAddress
} from '../../../../src/popup/services/near-send-receive-page.ts'

const now = Date.parse('2026-11-23T06:00:00.000Z')
const main = 'alice.near'
const implicitMain = '11'.repeat(32)
const pea = 'cd'.repeat(32)
const depositAddress = 'ab'.repeat(32)
const recipient = 'bob.near'
const amountRaw = '1000'

function account(overrides = {}) {
  return readNearSendAccount({
    accountIndex: 4,
    walletKind: 'software',
    mainAccountId: main,
    persistedPeaAccountId: pea,
    ...overrides
  })
}

function route(overrides = {}) {
  const { account: accountOverrides, ...rest } = overrides
  const resolved = account(accountOverrides)
  assert.ok(resolved)
  const input = buildNearPrivateSendRouteInput({
    chainId: 'near:mainnet',
    source: 'main',
    assetId: 'near:mainnet/slip44:397',
    amountRaw,
    recipient,
    account: resolved,
    now,
    ...rest
  })
  assert.ok(input)
  return input
}

function publicQuote(overrides = {}) {
  const { quote, quoteRequest, ...rest } = overrides
  return {
    dry: false,
    quote: { amountIn: amountRaw, depositAddress, ...quote },
    quoteRequest: {
      dry: false,
      originAsset: 'nep141:wrap.near',
      destinationAsset: 'nep141:wrap.near',
      depositMode: 'SIMPLE',
      confidentiality: 'basic',
      amount: amountRaw,
      refundTo: main,
      recipient,
      ...quoteRequest
    },
    ...rest
  }
}

describe('NEAR send and receive page decisions', () => {
  it('selects the Main account id for public receive', () => {
    assert.deepEqual(
      selectNearReceiveAddress({
        mode: 'public',
        keySource: 'software',
        mainAccountId: main,
        persistedPeaAccountId: pea
      }),
      { status: 'address', mode: 'public', address: main }
    )
    assert.deepEqual(
      selectNearReceiveAddress({
        mode: 'public',
        keySource: 'imported',
        mainAccountId: implicitMain
      }),
      { status: 'address', mode: 'public', address: implicitMain }
    )
    const labeled = { label: 'Incognito', role: 'incognito', address: main }
    assert.equal(
      selectNearReceiveAddress({
        mode: 'public',
        keySource: 'software',
        mainAccountId: labeled.address
      }).address,
      main
    )
  })

  it('selects the persisted PEA for incognito receive and hides hardware', () => {
    const incognito = selectNearReceiveAddress({
      mode: 'incognito',
      keySource: 'software',
      mainAccountId: main,
      persistedPeaAccountId: pea
    })
    assert.deepEqual(incognito, {
      status: 'address',
      mode: 'incognito',
      address: pea,
      notice: NEAR_INCOGNITO_RECEIVE_NOTICE
    })
    assert.match(incognito.notice, /inactive until it receives NEAR/)
    for (const persistedPeaAccountId of [undefined, null, pea.toUpperCase(), 'not-a-pea', main]) {
      assert.deepEqual(
        selectNearReceiveAddress({
          mode: 'incognito',
          keySource: 'software',
          mainAccountId: main,
          persistedPeaAccountId
        }),
        { status: 'unavailable', mode: 'incognito' }
      )
    }
    assert.deepEqual(
      selectNearReceiveAddress({
        mode: 'incognito',
        keySource: 'hardware',
        mainAccountId: main,
        persistedPeaAccountId: pea
      }),
      { status: 'unavailable', mode: 'incognito' }
    )
    assert.match(nearIncognitoReceiveUnavailableMessage('hardware'), /hardware account has no/)
    assert.match(nearIncognitoReceiveUnavailableMessage('software'), /no Incognito NEAR address/)
  })

  it('does not turn a failed private route into a public transfer', () => {
    const addressBook = { label: 'Main', role: 'incognito', address: pea }
    const failed = decideNearSendPage({
      sendPrivately: true,
      source: 'main',
      route: route({
        recipient: addressBook.address,
        quote: { dry: true, quote: { amountIn: amountRaw, depositAddress } }
      })
    })
    assert.equal(failed.action, 'stopped')
    assert.deepEqual(Object.keys(failed), ['action', 'message'])
    assert.match(failed.message, /preview quote cannot fund/)
    assert.equal(JSON.stringify(failed).includes('native-transfer'), false)
    assert.equal(JSON.stringify(failed).includes(pea), false)

    const unfundable = decideNearSendPage({
      sendPrivately: true,
      source: 'incognito',
      route: route({
        source: 'incognito',
        recipient: main,
        quote: publicQuote({
          quote: { depositAddress: pea },
          quoteRequest: { refundTo: pea, recipient: main }
        })
      })
    })
    assert.equal(unfundable.action, 'stopped')
    assert.match(unfundable.message, /cannot fund the destination/)

    const direct = decideNearSendPage({
      sendPrivately: false,
      source: 'main',
      route: route({ recipient: pea })
    })
    assert.equal(direct.action, 'stopped')
    assert.equal(direct.message, NEAR_PRIVATE_SEND_TOGGLE_MESSAGE)
    assert.equal(JSON.stringify(direct).includes('public-transfer'), false)

    const imported = decideNearSendPage({
      sendPrivately: true,
      source: 'incognito',
      route: route({
        source: 'incognito',
        account: { accountIndex: 2, walletKind: 'private-key', mainAccountId: implicitMain }
      })
    })
    assert.equal(imported.action, 'stopped')
    assert.match(imported.message, /account index 0/)
  })

  it('keeps an external address on the public path until Send privately is on', () => {
    const addressBook = { label: 'Incognito', role: 'main', address: recipient }
    const labeled = decideNearSendPage({
      sendPrivately: true,
      source: 'main',
      route: route({ recipient: addressBook.address })
    })
    assert.equal(labeled.action, 'private')
    if (labeled.action !== 'private') return
    assert.equal(labeled.route.phase, 'quote')
    assert.equal(labeled.route.recipientRole, 'external')
    assert.equal(labeled.route.signing.kind, 'near-transaction')

    const publicSend = decideNearSendPage({
      sendPrivately: false,
      source: 'main',
      route: route({ recipient: addressBook.address })
    })
    assert.deepEqual(publicSend, { action: 'public' })
  })

  it('funds one intents deposit and rejects a public transfer shaped like that route', () => {
    const funded = decideNearSendPage({
      sendPrivately: true,
      source: 'incognito',
      route: route({
        source: 'incognito',
        recipient: main,
        quote: publicQuote({ quoteRequest: { refundTo: pea, recipient: main } })
      })
    })
    assert.equal(funded.action, 'private')
    if (funded.action !== 'private' || funded.route.phase !== 'intents-deposit') return
    assert.equal(funded.route.signing.kind, 'pea-near-transaction')
    assert.equal(funded.route.intentsDeposit.transactionCount, 1)
    assert.equal(Object.hasOwn(funded.route.intentsDeposit, 'memo'), false)
    assert.equal(
      nearPrivatePreparationMatches(
        {
          assetId: funded.route.intentsDeposit.assetId,
          recipient: funded.route.intentsDeposit.depositAddress,
          amountRaw,
          signerId: pea
        },
        funded.route
      ),
      true
    )
    assert.equal(
      nearPrivatePreparationMatches(
        {
          assetId: 'near:mainnet/slip44:397',
          recipient: main,
          amountRaw,
          signerId: pea
        },
        funded.route
      ),
      false
    )
    const described = describeNearPrivateSendRoute(route())
    assert.equal(described.ok, true)
  })

  it('does not add a second wrap or a public prepare fallback in the private form', () => {
    const page = readFileSync(
      fileURLToPath(
        new URL('../../../../src/popup/services/near-send-receive-page.ts', import.meta.url)
      ),
      'utf8'
    )
    const form = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../src/popup/components/transaction/NearPrivateSendForm.tsx',
          import.meta.url
        )
      ),
      'utf8'
    )
    for (const source of [page, form]) {
      assert.equal(source.includes('prependRheaSwapNearWrap'), false)
      assert.equal(source.includes('console.'), false)
    }
    assert.equal(form.includes('.prepareTransfer'), false)
    assert.equal(form.includes('prepareTransfer('), false)
    assert.equal(form.includes('preparePrivateSend'), true)
    assert.equal(form.includes('decideNearSendPage'), true)
    const networkForm = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../src/popup/components/transaction/NetworkSendForm.tsx',
          import.meta.url
        )
      ),
      'utf8'
    )
    const addresses = readFileSync(
      fileURLToPath(
        new URL('../../../../src/popup/pages/account/AddressesList.tsx', import.meta.url)
      ),
      'utf8'
    )
    assert.equal(networkForm.includes('guardNearPublicPrepare'), true)
    assert.equal(networkForm.includes('prependRheaSwapNearWrap'), false)
    assert.equal(addresses.includes('selectNearReceiveAddress'), true)
  })

  it('keeps a public send to this account PEA stopped while the route cannot fund it', () => {
    const resolved = account()
    assert.ok(resolved)
    const blocked = guardNearPublicPrepare({
      recipient: pea,
      amountRaw,
      chainId: 'near:mainnet',
      assetId: 'near:mainnet/slip44:397',
      accountStatus: 'ready',
      account: resolved,
      now
    })
    assert.equal(blocked, NEAR_PRIVATE_SEND_TOGGLE_MESSAGE)
    const failed = guardNearPublicPrepare({
      recipient: pea,
      amountRaw,
      chainId: 'near:testnet',
      assetId: 'near:mainnet/slip44:397',
      accountStatus: 'ready',
      account: resolved,
      now
    })
    assert.equal(failed, 'Private NEAR sends are available on NEAR mainnet.')
    assert.equal(
      guardNearPublicPrepare({
        recipient: pea,
        amountRaw,
        chainId: 'near:mainnet',
        assetId: 'near:mainnet/slip44:397',
        accountStatus: 'loading',
        account: null,
        now
      }),
      'Loading account...'
    )
    assert.equal(
      guardNearPublicPrepare({
        recipient: recipient,
        amountRaw,
        chainId: 'near:mainnet',
        assetId: 'near:mainnet/slip44:397',
        accountStatus: 'loading',
        account: null,
        now
      }),
      null
    )
    const decision = decideNearSendPage({
      sendPrivately: true,
      source: 'main',
      route: route({
        recipient: pea,
        quote: { dry: true, quote: { amountIn: amountRaw, depositAddress } }
      })
    })
    assert.equal(decision.action, 'stopped')
    assert.notEqual(decision.action, 'public')
  })
})
