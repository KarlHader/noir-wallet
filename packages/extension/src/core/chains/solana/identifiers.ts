const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decodedBase58Length(value: string): number {
  if (value.length === 0 || value.length > 128) {
    throw new Error('Solana public key must be bounded base58')
  }
  const littleEndianBytes = [0]
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error('Solana public key must be base58')
    let carry = digit
    for (let index = 0; index < littleEndianBytes.length; index += 1) {
      carry += littleEndianBytes[index] * 58
      littleEndianBytes[index] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      littleEndianBytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let leadingZeroBytes = 0
  while (value[leadingZeroBytes] === '1') leadingZeroBytes += 1
  const significantBytes =
    littleEndianBytes.length === 1 && littleEndianBytes[0] === 0 ? 0 : littleEndianBytes.length
  return leadingZeroBytes + significantBytes
}

export function parseSolanaPublicKey(value: unknown): string {
  if (typeof value !== 'string' || decodedBase58Length(value) !== 32) {
    throw new Error('Solana public key must encode 32 bytes')
  }
  return value
}
