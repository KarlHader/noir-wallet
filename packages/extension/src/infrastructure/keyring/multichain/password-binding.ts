/** Product credential format v1 always applies this binding before the WASM KDF. */
export const MULTICHAIN_PASSWORD_BINDING = Object.freeze({
  id: 'sha256-domain-v1',
  domain: 'NoirWallet/multichain-vault-password/v1\0'
})

const PASSWORD_BINDING_DOMAIN = new TextEncoder().encode(MULTICHAIN_PASSWORD_BINDING.domain)

function toLowercaseHex(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
  return value
}

/**
 * Compresses the exact global-password bytes into a domain-separated 64-byte
 * ASCII input. The WASM still applies its salted Argon2id KDF; this binding
 * only removes its 1024-byte input limit and separates it from the V1 Zcash KDF.
 */
export async function bindMultichainVaultPassword(globalPassword: string): Promise<string> {
  const passwordBytes = new TextEncoder().encode(globalPassword)
  const input = new Uint8Array(PASSWORD_BINDING_DOMAIN.byteLength + passwordBytes.byteLength)
  input.set(PASSWORD_BINDING_DOMAIN)
  input.set(passwordBytes, PASSWORD_BINDING_DOMAIN.byteLength)

  try {
    const digest = await crypto.subtle.digest('SHA-256', input)
    return toLowercaseHex(new Uint8Array(digest))
  } finally {
    passwordBytes.fill(0)
    input.fill(0)
  }
}
