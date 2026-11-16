import { getSolanaNetworkConfigs } from '@/config/networks'
import { parseChainId } from '@/core/chains/registry'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const SOLANA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const SOLANA_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')
const MAXIMUM_U64 = 18_446_744_073_709_551_615n
const MAXIMUM_TRANSACTION_BYTES = 1_232

export interface SolanaNativeTransferInput {
  readonly chainId: string
  readonly sender: string
  readonly recipient: string
  readonly recentBlockhash: string
  readonly lamports: string
}

export interface BuiltSolanaNativeTransfer {
  readonly transactionBase64: string
  readonly messageBase64: string
  readonly sender: string
  readonly recipient: string
  readonly recentBlockhash: string
  readonly lamports: string
}

export interface SolanaTokenTransferInput {
  readonly chainId: string
  readonly sender: string
  readonly recipient: string
  readonly sourceTokenAccount: string
  readonly mint: string
  readonly tokenProgram: typeof SOLANA_TOKEN_PROGRAM | typeof SOLANA_TOKEN_2022_PROGRAM
  readonly decimals: number
  readonly amountRaw: string
  readonly recentBlockhash: string
}

export interface BuiltSolanaTokenTransfer {
  readonly transactionBase64: string
  readonly messageBase64: string
  readonly sender: string
  readonly recipient: string
  readonly sourceTokenAccount: string
  readonly destinationTokenAccount: string
  readonly mint: string
  readonly tokenProgram: typeof SOLANA_TOKEN_PROGRAM | typeof SOLANA_TOKEN_2022_PROGRAM
  readonly decimals: number
  readonly amountRaw: string
  readonly recentBlockhash: string
}

function requireSolanaChainId(value: string): void {
  const parsed = parseChainId(value)
  if (
    parsed.namespace !== 'solana' ||
    !getSolanaNetworkConfigs().some(network => network.chainId === parsed.id)
  ) {
    throw new Error('Unsupported Solana chain ID')
  }
}

function decodeBase58PublicKey(value: string, label: string): Uint8Array {
  if (value.length === 0 || value.length > 44) throw new Error(`Invalid ${label} public key`)
  const littleEndianBytes = [0]
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character)
    if (digit < 0) throw new Error(`Invalid ${label} public key`)
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
    littleEndianBytes.length === 1 && littleEndianBytes[0] === 0 ? [] : littleEndianBytes
  const decoded = new Uint8Array(leadingZeroBytes + significantBytes.length)
  for (let index = 0; index < significantBytes.length; index += 1) {
    decoded[decoded.length - 1 - index] = significantBytes[index]
  }
  if (decoded.byteLength !== 32) throw new Error(`Invalid ${label} public key`)
  return decoded
}

function encodeBase58(value: Uint8Array): string {
  const digits = [0]
  for (const byte of value) {
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
  let leadingZeroBytes = 0
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === 0) {
    leadingZeroBytes += 1
  }
  const significantDigits = digits.length === 1 && digits[0] === 0 ? [] : digits
  return (
    '1'.repeat(leadingZeroBytes) +
    significantDigits
      .reverse()
      .map(digit => BASE58_ALPHABET[digit])
      .join('')
  )
}

function isEd25519Point(value: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(value)
    return true
  } catch {
    return false
  }
}

function deriveAssociatedTokenAddress(
  owner: Uint8Array,
  mint: Uint8Array,
  tokenProgram: Uint8Array,
  associatedTokenProgram: Uint8Array
): Uint8Array {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const candidate = sha256(
      concatenate([
        owner,
        tokenProgram,
        mint,
        Uint8Array.of(bump),
        associatedTokenProgram,
        PDA_MARKER
      ])
    )
    if (!isEd25519Point(candidate)) return candidate
  }
  throw new Error('Unable to derive the Solana associated token account')
}

export function deriveSolanaAssociatedTokenAccount(
  owner: string,
  mint: string,
  tokenProgram: typeof SOLANA_TOKEN_PROGRAM | typeof SOLANA_TOKEN_2022_PROGRAM
): string {
  if (tokenProgram !== SOLANA_TOKEN_PROGRAM && tokenProgram !== SOLANA_TOKEN_2022_PROGRAM) {
    throw new Error('Invalid Solana token program')
  }
  return encodeBase58(
    deriveAssociatedTokenAddress(
      decodeBase58PublicKey(owner, 'owner'),
      decodeBase58PublicKey(mint, 'token mint'),
      decodeBase58PublicKey(tokenProgram, 'token program'),
      decodeBase58PublicKey(ASSOCIATED_TOKEN_PROGRAM, 'associated token program')
    )
  )
}

function parseLamports(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('Lamports must be a decimal u64')
  const parsed = BigInt(value)
  if (parsed > MAXIMUM_U64) throw new Error('Lamports exceed u64')
  if (parsed === 0n) throw new Error('Lamports must be positive')
  return parsed
}

function encodeShortVector(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid short vector length')
  const encoded: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    encoded.push(byte)
  } while (remaining > 0)
  return Uint8Array.from(encoded)
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function buildSolanaNativeTransfer(
  input: SolanaNativeTransferInput
): BuiltSolanaNativeTransfer {
  requireSolanaChainId(input.chainId)
  if (input.sender === input.recipient) throw new Error('Sender and recipient must be different')
  const sender = decodeBase58PublicKey(input.sender, 'sender')
  const recipient = decodeBase58PublicKey(input.recipient, 'recipient')
  const systemProgram = decodeBase58PublicKey(SYSTEM_PROGRAM, 'SystemProgram')
  const blockhash = decodeBase58PublicKey(input.recentBlockhash, 'recent blockhash')
  const lamports = parseLamports(input.lamports)

  const instructionData = new Uint8Array(12)
  const dataView = new DataView(instructionData.buffer)
  dataView.setUint32(0, 2, true)
  dataView.setBigUint64(4, lamports, true)

  const message = concatenate([
    Uint8Array.from([1, 0, 1]),
    encodeShortVector(3),
    sender,
    recipient,
    systemProgram,
    blockhash,
    encodeShortVector(1),
    Uint8Array.from([2]),
    encodeShortVector(2),
    Uint8Array.from([0, 1]),
    encodeShortVector(instructionData.byteLength),
    instructionData
  ])
  const transaction = concatenate([encodeShortVector(1), new Uint8Array(64), message])
  if (transaction.byteLength > MAXIMUM_TRANSACTION_BYTES) {
    throw new Error('Solana transaction exceeds the wire size limit')
  }

  return Object.freeze({
    transactionBase64: encodeBase64(transaction),
    messageBase64: encodeBase64(message),
    sender: input.sender,
    recipient: input.recipient,
    recentBlockhash: input.recentBlockhash,
    lamports: lamports.toString()
  })
}

export function buildSolanaTokenTransfer(
  input: SolanaTokenTransferInput
): BuiltSolanaTokenTransfer {
  requireSolanaChainId(input.chainId)
  if (input.sender === input.recipient) throw new Error('Sender and recipient must be different')
  if (!Number.isSafeInteger(input.decimals) || input.decimals < 0 || input.decimals > 255) {
    throw new Error('Invalid Solana token decimals')
  }
  const sender = decodeBase58PublicKey(input.sender, 'sender')
  const recipient = decodeBase58PublicKey(input.recipient, 'recipient')
  const sourceTokenAccount = decodeBase58PublicKey(input.sourceTokenAccount, 'source token account')
  const mint = decodeBase58PublicKey(input.mint, 'token mint')
  const systemProgram = decodeBase58PublicKey(SYSTEM_PROGRAM, 'SystemProgram')
  const tokenProgram = decodeBase58PublicKey(input.tokenProgram, 'token program')
  const associatedTokenProgram = decodeBase58PublicKey(
    ASSOCIATED_TOKEN_PROGRAM,
    'associated token program'
  )
  const blockhash = decodeBase58PublicKey(input.recentBlockhash, 'recent blockhash')
  const amount = parseLamports(input.amountRaw)
  const destinationTokenAccount = deriveAssociatedTokenAddress(
    recipient,
    mint,
    tokenProgram,
    associatedTokenProgram
  )

  const transferData = new Uint8Array(10)
  const transferView = new DataView(transferData.buffer)
  transferView.setUint8(0, 12)
  transferView.setBigUint64(1, amount, true)
  transferView.setUint8(9, input.decimals)

  const staticKeys = [
    sender,
    sourceTokenAccount,
    destinationTokenAccount,
    recipient,
    mint,
    systemProgram,
    tokenProgram,
    associatedTokenProgram
  ]
  const message = concatenate([
    Uint8Array.from([1, 0, 5]),
    encodeShortVector(staticKeys.length),
    ...staticKeys,
    blockhash,
    encodeShortVector(2),
    Uint8Array.from([7]),
    encodeShortVector(6),
    Uint8Array.from([0, 2, 3, 4, 5, 6]),
    encodeShortVector(1),
    Uint8Array.of(1),
    Uint8Array.from([6]),
    encodeShortVector(4),
    Uint8Array.from([1, 4, 2, 0]),
    encodeShortVector(transferData.byteLength),
    transferData
  ])
  const transaction = concatenate([encodeShortVector(1), new Uint8Array(64), message])
  if (transaction.byteLength > MAXIMUM_TRANSACTION_BYTES) {
    throw new Error('Solana transaction exceeds the wire size limit')
  }
  return Object.freeze({
    transactionBase64: encodeBase64(transaction),
    messageBase64: encodeBase64(message),
    sender: input.sender,
    recipient: input.recipient,
    sourceTokenAccount: input.sourceTokenAccount,
    destinationTokenAccount: encodeBase58(destinationTokenAccount),
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    decimals: input.decimals,
    amountRaw: amount.toString(),
    recentBlockhash: input.recentBlockhash
  })
}
