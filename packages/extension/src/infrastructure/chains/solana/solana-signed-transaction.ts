import { parseCanonicalBase64 } from './solana-rpc-codecs'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export interface SignedSolanaTransaction {
  readonly transactionBase64: string
  readonly transactionHash: string
  readonly messageBase64: string
}

function encodeBase58(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8
      digits[index] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let leadingZeros = 0
  while (leadingZeros < bytes.byteLength && bytes[leadingZeros] === 0) leadingZeros += 1
  const significant =
    digits.length === 1 && digits[0] === 0
      ? ''
      : [...digits]
          .reverse()
          .map(digit => BASE58_ALPHABET[digit])
          .join('')
  return '1'.repeat(leadingZeros) + significant
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function parseSignedSolanaTransaction(
  transactionBase64Value: unknown,
  transactionHashValue: unknown
): SignedSolanaTransaction {
  const transaction = parseCanonicalBase64(
    transactionBase64Value,
    1_232,
    'Solana signed transaction'
  )
  if (transaction.byteLength < 66 || transaction[0] !== 1) {
    throw new Error('Signed Solana transaction must contain exactly one signature')
  }
  const signature = transaction.subarray(1, 65)
  if (signature.every(byte => byte === 0)) throw new Error('Signed Solana signature is empty')
  const transactionHash = encodeBase58(signature)
  if (transactionHashValue !== transactionHash) {
    throw new Error('Signed Solana transaction hash does not match its signature')
  }
  return Object.freeze({
    transactionBase64: encodeBase64(transaction),
    transactionHash,
    messageBase64: encodeBase64(transaction.subarray(65))
  })
}
