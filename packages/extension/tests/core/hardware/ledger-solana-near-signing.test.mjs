import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519'
import { VersionedTransaction } from '@solana/web3.js'
import { utils } from 'near-api-js'
import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import { buildSolanaNativeTransfer } from '../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'
import { encodeSolanaBase58 } from '../../../src/infrastructure/chains/solana/solana-rpc-codecs.ts'
import { SolanaMultichainSigningClient } from '../../../src/infrastructure/keyring/multichain/solana-signing-client.ts'
import { NearMultichainSigningClient } from '../../../src/infrastructure/keyring/multichain/near-signing-client.ts'

const credentials = {
  getCredentialBinding: async () => {
    throw new Error('software signer must not run')
  }
}
const keyDomainId = 'key-domain:ledger:test'
const accountId = 'account:ledger:test'
const privateKey = new Uint8Array(32).fill(7)
const publicKey = ed25519.getPublicKey(privateKey)

it('signs the exact Solana transfer bytes through the external Ledger bridge', async () => {
  const chainId = parseChainId('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1').id
  const address = encodeSolanaBase58(publicKey)
  const transfer = buildSolanaNativeTransfer({
    chainId,
    sender: address,
    recipient: encodeSolanaBase58(new Uint8Array(32).fill(9)),
    recentBlockhash: encodeSolanaBase58(new Uint8Array(32).fill(8)),
    lamports: '1000'
  })
  const account = { accountId, path: "m/44'/501'/4'", publicKey: address, address }
  let signingRequest
  const client = new SolanaMultichainSigningClient({
    credentials,
    ledger: {
      resolveAccount: async () => account,
      requestSignature: async (request, binding) => {
        signingRequest = request
        await binding.validate()
        const transaction = VersionedTransaction.deserialize(
          Buffer.from(request.transactionBase64, 'base64')
        )
        const signature = ed25519.sign(transaction.message.serialize(), privateKey)
        transaction.signatures[0] = signature
        return {
          kind: 'solana-transaction',
          publicKey: address,
          signature: encodeSolanaBase58(signature),
          signedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64')
        }
      }
    }
  })
  const prepared = await client.prepare(keyDomainId, {
    kind: 'solana-transaction',
    chainId,
    accountIndex: 4,
    transaction: transfer.transactionBase64
  })
  assert.equal(prepared.execution.kind, 'external')
  assert.equal(prepared.summary.schema, 'solana.transaction.v1')
  const signed = await client.confirm(keyDomainId, prepared.commandId)
  assert.equal(signingRequest.path, account.path)
  assert.equal(signed.kind, 'signed-payload')
  assert.equal(
    signed.transactionId,
    encodeSolanaBase58(
      VersionedTransaction.deserialize(Buffer.from(signed.payload.value, 'base64')).signatures[0]
    )
  )
  await client.destroy()
})

it('binds NEAR transaction and NEP-413 signatures to the registered public key', async () => {
  const chainId = parseChainId('near:mainnet').id
  const nearKey = `ed25519:${utils.serialize.base_encode(publicKey)}`
  const address = Buffer.from(publicKey).toString('hex')
  const account = { accountId, path: "m/44'/397'/0'/0'/1'", publicKey: nearKey, address }
  const requests = []
  const client = new NearMultichainSigningClient({
    credentials,
    ledger: {
      resolveAccount: async () => account,
      requestSignature: async (request, binding) => {
        await binding.validate()
        requests.push(request)
        const payload = Buffer.from(request.payloadBase64, 'base64')
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload))
        return {
          kind: request.kind,
          publicKey: nearKey,
          signatureBase64: Buffer.from(ed25519.sign(digest, privateKey)).toString('base64')
        }
      }
    }
  })
  const transaction = {
    chainId,
    accountIndex: 0,
    signerId: address,
    receiverId: 'recipient.near',
    nonce: '1',
    blockHash: utils.serialize.base_encode(new Uint8Array(32).fill(8)),
    actions: [{ type: 'transfer', depositYocto: '1000' }]
  }
  const preparedTx = await client.prepare(keyDomainId, {
    kind: 'near-transaction',
    chainId,
    accountIndex: 0,
    transaction
  })
  assert.equal(preparedTx.execution.kind, 'external')
  const signedTx = await client.confirm(keyDomainId, preparedTx.commandId)
  assert.equal(signedTx.kind, 'signed-payload')
  assert.ok(signedTx.payload.value.length > 0)
  const preparedMessage = await client.prepare(keyDomainId, {
    kind: 'near-nep413-message',
    chainId,
    accountIndex: 0,
    request: {
      chainId,
      accountIndex: 0,
      accountId: address,
      message: 'Sign in',
      recipient: 'example.near',
      nonce: Buffer.alloc(32, 3).toString('base64'),
      callbackUrl: null,
      state: null
    }
  })
  const signedMessage = await client.confirm(keyDomainId, preparedMessage.commandId)
  assert.equal(signedMessage.kind, 'signature')
  assert.equal(signedMessage.address, address)
  assert.deepEqual(
    Buffer.from(requests[1].payloadBase64, 'base64').subarray(0, 4),
    Buffer.from([0x9d, 1, 0, 0x80])
  )
  await client.destroy()
})

it('resumes the original Solana Ledger request once with its original expiry and account', async () => {
  const chainId = parseChainId('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1').id
  const address = encodeSolanaBase58(publicKey)
  const transaction = buildSolanaNativeTransfer({
    chainId,
    sender: address,
    recipient: encodeSolanaBase58(new Uint8Array(32).fill(9)),
    recentBlockhash: encodeSolanaBase58(new Uint8Array(32).fill(8)),
    lamports: '1000'
  }).transactionBase64
  const payload = { kind: 'solana-transaction', chainId, accountIndex: 0, transaction }
  const account = { accountId, path: "m/44'/501'/0'", publicKey: address, address }
  let current = 1_000
  let release
  const wait = new Promise(resolve => {
    release = resolve
  })
  let seenExpiry
  const ledger = {
    resolveAccount: async () => account,
    requestSignature: async (request, binding) => {
      seenExpiry = binding.expiresAt
      await wait
      const signed = VersionedTransaction.deserialize(
        Buffer.from(request.transactionBase64, 'base64')
      )
      const signature = ed25519.sign(signed.message.serialize(), privateKey)
      signed.signatures[0] = signature
      return {
        kind: request.kind,
        publicKey: address,
        signature: encodeSolanaBase58(signature),
        signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64')
      }
    }
  }
  const original = new SolanaMultichainSigningClient({ credentials, ledger, now: () => current })
  const prepared = await original.prepare(keyDomainId, payload)
  await original.destroy()
  const resumed = new SolanaMultichainSigningClient({ credentials, ledger, now: () => current })
  const recovery = { accountId, payload, prepared }
  const first = resumed.confirm(
    keyDomainId,
    prepared.commandId,
    undefined,
    undefined,
    prepared.execution,
    recovery
  )
  await assert.rejects(
    resumed.confirm(
      keyDomainId,
      prepared.commandId,
      undefined,
      undefined,
      prepared.execution,
      recovery
    ),
    /already confirming/
  )
  release()
  assert.equal((await first).kind, 'signed-payload')
  assert.equal(seenExpiry, prepared.expiresAt)
  const changedAccount = new SolanaMultichainSigningClient({
    credentials,
    ledger: {
      ...ledger,
      resolveAccount: async () => ({ ...account, accountId: 'account:other' })
    },
    now: () => current
  })
  await assert.rejects(
    changedAccount.confirm(
      keyDomainId,
      prepared.commandId,
      undefined,
      undefined,
      prepared.execution,
      recovery
    ),
    /recovery binding/
  )
  await assert.rejects(
    resumed.confirm(keyDomainId, prepared.commandId, undefined, undefined, prepared.execution, {
      ...recovery,
      payload: { ...payload, transaction: transaction.slice(0, -4) + 'AAAA' }
    }),
    /recovery binding|base64|transaction/
  )
  current = prepared.expiresAt
  await assert.rejects(
    resumed.confirm(
      keyDomainId,
      prepared.commandId,
      undefined,
      undefined,
      prepared.execution,
      recovery
    ),
    /expired/
  )
  await Promise.all([resumed.destroy(), changedAccount.destroy()])
})

it('rebuilds the NEAR Borsh payload and summary before resuming Ledger signing', async () => {
  const chainId = parseChainId('near:mainnet').id
  const nearKey = `ed25519:${utils.serialize.base_encode(publicKey)}`
  const address = Buffer.from(publicKey).toString('hex')
  const account = { accountId, path: "m/44'/397'/0'/0'/0'", publicKey: nearKey, address }
  const payload = {
    kind: 'near-transaction',
    chainId,
    accountIndex: 0,
    transaction: {
      chainId,
      accountIndex: 0,
      signerId: address,
      receiverId: 'recipient.near',
      nonce: '1',
      blockHash: utils.serialize.base_encode(new Uint8Array(32).fill(8)),
      actions: [{ type: 'transfer', depositYocto: '1000' }]
    }
  }
  let current = 2_000
  let seenExpiry
  const ledger = {
    resolveAccount: async () => account,
    requestSignature: async (request, binding) => {
      seenExpiry = binding.expiresAt
      await binding.validate()
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', Buffer.from(request.payloadBase64, 'base64'))
      )
      return {
        kind: request.kind,
        publicKey: nearKey,
        signatureBase64: Buffer.from(ed25519.sign(digest, privateKey)).toString('base64')
      }
    }
  }
  const original = new NearMultichainSigningClient({ credentials, ledger, now: () => current })
  const prepared = await original.prepare(keyDomainId, payload)
  await original.destroy()
  const resumed = new NearMultichainSigningClient({ credentials, ledger, now: () => current })
  const recovery = { accountId, payload, prepared }
  assert.equal(
    (
      await resumed.confirm(
        keyDomainId,
        prepared.commandId,
        undefined,
        undefined,
        prepared.execution,
        recovery
      )
    ).kind,
    'signed-payload'
  )
  assert.equal(seenExpiry, prepared.expiresAt)
  await assert.rejects(
    resumed.confirm(keyDomainId, prepared.commandId, undefined, undefined, prepared.execution, {
      ...recovery,
      payload: { ...payload, transaction: { ...payload.transaction, nonce: '2' } }
    }),
    /recovery binding/
  )
  const changedAccount = new NearMultichainSigningClient({
    credentials,
    ledger: {
      ...ledger,
      resolveAccount: async () => ({ ...account, accountId: 'account:other' })
    },
    now: () => current
  })
  await assert.rejects(
    changedAccount.confirm(
      keyDomainId,
      prepared.commandId,
      undefined,
      undefined,
      prepared.execution,
      recovery
    ),
    /account changed/
  )
  current = prepared.expiresAt
  await assert.rejects(
    resumed.confirm(
      keyDomainId,
      prepared.commandId,
      undefined,
      undefined,
      prepared.execution,
      recovery
    ),
    /expired/
  )
  await Promise.all([resumed.destroy(), changedAccount.destroy()])
})
