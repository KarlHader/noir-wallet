import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import {
  createSolanaRpcClient,
  SOLANA_TOKEN_PROGRAMS,
  SolanaRpcError
} from '../../../../src/infrastructure/chains/solana/solana-rpc-client.ts'

const address = '11111111111111111111111111111111'
const secondAddress = '11111111111111111111111111111112'
const blockhash = '11111111111111111111111111111111'
const signature = '1'.repeat(64)
const lookupTableProgram = 'AddressLookupTab1e1111111111111111111111111'

function lookupTableData() {
  const data = Buffer.alloc(56 + 64)
  data.writeUInt32LE(1, 0)
  data.fill(0xff, 4, 12)
  data.writeBigUInt64LE(42n, 12)
  data[20] = 1
  data[21] = 1
  data[56 + 63] = 1
  return data
}

function jsonResult(body, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function harness(respond) {
  const calls = []
  const client = createSolanaRpcClient(
    {
      chainId: SOLANA_NETWORKS.devnet.chainId,
      rpcUrl: 'https://solana.example'
    },
    async (input, init) => {
      const body = JSON.parse(init.body)
      calls.push({ input, init, body })
      return respond(body, init)
    }
  )
  return { client, calls }
}

test.describe('Solana JSON-RPC client', () => {
  test('attests the full genesis hash and binds balance reads to confirmed commitment', async () => {
    const state = harness(body => {
      if (body.method === 'getGenesisHash') {
        return jsonResult(body, SOLANA_NETWORKS.devnet.genesisHash)
      }
      if (body.method === 'getBalance') {
        return jsonResult(body, { context: { slot: 42 }, value: 123_456 })
      }
      throw new Error('unexpected method')
    })

    await expect(state.client.assertExpectedChain()).resolves.toBeUndefined()
    await expect(state.client.getBalance(address)).resolves.toBe('123456')
    expect(state.calls.map(call => call.body)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'getBalance',
        params: [address, { commitment: 'confirmed' }]
      }
    ])
    expect(state.calls[0].input).toBe('https://solana.example/')
    expect(state.calls[0].init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })
  })

  test('reads bounded blockhash, block height and transaction status responses', async () => {
    const state = harness(body => {
      if (body.method === 'getLatestBlockhash') {
        return jsonResult(body, {
          context: { slot: 10, apiVersion: '2.2.0' },
          value: { blockhash, lastValidBlockHeight: 20 }
        })
      }
      if (body.method === 'getBlockHeight') return jsonResult(body, 11)
      if (body.method === 'getSignatureStatuses') {
        return jsonResult(body, {
          context: { slot: 12 },
          value: [
            {
              slot: 9,
              confirmations: null,
              err: null,
              status: { Ok: null },
              confirmationStatus: 'finalized'
            }
          ]
        })
      }
      throw new Error('unexpected method')
    })

    await expect(state.client.getLatestBlockhash()).resolves.toEqual({
      contextSlot: 10,
      blockhash,
      lastValidBlockHeight: 20
    })
    await expect(state.client.getBlockHeight()).resolves.toBe(11)
    await expect(state.client.getSignatureStatus(signature)).resolves.toEqual({
      status: 'finalized',
      contextSlot: 12,
      slot: 9,
      confirmations: null
    })
    expect(state.calls.at(-1).body.params).toEqual([
      [signature],
      { searchTransactionHistory: true }
    ])
  })

  test('reads address signatures and computes owner-native and token deltas', async () => {
    const state = harness(body => {
      if (body.method === 'getSignaturesForAddress') {
        return jsonResult(body, [
          {
            signature,
            slot: 42,
            blockTime: 1_700_000_000,
            err: null,
            memo: null,
            confirmationStatus: 'finalized'
          }
        ])
      }
      if (body.method === 'getTransaction') {
        return jsonResult(body, {
          slot: 42,
          blockTime: 1_700_000_000,
          version: 0,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [
                { pubkey: address, signer: true, source: 'transaction', writable: true },
                { pubkey: secondAddress, signer: false, source: 'transaction', writable: true }
              ],
              instructions: [],
              recentBlockhash: blockhash
            }
          },
          meta: {
            err: null,
            fee: 5000,
            preBalances: [1_000_000, 0],
            postBalances: [895_000, 100_000],
            preTokenBalances: [],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: secondAddress,
                owner: address,
                programId: SOLANA_TOKEN_PROGRAMS.legacy.programId,
                uiTokenAmount: {
                  amount: '2500000',
                  decimals: 6,
                  uiAmount: 2.5,
                  uiAmountString: '2.5'
                }
              }
            ]
          }
        })
      }
      throw new Error('unexpected method')
    })

    await expect(state.client.getSignaturesForAddress(address, 10, signature)).resolves.toEqual([
      {
        signature,
        slot: 42,
        blockTime: 1_700_000_000,
        status: 'finalized'
      }
    ])
    await expect(state.client.getTransactionSummary(signature, address)).resolves.toEqual({
      signature,
      slot: 42,
      blockTime: 1_700_000_000,
      failed: false,
      feeRaw: '5000',
      nativeDeltaRaw: '-105000',
      tokenDeltas: [{ mint: secondAddress, amountRaw: '2500000', decimals: 6 }]
    })
    expect(state.calls[0].body.params).toEqual([
      address,
      { commitment: 'confirmed', limit: 10, until: signature }
    ])
    expect(state.calls[1].body.params).toEqual([
      signature,
      { commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
    ])
  })

  test('reads exact SPL Token and Token-2022 owner balances without trusting UI amounts', async () => {
    const state = harness(body => {
      if (body.method !== 'getTokenAccountsByOwner') throw new Error('unexpected method')
      const programId = body.params[1].programId
      const token2022 = programId === SOLANA_TOKEN_PROGRAMS.token2022.programId
      return jsonResult(body, {
        context: { slot: 71 },
        value: [
          {
            pubkey: address,
            account: {
              data: {
                program: token2022 ? 'spl-token-2022' : 'spl-token',
                parsed: {
                  info: {
                    isNative: false,
                    mint: address,
                    owner: address,
                    state: 'initialized',
                    tokenAmount: {
                      amount: '18446744073709551615',
                      decimals: 9,
                      uiAmount: 18_446_744_073.709553,
                      uiAmountString: '18446744073.709551615'
                    },
                    ...(token2022 ? { extensions: [{ extension: 'immutableOwner' }] } : {})
                  },
                  type: 'account'
                },
                space: token2022 ? 170 : 165
              },
              executable: false,
              lamports: 2_039_280,
              owner: programId,
              rentEpoch: 18446744073709552000,
              space: token2022 ? 170 : 165
            }
          }
        ]
      })
    })

    await expect(state.client.getTokenAccountsByOwner(address, 'legacy')).resolves.toEqual({
      contextSlot: 71,
      accounts: [
        {
          accountAddress: address,
          program: 'legacy',
          mint: address,
          owner: address,
          state: 'initialized',
          isNative: false,
          amountRaw: '18446744073709551615',
          decimals: 9
        }
      ]
    })
    await expect(state.client.getTokenAccountsByOwner(address, 'token2022')).resolves.toEqual({
      contextSlot: 71,
      accounts: [expect.objectContaining({ program: 'token2022' })]
    })
    expect(state.calls.map(call => call.body.params)).toEqual([
      [
        address,
        { programId: SOLANA_TOKEN_PROGRAMS.legacy.programId },
        { commitment: 'confirmed', encoding: 'jsonParsed' }
      ],
      [
        address,
        { programId: SOLANA_TOKEN_PROGRAMS.token2022.programId },
        { commitment: 'confirmed', encoding: 'jsonParsed' }
      ]
    ])
  })

  test('reads known token ATAs without an indexed owner query', async () => {
    const mint = secondAddress
    let associatedTokenAddress = ''
    const state = harness(body => {
      if (body.method !== 'getMultipleAccounts') throw new Error('unexpected method')
      if (body.params[1].encoding === 'base64') {
        return jsonResult(body, {
          context: { slot: 70 },
          value: [
            {
              data: ['', 'base64'],
              executable: false,
              lamports: 1,
              owner: SOLANA_TOKEN_PROGRAMS.legacy.programId,
              rentEpoch: 1,
              space: 82
            }
          ]
        })
      }
      associatedTokenAddress = body.params[0][0]
      return jsonResult(body, {
        context: { slot: 71 },
        value: [
          {
            data: {
              program: 'spl-token',
              parsed: {
                info: {
                  isNative: false,
                  mint,
                  owner: address,
                  state: 'initialized',
                  tokenAmount: {
                    amount: '2500000',
                    decimals: 6,
                    uiAmount: 2.5,
                    uiAmountString: '2.5'
                  }
                },
                type: 'account'
              },
              space: 165
            },
            executable: false,
            lamports: 2_039_280,
            owner: SOLANA_TOKEN_PROGRAMS.legacy.programId,
            rentEpoch: 1,
            space: 165
          }
        ]
      })
    })

    await expect(state.client.getTokenAccountsByMints(address, [mint])).resolves.toEqual({
      contextSlot: 71,
      accounts: [
        {
          accountAddress: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
          program: 'legacy',
          mint,
          owner: address,
          state: 'initialized',
          isNative: false,
          amountRaw: '2500000',
          decimals: 6
        }
      ]
    })
    expect(associatedTokenAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    expect(state.calls.map(call => call.body.method)).toEqual([
      'getMultipleAccounts',
      'getMultipleAccounts'
    ])
    expect(state.calls[0].body.params).toEqual([
      [mint],
      { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }
    ])
  })

  test('reads a bounded Address Lookup Table owned by the canonical program', async () => {
    const data = lookupTableData()
    const state = harness(body =>
      jsonResult(body, {
        context: { slot: 81 },
        value: {
          data: [data.toString('base64'), 'base64'],
          executable: false,
          lamports: 1,
          owner: lookupTableProgram,
          rentEpoch: 1,
          space: data.byteLength
        }
      })
    )

    await expect(state.client.getAddressLookupTable(address)).resolves.toEqual({
      address,
      contextSlot: 81,
      deactivationSlot: '18446744073709551615',
      lastExtendedSlot: '42',
      lastExtendedStartIndex: 1,
      authority: address,
      addresses: [address, secondAddress]
    })
    expect(state.calls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { commitment: 'confirmed', encoding: 'base64' }]
    })
  })

  test('distinguishes a missing lookup table and rejects forged lookup table accounts', async () => {
    const missing = harness(body => jsonResult(body, { context: { slot: 1 }, value: null }))
    await expect(missing.client.getAddressLookupTable(address)).resolves.toBeNull()

    const wrongOwner = harness(body =>
      jsonResult(body, {
        context: { slot: 1 },
        value: {
          data: [lookupTableData().toString('base64'), 'base64'],
          executable: false,
          lamports: 1,
          owner: address,
          rentEpoch: 1,
          space: 120
        }
      })
    )
    await expect(wrongOwner.client.getAddressLookupTable(address)).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const malformedData = lookupTableData()
    malformedData[0] = 2
    const malformed = harness(body =>
      jsonResult(body, {
        context: { slot: 1 },
        value: {
          data: [malformedData.toString('base64'), 'base64'],
          executable: false,
          lamports: 1,
          owner: lookupTableProgram,
          rentEpoch: 1,
          space: malformedData.byteLength
        }
      })
    )
    await expect(malformed.client.getAddressLookupTable(address)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  test('rejects token accounts with mismatched owner, program, duplicates or invalid u64', async () => {
    const tokenAccount = {
      pubkey: address,
      account: {
        data: {
          program: 'spl-token',
          parsed: {
            info: {
              isNative: false,
              mint: address,
              owner: address,
              state: 'initialized',
              tokenAmount: {
                amount: '1',
                decimals: 0,
                uiAmount: 1,
                uiAmountString: '1'
              }
            },
            type: 'account'
          },
          space: 165
        },
        executable: false,
        lamports: 1,
        owner: SOLANA_TOKEN_PROGRAMS.legacy.programId,
        rentEpoch: 1
      }
    }
    const testInvalid = async mutate => {
      const value = structuredClone(tokenAccount)
      mutate(value)
      const state = harness(body => jsonResult(body, { context: { slot: 1 }, value: [value] }))
      await expect(state.client.getTokenAccountsByOwner(address, 'legacy')).rejects.toMatchObject({
        code: 'invalid-response'
      })
    }

    await testInvalid(value => {
      value.account.data.parsed.info.owner = blockhash.slice(0, -1) + '2'
    })
    await testInvalid(value => {
      value.account.owner = SOLANA_TOKEN_PROGRAMS.token2022.programId
    })
    await testInvalid(value => {
      value.account.data.parsed.info.tokenAmount.amount = '18446744073709551616'
    })

    const duplicate = harness(body =>
      jsonResult(body, {
        context: { slot: 1 },
        value: [tokenAccount, structuredClone(tokenAccount)]
      })
    )
    await expect(duplicate.client.getTokenAccountsByOwner(address, 'legacy')).rejects.toMatchObject(
      {
        code: 'invalid-response'
      }
    )
    await expect(duplicate.client.getTokenAccountsByOwner(address, 'unknown')).rejects.toThrow(
      /token program/
    )
  })

  test('broadcasts only a bounded base64 transaction and validates the returned signature', async () => {
    const state = harness(body => jsonResult(body, signature))

    await expect(state.client.broadcastSignedTransaction('AQ==')).resolves.toBe(signature)
    expect(state.calls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [
        'AQ==',
        {
          encoding: 'base64',
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 3
        }
      ]
    })
    await expect(
      state.client.broadcastSignedTransaction('AQ==', undefined, {
        preflightCommitment: 'processed',
        minContextSlot: 42,
        skipPreflight: true,
        maxRetries: 7
      })
    ).resolves.toBe(signature)
    expect(state.calls[1].body.params[1]).toEqual({
      encoding: 'base64',
      skipPreflight: true,
      preflightCommitment: 'processed',
      maxRetries: 7,
      minContextSlot: 42
    })
    await expect(state.client.broadcastSignedTransaction('not-base64')).rejects.toThrow(
      /signed transaction/
    )
    await expect(state.client.broadcastSignedTransaction('AB==')).rejects.toThrow(
      /signed transaction/
    )
    await expect(
      state.client.broadcastSignedTransaction(Buffer.alloc(1_233).toString('base64'))
    ).rejects.toThrow(/signed transaction/)
  })

  test('quotes the exact message fee and simulates the complete unsigned transaction', async () => {
    const messageBase64 = Buffer.from([1, 2, 3]).toString('base64')
    const transactionBase64 = Buffer.from([1, 0, 0]).toString('base64')
    const state = harness(body => {
      if (body.method === 'getFeeForMessage') {
        return jsonResult(body, { context: { slot: 90 }, value: 5_000 })
      }
      return jsonResult(body, {
        context: { slot: 91 },
        value: {
          accounts: null,
          err: null,
          fee: 5_000,
          innerInstructions: null,
          loadedAccountsDataSize: 142,
          loadedAddresses: { readonly: [], writable: [] },
          logs: ['Program 11111111111111111111111111111111 success'],
          postBalances: [994_999, 5_000, 1],
          postTokenBalances: [],
          preBalances: [1_000_000, 0, 1],
          preTokenBalances: [],
          replacementBlockhash: null,
          returnData: null,
          unitsConsumed: 150
        }
      })
    })

    await expect(state.client.getFeeForMessage(messageBase64)).resolves.toEqual({
      contextSlot: 90,
      feeLamports: '5000'
    })
    await expect(state.client.simulateTransaction(transactionBase64)).resolves.toEqual({
      contextSlot: 91,
      unitsConsumed: 150
    })
    expect(state.calls.map(call => call.body)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getFeeForMessage',
        params: [messageBase64, { commitment: 'confirmed' }]
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'simulateTransaction',
        params: [
          transactionBase64,
          {
            commitment: 'confirmed',
            encoding: 'base64',
            replaceRecentBlockhash: false,
            sigVerify: false
          }
        ]
      }
    ])

    const missingFee = harness(body => jsonResult(body, { context: { slot: 1 }, value: null }))
    await expect(missingFee.client.getFeeForMessage(messageBase64)).rejects.toMatchObject({
      code: 'rpc-error'
    })
    const failedSimulation = harness(body =>
      jsonResult(body, {
        context: { slot: 1 },
        value: { err: { InstructionError: [0, 'InsufficientFunds'] }, logs: [], unitsConsumed: 0 }
      })
    )
    await expect(
      failedSimulation.client.simulateTransaction(transactionBase64)
    ).rejects.toMatchObject({ code: 'rpc-error', contextSlot: 1, unitsConsumed: 0 })
  })

  test('fails closed for chain mismatch, unsafe numbers and inconsistent status evidence', async () => {
    const wrongChain = harness(body => jsonResult(body, SOLANA_NETWORKS.mainnet.genesisHash))
    await expect(wrongChain.client.assertExpectedChain()).rejects.toMatchObject({
      code: 'chain-mismatch'
    })

    const unsafeBalance = harness(body =>
      jsonResult(body, { context: { slot: 1 }, value: Number.MAX_SAFE_INTEGER + 1 })
    )
    await expect(unsafeBalance.client.getBalance(address)).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const inconsistent = harness(body =>
      jsonResult(body, {
        context: { slot: 12 },
        value: [
          {
            slot: 9,
            confirmations: null,
            err: { InstructionError: [0, 'InvalidArgument'] },
            status: { Ok: null },
            confirmationStatus: 'finalized'
          }
        ]
      })
    )
    await expect(inconsistent.client.getSignatureStatus(signature)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  test('rejects unsafe configuration, malformed envelopes, HTTP errors and cancellation', async () => {
    expect(() =>
      createSolanaRpcClient({
        chainId: 'eip155:1',
        rpcUrl: 'https://solana.example'
      })
    ).toThrow(/Solana chain/)
    expect(() =>
      createSolanaRpcClient({
        chainId: SOLANA_NETWORKS.devnet.chainId,
        rpcUrl: 'https://user:secret@solana.example'
      })
    ).toThrow(/credential-free HTTPS/)

    const malformed = harness(
      body => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id + 1, result: 1 }))
    )
    await expect(malformed.client.getBlockHeight()).rejects.toBeInstanceOf(SolanaRpcError)
    await expect(malformed.client.getBlockHeight()).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const rateLimited = harness(() => new Response('', { status: 429 }))
    await expect(rateLimited.client.getBlockHeight()).rejects.toMatchObject({
      code: 'rate-limited'
    })

    const controller = new AbortController()
    controller.abort()
    await expect(rateLimited.client.getBlockHeight(controller.signal)).rejects.toMatchObject({
      code: 'cancelled'
    })
  })
})
