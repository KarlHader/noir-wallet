import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { address, initEccLib, networks, payments, Psbt } from 'bitcoinjs-lib'
import { Buffer } from 'buffer'
import type { PearlNetwork } from '@noir-wallet/sdk'

const PEARL_DUST_SATS = 330
const DEFAULT_FEE_RATE_SATS_PER_VBYTE = 2
const ESTIMATED_VBYTES_ONE_IN_TWO_OUT = 154

const BLOCKBOOK_API_DIRECT: Readonly<Record<PearlNetwork, string>> = Object.freeze({
  mainnet: 'https://blockbook.pearlresearch.ai/api/v2',
  testnet: 'https://blockbook.testnet.pearlresearch.ai/api/v2'
})

/** Dev uses the Vite same-origin proxy so page CSP cannot block Blockbook. */
function blockbookApiBase(network: PearlNetwork): string {
  if (import.meta.env.DEV) {
    const prefix = network === 'mainnet' ? 'pearl-blockbook' : 'pearl-blockbook-testnet'
    const base = import.meta.env.BASE_URL.endsWith('/')
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`
    return `${base}${prefix}/api/v2`
  }
  return BLOCKBOOK_API_DIRECT[network]
}

const PEARL_BITCOINJS_NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    ...networks.bitcoin,
    messagePrefix: '\x18Pearl Signed Message:\n',
    bech32: 'prl'
  }),
  testnet: Object.freeze({
    ...networks.testnet,
    messagePrefix: '\x18Pearl Signed Message:\n',
    bech32: 'tprl'
  })
})

let eccReady = false

function ensureEcc(): void {
  if (eccReady) return
  initEccLib(secp256k1)
  eccReady = true
}

function normalizePublicKey(publicKey: string): string {
  const hex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey
  if (!/^0[23][0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Pearl public key must be a compressed secp256k1 key.')
  }
  return hex.toLowerCase()
}

interface BlockbookUtxo {
  readonly txid: string
  readonly vout: number
  readonly value: string
  readonly height?: number
  readonly confirmations?: number
}

export interface CreatePearlTestPsbtInput {
  readonly network: PearlNetwork
  readonly account: string
  readonly publicKey: string
  readonly recipient: string
  readonly amountSats: number
  readonly feeRateSatsPerVbyte?: number
}

export async function createPearlTestPsbtHex(input: CreatePearlTestPsbtInput): Promise<string> {
  ensureEcc()
  if (input.amountSats < PEARL_DUST_SATS) {
    throw new Error(`Amount must be at least ${PEARL_DUST_SATS} satoshis.`)
  }
  const network = PEARL_BITCOINJS_NETWORKS[input.network]
  const publicKey = Buffer.from(normalizePublicKey(input.publicKey), 'hex')
  const payment = payments.p2tr({
    internalPubkey: publicKey.subarray(1, 33),
    network
  })
  if (!payment.address || payment.address !== input.account) {
    throw new Error('Pearl public key does not match the connected account address.')
  }
  const recipient = input.recipient.trim() || input.account
  address.toOutputScript(recipient, network)

  const response = await fetch(
    `${blockbookApiBase(input.network)}/utxo/${encodeURIComponent(input.account)}`
  )
  if (!response.ok) throw new Error(`Pearl Blockbook UTXO request failed (${response.status}).`)
  const utxos = (await response.json()) as BlockbookUtxo[]
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error('No confirmed Pearl UTXOs are available for this account.')
  }
  const spendable = utxos
    .filter(utxo => (utxo.confirmations ?? 0) > 0 || (utxo.height ?? 0) > 0)
    .map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: BigInt(utxo.value)
    }))
    .sort((left, right) => (right.value > left.value ? 1 : right.value < left.value ? -1 : 0))
  if (spendable.length === 0) {
    throw new Error('No confirmed Pearl UTXOs are available for this account.')
  }

  const feeRate = input.feeRateSatsPerVbyte ?? DEFAULT_FEE_RATE_SATS_PER_VBYTE
  const feeSats = BigInt(ESTIMATED_VBYTES_ONE_IN_TWO_OUT * feeRate)
  const amount = BigInt(input.amountSats)
  const selected = spendable.find(utxo => utxo.value >= amount + feeSats + BigInt(PEARL_DUST_SATS))
  if (!selected) {
    throw new Error('Insufficient confirmed Pearl funds for amount, fee, and change dust.')
  }
  const changeSats = selected.value - amount - feeSats
  if (changeSats < BigInt(PEARL_DUST_SATS)) {
    throw new Error('Change would be below the Pearl dust limit; lower the amount.')
  }

  const psbt = new Psbt({ network })
  psbt.setVersion(2)
  psbt.addInput({
    hash: selected.txid,
    index: selected.vout,
    sequence: 0xfffffffd,
    witnessUtxo: {
      script: address.toOutputScript(input.account, network),
      value: Number(selected.value)
    },
    tapInternalKey: publicKey.subarray(1, 33)
  })
  psbt.addOutput({ address: recipient, value: Number(amount) })
  psbt.addOutput({ address: input.account, value: Number(changeSats) })
  return psbt.toHex()
}
