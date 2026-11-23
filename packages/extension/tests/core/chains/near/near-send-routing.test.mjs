import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { nearPeaRequestJson } from '../../../../src/infrastructure/keyring/multichain/raw-wallet-engine.ts'
import {
  NEAR_PRIVATE_SEND_CHAIN_ASSET_ID,
  NEAR_PRIVATE_SEND_DEPOSIT_MODE,
  NEAR_PRIVATE_SEND_QUOTE_ASSET_ID,
  createNearPrivateSendPeaRequest,
  describeNearPrivateSendRoute,
  parseNearPrivateSendPeaRequest,
  parseNearPublicOneClickDeposit
} from '../../../../src/popup/services/near-send-routing.ts'

const deadline = '2026-11-24T06:00:00.000Z'
const main = 'alice.near'
const implicitMain = '11'.repeat(32)
const pea = 'cd'.repeat(32)
const depositAddress = 'ab'.repeat(32)
const recipient = 'bob.near'
const amountRaw = '1000'

function routeInput(overrides = {}) {
  const { account, ...rest } = overrides
  return {
    chainId: 'near:mainnet',
    source: 'main',
    assetId: 'near:mainnet/slip44:397',
    amountRaw,
    recipient,
    slippageTolerance: 100,
    deadline,
    account: {
      accountIndex: 4,
      keySource: 'software',
      mainAccountId: main,
      peaImplicitAccountId: pea,
      ...account
    },
    ...rest
  }
}

function publicQuote(overrides = {}) {
  const { quote, quoteRequest, ...rest } = overrides
  return {
    dry: false,
    quote: { amountIn: amountRaw, depositAddress, ...quote },
    quoteRequest: {
      dry: false,
      originAsset: NEAR_PRIVATE_SEND_QUOTE_ASSET_ID,
      destinationAsset: NEAR_PRIVATE_SEND_QUOTE_ASSET_ID,
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

function assertPrivateQuote(request) {
  assert.equal(request.confidentiality, 'basic')
  assert.equal(request.depositMode, NEAR_PRIVATE_SEND_DEPOSIT_MODE)
  assert.equal(request.dry, false)
  assert.equal(request.originAsset, NEAR_PRIVATE_SEND_QUOTE_ASSET_ID)
  assert.equal(request.destinationAsset, NEAR_PRIVATE_SEND_QUOTE_ASSET_ID)
  assert.equal(request.referral, 'noir_send')
  assert.equal(Object.hasOwn(request, 'memo'), false)
  assert.equal(Object.hasOwn(request, 'depositMemo'), false)
  assert.equal(Object.hasOwn(request, 'appId'), false)
  assert.equal(Object.hasOwn(request, 'chainId'), false)
  const serialized = JSON.stringify(request)
  assert.equal(serialized.includes('slip44:397'), false)
  assert.equal(serialized.includes('nep141:near'), false)
  assert.equal(serialized.includes('"native"'), false)
  assert.equal(serialized.includes('"near"'), false)
}

describe('NEAR private send routing', () => {
  it('keeps the PEA request bound to its parent account index', () => {
    for (const accountIndex of [0, 4, 0x7fffffff]) {
      const json = createNearPrivateSendPeaRequest(accountIndex)
      assert.equal(json, nearPeaRequestJson(accountIndex))
      assert.equal(json, `{"version":2,"family":"near","parent":{"accountIndex":${accountIndex}}}`)
      assert.equal(parseNearPrivateSendPeaRequest(json, accountIndex), true)
      const parsed = JSON.parse(json)
      assert.deepEqual(Object.keys(parsed).sort(), ['family', 'parent', 'version'])
      assert.deepEqual(Object.keys(parsed.parent), ['accountIndex'])
      assert.equal(parsed.version, 2)
      assert.equal(parsed.family, 'near')
      assert.equal(parsed.parent.accountIndex, accountIndex)
      assert.equal(json.includes('appId'), false)
      assert.equal(json.includes('chainId'), false)
    }
    assert.equal(createNearPrivateSendPeaRequest(-1), null)
    assert.equal(createNearPrivateSendPeaRequest(1.5), null)
    assert.equal(createNearPrivateSendPeaRequest(0x80000000), null)
    assert.equal(parseNearPrivateSendPeaRequest(createNearPrivateSendPeaRequest(0), 4), false)
    for (const json of [
      '{"version":2,"family":"near","parent":{"accountIndex":0},"appId":"noir"}',
      '{"version":2,"family":"near","chainId":"near:mainnet","parent":{"accountIndex":0}}',
      '{\n  "version": 2,\n  "family": "near",\n  "parent": { "accountIndex": 0 }\n}',
      '{"family":"near","parent":{"accountIndex":0},"version":2}'
    ]) {
      assert.equal(parseNearPrivateSendPeaRequest(json, 0), false)
    }
  })

  it('quotes wNEAR for a private route and does not build a public transfer', () => {
    const described = describeNearPrivateSendRoute(
      routeInput({ recipient: pea, assetId: 'near:mainnet/slip44:397' })
    )
    assert.equal(described.ok, true)
    if (!described.ok) return
    assert.equal(described.phase, 'quote')
    assert.equal(described.recipientRole, 'incognito')
    assert.equal(described.signing.kind, 'near-transaction')
    assert.equal(described.signing.signerId, main)
    assert.equal(described.signing.accountIndex, 4)
    assert.equal(Object.hasOwn(described.signing, 'peaRequestJson'), false)
    assert.equal(Object.hasOwn(described, 'intentsDeposit'), false)
    assertPrivateQuote(described.quoteRequest)
    assert.equal(described.quoteRequest.recipient, pea)
    assert.equal(described.quoteRequest.refundTo, main)
    const serialized = JSON.stringify(described)
    assert.equal(serialized.includes('native-transfer'), false)
    assert.equal(serialized.includes('slip44:397'), false)
  })

  it('funds with one intents deposit after a public 1Click quote', () => {
    const described = describeNearPrivateSendRoute(
      routeInput({
        source: 'incognito',
        assetId: NEAR_PRIVATE_SEND_CHAIN_ASSET_ID,
        recipient: main,
        quote: publicQuote({
          quoteRequest: { refundTo: pea, recipient: main }
        })
      })
    )
    assert.equal(described.ok, true)
    if (!described.ok) return
    assert.equal(described.phase, 'intents-deposit')
    assert.equal(described.recipientRole, 'main')
    assert.equal(described.confidentiality, 'basic')
    assert.equal(described.signing.kind, 'pea-near-transaction')
    assert.equal(described.signing.accountIndex, 4)
    assert.equal(described.signing.signerId, pea)
    assert.equal(described.signing.peaRequestJson, nearPeaRequestJson(4))
    assert.equal(JSON.parse(described.signing.peaRequestJson).parent.accountIndex, 4)
    assertPrivateQuote(described.quoteRequest)
    assert.equal(described.intentsDeposit.kind, 'intents-deposit')
    assert.equal(described.intentsDeposit.transactionCount, 1)
    assert.equal(described.intentsDeposit.chainId, 'near:mainnet')
    assert.equal(described.intentsDeposit.assetId, NEAR_PRIVATE_SEND_CHAIN_ASSET_ID)
    assert.equal(described.intentsDeposit.depositAddress, depositAddress)
    assert.equal(described.intentsDeposit.signerId, pea)
    assert.equal(described.intentsDeposit.amountRaw, amountRaw)
    assert.notEqual(described.intentsDeposit.depositAddress, pea)
    assert.equal(Object.hasOwn(described.intentsDeposit, 'memo'), false)
    assert.equal(Object.hasOwn(described.intentsDeposit, 'transactions'), false)
    assert.equal(Object.hasOwn(described, 'memo'), false)
  })

  it('lets an imported NEAR key sign only account index 0', () => {
    const imported = describeNearPrivateSendRoute(
      routeInput({
        source: 'incognito',
        account: { accountIndex: 0, keySource: 'imported', mainAccountId: implicitMain }
      })
    )
    assert.equal(imported.ok, true)
    if (!imported.ok) return
    assert.equal(imported.signing.kind, 'pea-near-transaction')
    assert.equal(imported.signing.peaRequestJson, nearPeaRequestJson(0))
    const rejected = describeNearPrivateSendRoute(
      routeInput({
        account: { accountIndex: 2, keySource: 'imported', mainAccountId: implicitMain }
      })
    )
    assert.equal(rejected.ok, false)
    if (rejected.ok) return
    assert.equal(rejected.code, 'unsupported-signer')
    assert.match(rejected.message, /account index 0/)
    assert.equal(JSON.stringify(rejected).includes(implicitMain), false)
  })

  it('returns a typed failure instead of a direct Main-to-PEA transfer', () => {
    const preview = describeNearPrivateSendRoute(
      routeInput({
        recipient: pea,
        quote: { dry: true, quote: { amountIn: amountRaw, depositAddress } }
      })
    )
    assert.equal(preview.ok, false)
    if (preview.ok) return
    assert.equal(preview.code, 'invalid-quote')
    assert.match(preview.message, /preview quote cannot fund/)
    assert.equal(Object.hasOwn(preview, 'intentsDeposit'), false)
    assert.equal(JSON.stringify(preview).includes('native-transfer'), false)

    const direct = describeNearPrivateSendRoute(
      routeInput({
        recipient: pea,
        quote: publicQuote({
          quote: { depositAddress: pea },
          quoteRequest: { recipient: pea }
        })
      })
    )
    assert.equal(direct.ok, false)
    if (direct.ok) return
    assert.equal(direct.code, 'unfundable-destination')
    assert.match(direct.message, /cannot fund the destination/)
    assert.equal(JSON.stringify(direct).includes(pea), false)

    const missing = describeNearPrivateSendRoute(
      routeInput({
        source: 'incognito',
        account: { peaImplicitAccountId: null }
      })
    )
    assert.equal(missing.ok, false)
    if (missing.ok) return
    assert.equal(missing.code, 'unfundable-destination')
    assert.match(missing.message, /no Incognito NEAR address/)

    const hardware = describeNearPrivateSendRoute(
      routeInput({ source: 'incognito', account: { keySource: 'hardware' } })
    )
    assert.equal(hardware.ok, false)
    if (hardware.ok) return
    assert.equal(hardware.code, 'unsupported-signer')
    assert.match(hardware.message, /hardware account cannot sign an Incognito/)
  })

  it('rejects quote asset ids other than wNEAR', () => {
    for (const assetId of [
      'near',
      'native',
      'nep141:near',
      'slip44:397',
      'near:mainnet/near',
      'near:mainnet/native',
      'near:mainnet/nep141:usdc.near'
    ]) {
      const result = describeNearPrivateSendRoute(routeInput({ assetId }))
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.equal(result.code, 'unsupported-asset')
      assert.equal(result.message, 'Private NEAR sends use wNEAR.')
      assert.equal(JSON.stringify(result).includes(assetId), false)
    }
    const echoed = parseNearPublicOneClickDeposit(
      publicQuote({ quote: { originAsset: 'nep141:near' } }),
      { amountRaw, recipient, refundTo: main }
    )
    assert.equal(echoed.ok, false)
    if (echoed.ok) return
    assert.equal(echoed.code, 'unsupported-asset')
    assert.equal(JSON.stringify(echoed).includes('nep141:near'), false)
  })

  it('validates the public deposit address and does not interpret a confidential quote', () => {
    const expected = { amountRaw, recipient, refundTo: main }
    const accepted = parseNearPublicOneClickDeposit(publicQuote(), expected)
    assert.deepEqual(accepted, { ok: true, depositAddress })

    const cases = [
      [
        { quote: { amountIn: amountRaw, depositAddress: depositAddress.toUpperCase() } },
        /deposit address/
      ],
      [{ quote: { amountIn: amountRaw, depositAddress: 'aa'.repeat(31) } }, /deposit address/],
      [
        { quote: { amountIn: amountRaw, depositAddress: `0x${depositAddress}` } },
        /deposit address/
      ],
      [{ quote: { amountIn: amountRaw, depositAddress: 'deposit.near' } }, /deposit address/],
      [{ quote: { amountIn: amountRaw, depositAddress, memo: 'required' } }, /memo/],
      [{ memo: 'required', quote: { amountIn: amountRaw, depositAddress } }, /memo/],
      [publicQuote({ quoteRequest: { memo: 'required' } }), /memo/],
      [publicQuote({ quoteRequest: { depositMode: 'MEMO' } }), /deposit mode/],
      [{ dry: true, quote: { amountIn: amountRaw, depositAddress } }, /preview quote/],
      [
        { quote: { amountIn: amountRaw, depositAddress, confidentiality: 'basic' } },
        /cannot fund this transfer/
      ],
      [publicQuote({ quote: { amountIn: '999' } }), /amount does not match/]
    ]
    for (const [value, message] of cases) {
      const result = parseNearPublicOneClickDeposit(value, expected)
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.equal(result.code, 'invalid-quote')
      assert.match(result.message, message)
      assert.equal(Object.hasOwn(result, 'depositAddress'), false)
    }
  })

  it('does not reference a second wrap transaction or log a payload', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../../src/popup/services/near-send-routing.ts', import.meta.url)
      ),
      'utf8'
    )
    assert.equal(source.includes('prependRheaSwapNearWrap'), false)
    assert.equal(source.includes('native-transfer'), false)
    assert.equal(source.includes('console.'), false)
    const hardwareMain = describeNearPrivateSendRoute(
      routeInput({ account: { keySource: 'hardware' }, assetId: NEAR_PRIVATE_SEND_QUOTE_ASSET_ID })
    )
    assert.equal(hardwareMain.ok, true)
    if (!hardwareMain.ok) return
    assert.equal(hardwareMain.signing.kind, 'near-transaction')
    const testnet = describeNearPrivateSendRoute(routeInput({ chainId: 'near:testnet' }))
    assert.equal(testnet.ok, false)
    if (testnet.ok) return
    assert.equal(testnet.code, 'invalid-request')
    assert.match(testnet.message, /NEAR mainnet/)
  })
})
