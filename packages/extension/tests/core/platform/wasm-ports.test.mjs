import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { parseSigningCommandId } from '../../../src/core/keyring/ports/index.ts'

const credentialSource = readFileSync(
  new URL('../../../src/core/keyring/ports/credential.ts', import.meta.url),
  'utf8'
)
const signingSource = readFileSync(
  new URL('../../../src/core/keyring/ports/signing.ts', import.meta.url),
  'utf8'
)
const zcashSignerSource = readFileSync(
  new URL('../../../src/core/keyring/ports/zcash-signer.ts', import.meta.url),
  'utf8'
)
const multichainSignerSource = readFileSync(
  new URL('../../../src/core/keyring/ports/multichain-signer.ts', import.meta.url),
  'utf8'
)
const portSource = [
  credentialSource,
  signingSource,
  zcashSignerSource,
  multichainSignerSource
].join('\n')

test.describe('Dual WASM ports', () => {
  test('uses opaque product signing command IDs', () => {
    expect(parseSigningCommandId('signing-command:1')).toBe('signing-command:1')
    expect(() => parseSigningCommandId('')).toThrow(/SigningCommandId/)
    expect(() => parseSigningCommandId(' signing-command:1')).toThrow(/SigningCommandId/)
  })

  test('keeps raw engine handles out of application-facing ports', () => {
    expect(portSource).not.toMatch(/\b(?:sessionId|requestId)\b/)
    expect(signingSource).toContain('commandId: SigningCommandId')
    expect(signingSource).toContain("algorithm: 'sha256'")
  })

  test('never accepts wallet secrets through signer operations', () => {
    const signerSource = `${zcashSignerSource}\n${multichainSignerSource}`
    expect(signerSource).not.toMatch(/seedPhrase|mnemonic|privateKey|password/)
    expect(credentialSource).toContain('readonly password: string')
  })

  test('keeps ports independent from Chrome, workers, stores, and generated WASM', () => {
    expect(portSource).not.toMatch(/chrome\.|WORKER_RPC|wasm-pkg/i)
    expect(portSource).not.toMatch(/from ['"](?:react|zustand|@\/store)/)
  })

  test('requires prepared summaries, expiry, cancellation, and external signer transport', () => {
    expect(signingSource).toContain('readonly summary: SigningSummary')
    expect(signingSource).toContain('readonly expiresAt: number')
    expect(signingSource).toContain("readonly kind: 'external'")
    expect(zcashSignerSource).toContain('readonly cancel:')
    expect(multichainSignerSource).toContain('readonly cancel:')
  })
})
