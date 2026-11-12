import assert from 'node:assert/strict'
import { it } from 'node:test'

import { ledgerSigningChainFamily } from '../../../src/background/ledger-chain-family.ts'

it('maps the starknet namespace to the starknet chain family', () => {
  assert.equal(ledgerSigningChainFamily('starknet:SN_SEPOLIA'), 'starknet')
  assert.equal(ledgerSigningChainFamily('starknet:SN_MAIN'), 'starknet')
})

it('keeps the existing Ledger chain family mappings', () => {
  assert.equal(ledgerSigningChainFamily('eip155:1'), 'evm')
  assert.equal(ledgerSigningChainFamily('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), 'solana')
  assert.equal(ledgerSigningChainFamily('near:testnet'), 'near')
  assert.equal(ledgerSigningChainFamily('bip122:000000000019d6689c085ae165831e93'), 'bitcoin')
  assert.equal(ledgerSigningChainFamily('bip122:00000ffd590b1485b3caadc19b22e637'), 'dash')
})

it('rejects unknown namespaces', () => {
  assert.equal(ledgerSigningChainFamily('cosmos:cosmoshub-4'), null)
  assert.equal(ledgerSigningChainFamily('bitcoin:000000000019d6689c085ae165831e93'), null)
})
