import { signPublicMessage } from '../../../../src/core/services/noir-protocol/public/identity.ts'
import { signApprovedDAppMessage } from '../../../../src/background/dapp-message-signing.ts'
import { SIGNING_ACCOUNT_INDEX } from '../../../../src/config/wallet.ts'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { secp256k1 } from '@noble/curves/secp256k1'

import {
  computePublicSubmissionId,
  createPublicCandidate,
  createPublicMcaMessage,
  parsePublicCandidate,
  parsePublicFunctionCallRequests,
  assertPublicJsonMessage,
  serializePublicBusiness,
  serializePublicCandidate,
  stringifyPublicWire
} from '../../../../src/core/services/noir-protocol/public/protocol.ts'
import {
  buildPublicPaidRequests,
  assertPublicFeeQuoteStillCovers
} from '../../../../src/core/services/noir-protocol/public/fee.ts'
import {
  NoirPublicClient,
  parsePublicNonceSnapshot,
  parsePublicTxStatusResponse,
  parsePublicGasFeeQuote,
  readPublicTransactionSigner,
  verifyPublicExecutionOutcome
} from '../../../../src/infrastructure/noir-protocol/public-client.ts'
import { PUBLIC_MAINNET_CONFIG } from '../../../../src/core/services/noir-protocol/public/config.ts'
import { getEvmNativeProtocolAssetId } from '../../../../src/config/asset-market-assets.ts'
import {
  assertPublicActivationQuoteForPayment,
  assertPublicActivationQuoteRequest,
  createPublicActivationQuoteRequest,
  increasePublicActivationQuoteRequest,
  parsePublicBridgeMinimum,
  parsePublicActivationQuote
} from '../../../../src/core/services/noir-protocol/public/activation-quote.ts'
import { getPublicActivationQuote } from '../../../../src/infrastructure/noir-protocol/public-activation-client.ts'

const publicKey = `04${'11'.repeat(64)}`
const signature = `1b${'22'.repeat(64)}`
const evmAddress = `0x${'ab'.repeat(20)}`
const evmSignature = `0x${'33'.repeat(64)}1b`
const request = {
  FunctionCall: {
    receiver_id: 'token.near',
    function_calls: [
      {
        method_name: 'ft_transfer',
        args: '{"receiver_id":"friend.near","amount":"1"}',
        gas: '30000000000000',
        deposit: '1'
      }
    ]
  }
}

function compactSize(value) {
  if (value < 253) return Buffer.from([value])
  const bytes = Buffer.alloc(3)
  bytes[0] = 253
  bytes.writeUInt16LE(value, 1)
  return bytes
}

function recoverZcashPublicKey(message, compactSignature) {
  const magic = Buffer.from('Zcash Signed Message:\n')
  const payload = Buffer.from(message)
  const framed = Buffer.concat([
    compactSize(magic.length),
    magic,
    compactSize(payload.length),
    payload
  ])
  const first = createHash('sha256').update(framed).digest()
  const hash = createHash('sha256').update(first).digest()
  const recovery = Number.parseInt(compactSignature.slice(0, 2), 16) - 27
  return Buffer.from(
    secp256k1.Signature.fromCompact(compactSignature.slice(2))
      .addRecoveryBit(recovery)
      .recoverPublicKey(hash)
      .toRawBytes(false)
  ).toString('hex')
}

test.describe('Public wire contract', () => {
  test('encodes EVM signer identity and signature for MCA lookup and submission', () => {
    const candidate = createPublicCandidate({
      tgas: 250,
      address: 'a.ma.private-mainnet.ref-dev-team.near',
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [request],
      publicKey: evmAddress.toUpperCase().replace('0X', '0x'),
      signature: evmSignature,
      identityChain: 'evm'
    })
    expect(candidate.signer_wallet).toEqual({ EVM: evmAddress.slice(2) })
    expect(candidate.signature).toBe(evmSignature.slice(2))
    expect(parsePublicCandidate(JSON.parse(serializePublicCandidate(candidate)))).toEqual(candidate)
    expect(JSON.parse(createPublicMcaMessage(evmAddress, evmSignature, 'evm'))).toEqual({
      w: [{ EVM: evmAddress.slice(2) }],
      s: [evmSignature.slice(2)]
    })
    expect(() =>
      parsePublicCandidate({ ...candidate, signer_wallet: { EVM: evmAddress } })
    ).toThrow()
    expect(() =>
      createPublicCandidate({
        tgas: 250,
        address: candidate.address,
        nonce: '7',
        deadline: candidate.deadline,
        txRequests: [request],
        publicKey: evmAddress,
        signature: evmSignature.slice(0, -2) + '00',
        identityChain: 'evm'
      })
    ).toThrow(/signature/)
  })

  test('looks up an EVM MCA using the contract wallet variant', async () => {
    const originalFetch = globalThis.fetch
    let wallet
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      wallet = JSON.parse(atob(body.params.args_base64)).wallet
      return new Response(
        JSON.stringify({ result: { result: [...new TextEncoder().encode('null')] } })
      )
    }
    try {
      const client = new NoirPublicClient(PUBLIC_MAINNET_CONFIG, 'https://rpc.mainnet.near.org')
      expect(await client.getMcaByWallet(evmAddress, undefined, 'evm')).toBeNull()
      expect(wallet).toEqual({ EVM: evmAddress.slice(2) })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('selects only a registered native EVM activation asset', () => {
    const originAsset = getEvmNativeProtocolAssetId('eip155:1')
    const request = createPublicActivationQuoteRequest({
      config: PUBLIC_MAINNET_CONFIG,
      publicKey: evmAddress,
      signature: evmSignature,
      evmSource: { chainId: 'eip155:1', protocolAssetId: originAsset },
      refundAddress: evmAddress,
      amountOutRaw: '30000'
    })
    expect(request.originAsset).toBe(originAsset)
    expect(() => assertPublicActivationQuoteRequest(request, PUBLIC_MAINNET_CONFIG)).not.toThrow()
    expect(JSON.parse(request.customRecipientMsg).w).toEqual([{ EVM: evmAddress.slice(2) }])
    expect(() =>
      createPublicActivationQuoteRequest({
        config: PUBLIC_MAINNET_CONFIG,
        publicKey: evmAddress,
        signature: evmSignature,
        evmSource: { chainId: 'eip155:8453', protocolAssetId: originAsset },
        refundAddress: evmAddress,
        amountOutRaw: '30000'
      })
    ).toThrow(/not registered/)
  })

  test('Public message signing accepts any JSON syntax without business schema checks', () => {
    for (const value of [
      JSON.stringify(
        {
          tx_requests: [{ GasPayment: { token_id: 'near', amount: '100' } }, request],
          extra: true,
          deadline: '0'
        },
        null,
        2
      ),
      ' [null, true, 1, {"FutureAction": {"any_field": "value"}}] ',
      '"sign in"',
      'null'
    ])
      expect(() => assertPublicJsonMessage(value)).not.toThrow()
    for (const value of ['ordinary message', '{"nonce":"7",', '{"value": undefined}'])
      expect(() => assertPublicJsonMessage(value)).toThrow(/valid JSON/)
  })

  test('produces the signed Business bytes and Go submission ID from structured fields', () => {
    const candidate = createPublicCandidate({
      tgas: 250,
      address: 'a.ma.private-mainnet.ref-dev-team.near',
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [request],
      publicKey,
      signature
    })
    const business = serializePublicBusiness({
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [request]
    })
    expect(business).toBe(
      JSON.stringify({ nonce: '7', deadline: '1760000000000', tx_requests: [request] })
    )
    expect(serializePublicCandidate(candidate)).toBe(
      JSON.stringify({
        tgas: 250,
        address: candidate.address,
        nonce: '7',
        deadline: '1760000000000',
        tx_requests: [request],
        signer_wallet: { Zcash: publicKey },
        signature
      })
    )
    expect(computePublicSubmissionId(candidate)).toBe(
      'FFhU1Up9uoyNqfgurFdUtJ8EwfGH5QSjgRgM89X9gbhs'
    )
    const legacy = parsePublicCandidate(
      JSON.parse(serializePublicCandidate(candidate), (key, value) =>
        key === 'tgas' ? undefined : value
      )
    )
    expect(computePublicSubmissionId(legacy)).toBe(
      '4e8a2aa3072d286c42a95b79a5223c31bd32448a797b6e67fc937c08754a6367'
    )
    expect(serializePublicCandidate(legacy)).not.toContain('"tgas"')
    expect(createPublicMcaMessage(publicKey, signature)).toBe(
      JSON.stringify({
        w: [{ Zcash: publicKey }],
        s: [signature]
      })
    )
  })

  test('rejects unreviewed action variants, extra fields and unsafe numeric wire values', () => {
    expect(() =>
      parsePublicFunctionCallRequests([{ Transfer: { receiver_id: 'friend.near', amount: '1' } }])
    ).toThrow()
    expect(() =>
      parsePublicFunctionCallRequests([
        { FunctionCall: { ...request.FunctionCall, interval_block: 1 } }
      ])
    ).toThrow()
    expect(() =>
      parsePublicFunctionCallRequests([
        {
          FunctionCall: {
            ...request.FunctionCall,
            function_calls: [{ ...request.FunctionCall.function_calls[0], deposit: 1 }]
          }
        }
      ])
    ).toThrow()
    expect(() =>
      parsePublicFunctionCallRequests([
        {
          FunctionCall: {
            ...request.FunctionCall,
            function_calls: [{ ...request.FunctionCall.function_calls[0], args: 'not json' }]
          }
        }
      ])
    ).toThrow()
    expect(() =>
      createPublicCandidate({
        tgas: 250,
        address: 'a.ma.private-mainnet.ref-dev-team.near',
        nonce: '7',
        deadline: '1760000000000',
        txRequests: [request],
        publicKey: `04${'AA'.repeat(64)}`,
        signature
      })
    ).toThrow()
    expect(() =>
      parsePublicFunctionCallRequests([
        {
          FunctionCall: {
            ...request.FunctionCall,
            function_calls: [
              { ...request.FunctionCall.function_calls[0], deposit: (1n << 128n).toString() }
            ]
          }
        }
      ])
    ).toThrow(/contract limit/)
  })

  test('prices a bounded first ZEC fee action from a fresh backend snapshot', () => {
    const now = Date.parse('2026-11-03T09:30:00Z')
    const response = {
      gas_tokens: { 'zec.omft.near': 'ZEC' },
      gas_fee_account: 'fees.near',
      batch: {
        batch_id: '1',
        completed_at: '2026-11-03T09:29:00Z',
        gas_units: '1000000000000',
        quotes: [{ symbol: 'ZEC', decimals: 8, fee_atomic: '34' }]
      }
    }
    const quote = parsePublicGasFeeQuote({ code: 0, data: response }, PUBLIC_MAINNET_CONFIG, now)
    const paid = buildPublicPaidRequests([request], quote, PUBLIC_MAINNET_CONFIG)
    expect(paid.tgas).toBe(200)
    expect(paid.feeAmountRaw).toBe('6800')
    expect(paid.txRequests.slice(1)).toEqual(parsePublicFunctionCallRequests([request]))
    expect(paid.txRequests[0].FunctionCall).toEqual({
      receiver_id: 'zec.omft.near',
      function_calls: [
        {
          method_name: 'ft_transfer',
          args: '{"receiver_id":"fees.near","amount":"6800"}',
          gas: '30000000000000',
          deposit: '1'
        }
      ]
    })
    expect(() =>
      assertPublicFeeQuoteStillCovers(paid, quote, { ...quote, feePerTgasRaw: '35' })
    ).toThrow(/fee changed/)
    expect(() =>
      parsePublicGasFeeQuote({ code: 0, data: response }, PUBLIC_MAINNET_CONFIG, now + 31 * 60_000)
    ).toThrow(/stale/)
    expect(() =>
      buildPublicPaidRequests(Array(16).fill(request), quote, PUBLIC_MAINNET_CONFIG)
    ).toThrow()
  })

  test('normalizes only incompatible JSON string bytes without changing argument meaning', () => {
    const unicodeRequest = {
      FunctionCall: {
        ...request.FunctionCall,
        function_calls: [
          {
            ...request.FunctionCall.function_calls[0],
            args: '{"memo":"你好<>&\u2028\u2029","amount":123456789012345678901234567890}'
          }
        ]
      }
    }
    const business = serializePublicBusiness({
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [unicodeRequest]
    })
    expect(business).toContain('你好')
    const canonical = parsePublicFunctionCallRequests([unicodeRequest])[0].FunctionCall
      .function_calls[0].args
    expect(canonical).toContain('123456789012345678901234567890')
    expect(canonical).toContain('\\u003c\\u003e\\u0026\\u2028\\u2029')
    expect(JSON.parse(canonical)).toEqual(
      JSON.parse(unicodeRequest.FunctionCall.function_calls[0].args)
    )
    expect(business).toContain('\\\\u003c\\\\u003e\\\\u0026')
    expect(stringifyPublicWire({ note: '你好<>&\u2028' })).toBe(
      '{"note":"你好\\u003c\\u003e\\u0026\\u2028"}'
    )
    const candidate = createPublicCandidate({
      tgas: 250,
      address: 'a.ma.private-mainnet.ref-dev-team.near',
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [unicodeRequest],
      publicKey,
      signature
    })
    expect(serializePublicCandidate(candidate)).toContain('你好')
    expect(computePublicSubmissionId(candidate)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  })

  test('signs generic MCA creation and Unicode Business with packaged Zcash WASM and recovers the public key', async () => {
    globalThis.self ??= new EventTarget()
    const wasm = await import('../../../../src/lib/wasm-pkg/zcash_wallet_wasm.js')
    wasm.initSync({
      module: readFileSync(
        new URL('../../../../src/lib/wasm-pkg/zcash_wallet_wasm_bg.wasm', import.meta.url)
      )
    })
    const mnemonic = [...Array(23).fill('abandon'), 'art'].join(' ')
    const makeKey = () => wasm.mnemonic_to_spending_key('main', mnemonic, '', 2147483646)
    const initial = await wasm.sign_message_with_transparent('main', makeKey(), 'public fixture', 0)
    const wallets = JSON.stringify([{ Zcash: initial.pubkey }])
    const creation = await wasm.sign_message_with_transparent('main', makeKey(), wallets, 0)
    expect(JSON.parse(createPublicMcaMessage(initial.pubkey, creation.signature))).toEqual({
      w: [{ Zcash: initial.pubkey }],
      s: [creation.signature]
    })
    expect(recoverZcashPublicKey(wallets, creation.signature)).toBe(initial.pubkey)

    const unicodeRequest = {
      FunctionCall: {
        receiver_id: 'token.near',
        function_calls: [
          {
            method_name: 'ft_transfer',
            args: '{"memo":"你好<>&\u2028\u2029","amount":123456789012345678901234567890}',
            gas: '30000000000000',
            deposit: '1'
          }
        ]
      }
    }
    const business = serializePublicBusiness({
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [unicodeRequest]
    })
    expect(business).toBe(stringifyPublicWire(JSON.parse(business)))
    const signed = await wasm.sign_message_with_transparent('main', makeKey(), business, 0)
    expect(signed.pubkey).toBe(initial.pubkey)
    expect(recoverZcashPublicKey(business, signed.signature)).toBe(initial.pubkey)
    expect(recoverZcashPublicKey(`${business}x`, signed.signature)).not.toBe(initial.pubkey)
    expect(
      createPublicCandidate({
        tgas: 250,
        address: 'a.ma.private-mainnet.ref-dev-team.near',
        nonce: '7',
        deadline: '1760000000000',
        txRequests: [unicodeRequest],
        publicKey: signed.pubkey,
        signature: signed.signature
      }).signature
    ).toBe(signed.signature)
  })

  test('parses the backend submission lifecycle independently of anchor confirmation', () => {
    const id = 'FFhU1Up9uoyNqfgurFdUtJ8EwfGH5QSjgRgM89X9gbhs'
    for (const status of ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIALLY_SUCCEEDED']) {
      expect(
        parsePublicTxStatusResponse(
          { hash: id, status, tx_hash: '', error_message: '', anchor_txid_hex: '' },
          id
        )
      ).toEqual({ submission_id: id, status })
    }
    const result = parsePublicTxStatusResponse(
      { hash: id, status: 'COMPLETED', tx_hash: 'near-hash', anchor_txid_hex: 'd'.repeat(64) },
      id
    )
    expect(result.anchor).toEqual({ txid_hex: 'd'.repeat(64) })
    expect(result.anchor.confirmed_height).toBeUndefined()
    expect(
      parsePublicTxStatusResponse(
        { hash: id, status: 'PARTIALLY_SUCCEEDED', error_message: 'one action failed' },
        id
      ).failure_reason
    ).toBe('one action failed')
    expect(() =>
      parsePublicTxStatusResponse({ hash: '1'.repeat(32), status: 'COMPLETED' }, id)
    ).toThrow()
    expect(() => parsePublicTxStatusResponse({ hash: id, status: 'ANCHORED' }, id)).toThrow()
  })

  test('checks enveloped submit hashes and reads the matching submission row', async () => {
    const candidate = createPublicCandidate({
      tgas: 250,
      address: 'a.ma.private-mainnet.ref-dev-team.near',
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [request],
      publicKey,
      signature
    })
    const id = computePublicSubmissionId(candidate)
    const client = new NoirPublicClient(PUBLIC_MAINNET_CONFIG, 'https://rpc.mainnet.near.org')
    const originalFetch = globalThis.fetch
    let returnedHash = id
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') {
        expect(JSON.parse(init.body)).toEqual(candidate)
        return new Response(JSON.stringify({ code: 0, data: { hash: returnedHash } }))
      }
      expect(String(url)).toBe(`${PUBLIC_MAINNET_CONFIG.queryBaseUrl}/public/txs/${id}`)
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            hash: id,
            status: 'PROCESSING',
            tx_hash: '',
            error_message: '',
            anchor_txid_hex: ''
          }
        })
      )
    }
    try {
      expect((await client.submitPublicTransaction(candidate)).submission_id).toBe(id)
      expect((await client.getPublicTransaction(id)).status).toBe('PROCESSING')
      returnedHash = '1'.repeat(32)
      await expect(client.submitPublicTransaction(candidate)).rejects.toThrow(/does not match/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('binds an exact-output ZEC activation quote to the generic MCA message and minimum fee', () => {
    const now = Date.parse('2026-11-02T00:00:00.000Z')
    const quoteRequest = createPublicActivationQuoteRequest({
      config: PUBLIC_MAINNET_CONFIG,
      publicKey,
      signature,
      refundAddress: `t1${'a'.repeat(33)}`,
      amountOutRaw: '30000',
      now
    })
    expect(quoteRequest.swapType).toBe('EXACT_OUTPUT')
    expect(quoteRequest.recipient).toBe(PUBLIC_MAINNET_CONFIG.parentContractId)
    expect(JSON.parse(quoteRequest.customRecipientMsg)).toEqual({
      w: [{ Zcash: publicKey }],
      s: [signature]
    })
    const response = {
      quote: {
        amountIn: '40000',
        amountOut: '30000',
        minAmountOut: '30000',
        depositAddress: `t1${'b'.repeat(33)}`,
        deadline: new Date(now + 30 * 60_000).toISOString()
      }
    }
    expect(parsePublicActivationQuote(response, quoteRequest, now).amountInRaw).toBe('40000')
    const extended = parsePublicActivationQuote(
      {
        quote: {
          ...response.quote,
          deadline: new Date(Date.parse(quoteRequest.deadline) + 3 * 86400000).toISOString()
        }
      },
      quoteRequest,
      now
    )
    expect(extended.expiresAt).toBe(quoteRequest.deadline)
    expect(() =>
      assertPublicActivationQuoteForPayment(
        extended,
        PUBLIC_MAINNET_CONFIG,
        '30000',
        Date.parse(quoteRequest.deadline)
      )
    ).toThrow(/expired/)
    expect(() =>
      assertPublicActivationQuoteForPayment(
        parsePublicActivationQuote(response, quoteRequest, now),
        PUBLIC_MAINNET_CONFIG,
        '30000',
        now
      )
    ).not.toThrow()
    expect(() =>
      assertPublicActivationQuoteForPayment(
        parsePublicActivationQuote(response, quoteRequest, now),
        PUBLIC_MAINNET_CONFIG,
        '30001',
        now
      )
    ).toThrow(/creation fee/)
    expect(parsePublicBridgeMinimum('Amount is too low for bridge, try at least 132000')).toBe(
      '132000'
    )
    expect(parsePublicBridgeMinimum('rate limit')).toBeNull()
    expect(increasePublicActivationQuoteRequest(quoteRequest, '132000').amount).toBe('132000')
    expect(() => increasePublicActivationQuoteRequest(quoteRequest, '30000')).toThrow(
      /did not increase/
    )
    expect(() =>
      parsePublicActivationQuote(
        {
          quote: {
            ...response.quote,
            minAmountOut: '29999'
          }
        },
        quoteRequest,
        now
      )
    ).toThrow(/does not cover/)
    expect(() =>
      parsePublicActivationQuote(
        {
          quote: {
            ...response.quote,
            amountOut: '132000',
            minAmountOut: '132000'
          }
        },
        quoteRequest,
        now
      )
    ).toThrow(/differs from the requested/)
  })

  test('negotiates a bounded increasing bridge minimum before requesting the exact reviewed output', async () => {
    const now = Date.now()
    const quoteRequest = createPublicActivationQuoteRequest({
      config: PUBLIC_MAINNET_CONFIG,
      publicKey,
      signature,
      refundAddress: `t1${'a'.repeat(33)}`,
      amountOutRaw: '30000',
      now
    })
    const originalFetch = globalThis.fetch
    const seen = []
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ amount: body.amount, dry: body.dry })
      if (body.dry && body.amount === '30000') {
        return new Response(
          JSON.stringify({ message: 'Amount is too low for bridge, try at least 132000' }),
          { status: 400 }
        )
      }
      if (body.dry && body.amount === '132000') {
        return new Response(
          JSON.stringify({ message: 'Amount is too low for bridge, try at least 140000' }),
          { status: 400 }
        )
      }
      return Response.json({
        quote: {
          amountIn: '150000',
          amountOut: body.amount,
          minAmountOut: body.amount,
          depositAddress: `t1${'b'.repeat(33)}`,
          deadline: new Date(now + 30 * 60_000).toISOString()
        }
      })
    }
    try {
      const quote = await getPublicActivationQuote(quoteRequest, PUBLIC_MAINNET_CONFIG)
      expect(quote.request.amount).toBe('140000')
      expect(quote.amountOutRaw).toBe('140000')
      expect(seen).toEqual([
        { amount: '30000', dry: true },
        { amount: '132000', dry: true },
        { amount: '140000', dry: true },
        { amount: '140000', dry: false }
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects invalid, non-increasing and endlessly changing bridge minimums', async () => {
    const quoteRequest = createPublicActivationQuoteRequest({
      config: PUBLIC_MAINNET_CONFIG,
      publicKey,
      signature,
      refundAddress: `t1${'a'.repeat(33)}`,
      amountOutRaw: '30000'
    })
    const originalFetch = globalThis.fetch
    try {
      for (const minimum of ['0', '30000', '30001']) {
        let calls = 0
        globalThis.fetch = async (_url, init) => {
          calls += 1
          const amount = JSON.parse(init.body).amount
          return new Response(
            JSON.stringify({
              message: `Amount is too low for bridge, try at least ${minimum === '30001' ? (BigInt(amount) + 1n).toString() : minimum}`
            }),
            { status: 400 }
          )
        }
        if (minimum === '0') {
          await expect(
            getPublicActivationQuote(quoteRequest, PUBLIC_MAINNET_CONFIG)
          ).rejects.toThrow(/HTTP 400/)
          expect(calls).toBe(1)
        } else if (minimum === '30000') {
          await expect(
            getPublicActivationQuote(quoteRequest, PUBLIC_MAINNET_CONFIG)
          ).rejects.toThrow(/did not increase/)
          expect(calls).toBe(1)
        } else {
          await expect(
            getPublicActivationQuote(quoteRequest, PUBLIC_MAINNET_CONFIG)
          ).rejects.toThrow(/kept changing/)
          expect(calls).toBe(4)
        }
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('retries when the bridge minimum rises between dry and final quotes', async () => {
    const now = Date.now()
    const quoteRequest = createPublicActivationQuoteRequest({
      config: PUBLIC_MAINNET_CONFIG,
      publicKey,
      signature,
      refundAddress: `t1${'a'.repeat(33)}`,
      amountOutRaw: '30000',
      now
    })
    const originalFetch = globalThis.fetch
    const seen = []
    globalThis.fetch = async (_url, init) => {
      const { amount, dry } = JSON.parse(init.body)
      seen.push({ amount, dry })
      if (!dry && amount === '30000') {
        return new Response(
          JSON.stringify({ message: 'Amount is too low for bridge, try at least 132000' }),
          { status: 400 }
        )
      }
      return Response.json({
        quote: {
          amountIn: '140000',
          amountOut: amount,
          minAmountOut: amount,
          depositAddress: `t1${'b'.repeat(33)}`,
          deadline: new Date(now + 30 * 60_000).toISOString()
        }
      })
    }
    try {
      const quote = await getPublicActivationQuote(quoteRequest, PUBLIC_MAINNET_CONFIG)
      expect(quote.request.amount).toBe('132000')
      expect(seen).toEqual([
        { amount: '30000', dry: true },
        { amount: '30000', dry: false },
        { amount: '132000', dry: true },
        { amount: '132000', dry: false }
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('requires the final NEAR exec and every receipt to match and succeed', () => {
    const candidate = createPublicCandidate({
      tgas: 250,
      address: 'a.ma.private-mainnet.ref-dev-team.near',
      nonce: '7',
      deadline: '1760000000000',
      txRequests: [request],
      publicKey,
      signature
    })
    const txHash = 'A'.repeat(44)
    expect(
      readPublicTransactionSigner(
        {
          transactions: [
            {
              transaction: {
                hash: txHash,
                receiver_id: candidate.address,
                signer_id: 'operator.near'
              }
            }
          ]
        },
        candidate,
        txHash
      )
    ).toBe('operator.near')
    expect(
      readPublicTransactionSigner(
        {
          transactions: [
            {
              transaction: {
                hash: txHash,
                receiver_id: 'other.near',
                signer_id: 'operator.near'
              }
            }
          ]
        },
        candidate,
        txHash
      )
    ).toBeNull()
    const result = {
      transaction: {
        hash: txHash,
        signer_id: 'operator.near',
        receiver_id: candidate.address,
        actions: [
          {
            FunctionCall: {
              method_name: 'exec',
              args: Buffer.from(
                JSON.stringify({
                  business: JSON.parse(
                    serializePublicBusiness({
                      nonce: candidate.nonce,
                      deadline: candidate.deadline,
                      txRequests: candidate.tx_requests
                    })
                  ),
                  signature: candidate.signature,
                  signer_wallet: candidate.signer_wallet
                })
              ).toString('base64')
            }
          }
        ]
      },
      final_execution_status: 'FINAL',
      status: { SuccessValue: '' },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: 'receipt' } } },
      receipts_outcome: [{ outcome: { status: { SuccessValue: '' } } }]
    }
    expect(verifyPublicExecutionOutcome(result, candidate, txHash)).toEqual({
      status: 'verified',
      signerId: 'operator.near'
    })
    expect(
      verifyPublicExecutionOutcome(
        {
          ...result,
          receipts_outcome: [
            {
              outcome: {
                status: { Failure: { ActionError: {} } }
              }
            }
          ]
        },
        candidate,
        txHash
      )
    ).toEqual({ status: 'failed' })
    expect(
      verifyPublicExecutionOutcome(
        {
          ...result,
          transaction: {
            ...result.transaction,
            receiver_id: 'other.near'
          }
        },
        candidate,
        txHash
      )
    ).toEqual({ status: 'unknown' })
  })

  test('binds expiry evidence to the same final NEAR block as the MCA nonce', () => {
    const hash = 'A'.repeat(44)
    const query = { result: { block_hash: hash, result: [...Buffer.from('"7"')] } }
    const block = { result: { header: { hash, timestamp_nanosec: '1760000000000000000' } } }
    expect(parsePublicNonceSnapshot(query, block)).toEqual({
      nonce: '7',
      finalBlockTimestampMs: 1760000000000
    })
    expect(() =>
      parsePublicNonceSnapshot(query, {
        result: {
          header: {
            ...block.result.header,
            hash: 'B'.repeat(44)
          }
        }
      })
    ).toThrow(/do not match/)
  })
})

// Both entry points must resolve the same signer and retain the reviewed bytes.
test('Protocol signing reuses Lending derived and legacy paths for every HD account', async () => {
  const message = ' {"nonce":"3", "tx_requests":[]}\n'
  for (const index of [0, 2]) {
    for (const mode of ['derived', 'legacy_index0']) {
      const calls = []
      const core = {
        signMessage: async (...args) => {
          calls.push(args)
          return { pubkey: publicKey, address: 't-signer', signature }
        }
      }
      await signApprovedDAppMessage(core, message, index, mode, SIGNING_ACCOUNT_INDEX)
      const lendingCall = calls[0]
      calls.length = 0
      expect(await signPublicMessage(core, index, publicKey, message, mode)).toBe(signature)
      expect(calls).toEqual([lendingCall])
      if (mode === 'derived') expect(lendingCall).toEqual([message, SIGNING_ACCOUNT_INDEX])
      else expect(lendingCall).toEqual([message, index, 0])
    }
  }
  await expect(
    signPublicMessage(
      { signMessage: async () => ({ pubkey: `04${'33'.repeat(64)}`, signature }) },
      0,
      publicKey,
      message,
      'derived'
    )
  ).rejects.toThrow('identity changed')
})
