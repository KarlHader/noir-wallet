import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  ledgerEvmDerivationPath,
  ledgerNearDerivationPath,
  ledgerSolanaDerivationPath,
  validateLedgerEvmDerivationPath,
  validateLedgerNearDerivationPath,
  validateLedgerSolanaDerivationPath
} from '../../../src/core/wallet/ledger-derivation-path.ts'

it('generates and accepts Ledger account paths used by common wallets', () => {
  for (const [mode, expected] of [
    ['ledger-live', "m/44'/60'/3'/0/0"],
    ['standard', "m/44'/60'/0'/0/3"],
    ['legacy', "m/44'/60'/0'/3"]
  ]) {
    assert.equal(validateLedgerEvmDerivationPath(ledgerEvmDerivationPath(mode, 3)), expected)
  }
  for (const [mode, expected] of [
    ['standard', "m/44'/501'/3'/0'"],
    ['legacy', "m/44'/501'/3'"]
  ]) {
    assert.equal(validateLedgerSolanaDerivationPath(ledgerSolanaDerivationPath(mode, 3)), expected)
  }
  assert.equal(
    validateLedgerSolanaDerivationPath(ledgerSolanaDerivationPath('root', 0)),
    "m/44'/501'"
  )
  assert.equal(validateLedgerSolanaDerivationPath("m/44'/501'/3'/0'/2'"), "m/44'/501'/3'/0'/2'")
  assert.equal(
    validateLedgerNearDerivationPath(ledgerNearDerivationPath('standard', 3)),
    "m/44'/397'/0'/0'/3'"
  )
  assert.equal(
    validateLedgerNearDerivationPath(ledgerNearDerivationPath('noir', 3)),
    "m/44'/397'/3'/0'/1'"
  )
})

it('rejects ambiguous and overflowing paths before device access', () => {
  for (const validate of [
    validateLedgerEvmDerivationPath,
    validateLedgerSolanaDerivationPath,
    validateLedgerNearDerivationPath
  ]) {
    assert.throws(() => validate("m/44'/999'/2147483648'"), /Ledger/)
    assert.throws(() => validate("m/44'/999'/00'"), /canonical/i)
  }
  assert.throws(() => validateLedgerEvmDerivationPath("m/44'/60'/0'/0'/1'"), /path/)
  assert.throws(() => validateLedgerSolanaDerivationPath("m/44'/501'/0'/0"), /path/)
  assert.throws(() => ledgerSolanaDerivationPath('root', 1), /root/)
  assert.throws(() => ledgerNearDerivationPath('standard', 0x80000000), /index/)
})
