import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { expect, test } from '@playwright/test'
import { initEccLib, networks, payments } from 'bitcoinjs-lib'

import { BITCOIN_NETWORKS } from '../../../src/config/networks.ts'
import { RPC_DEFAULT_ENDPOINTS } from '../../../src/config/rpc-endpoints.ts'
import { createBitcoinEsploraClient } from '../../../src/infrastructure/chains/bitcoin/bitcoin-esplora-client.ts'

initEccLib(secp256k1)

const GENESIS_COINBASE_TRANSACTION_ID =
  '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'

function probeAddress(network) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = 1
  const value = payments.p2wpkh({
    pubkey: Buffer.from(secp256k1.pointFromScalar(privateKey, true)),
    network: network === 'mainnet' ? networks.bitcoin : networks.testnet
  }).address
  if (!value) throw new Error('Unable to derive the Bitcoin history probe address')
  return value
}

test.describe('live trusted Bitcoin Esplora profiles', () => {
  test.skip(process.env.LIVE_BITCOIN_ESPLORA !== '1', 'Set LIVE_BITCOIN_ESPLORA=1 to enable')

  for (const network of ['mainnet', 'testnet']) {
    const endpoint = RPC_DEFAULT_ENDPOINTS.bitcoin[network]
    test(`probes ${network} through ${endpoint.id}`, async () => {
      const client = createBitcoinEsploraClient({
        chainId: BITCOIN_NETWORKS[network].chainId,
        baseUrl: endpoint.url
      })

      await client.assertExpectedChain()
      const tipHeight = await client.getTipHeight()
      const feeEstimates = await client.getFeeEstimates()
      const addressHistory = await client.getAddressTransactions(probeAddress(network))
      const genesisCoinbaseSpend = await client.getOutputSpendStatus(
        GENESIS_COINBASE_TRANSACTION_ID,
        0
      )
      expect(tipHeight).toBeGreaterThan(0)
      expect(Object.keys(feeEstimates).length).toBeGreaterThan(0)
      expect(Array.isArray(addressHistory)).toBe(true)
      expect(genesisCoinbaseSpend).toEqual({ spent: false })
    })
  }
})
