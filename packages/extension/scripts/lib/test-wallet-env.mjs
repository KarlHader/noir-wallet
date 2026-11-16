import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TEST_WALLET_ENV_FILE = fileURLToPath(
  new URL('../../.env.test-wallets.local', import.meta.url)
)

export const TEST_WALLET_ENV_KEYS = Object.freeze([
  'NOIR_BITCOIN_TESTNET_WALLET_FILE',
  'NOIR_EVM_TESTNET_WALLET_FILE',
  'NOIR_SOLANA_NEAR_TESTNET_WALLET_FILE',
  'NOIR_TESTNET_ACCOUNT',
  'NOIR_TESTNET_BIRTHDAY_HEIGHT',
  'NOIR_TESTNET_MNEMONIC_FILE',
  'NOIR_TESTNET_SEED_AMOUNT',
  'NOIR_TESTNET_SEND_AMOUNT',
  'TESTNET_1_BLOCK',
  'TESTNET_1_MNEMONIC_FILE',
  'TESTNET_2_BLOCK',
  'TESTNET_2_MNEMONIC_FILE'
])

const ALLOWED_KEYS = new Set(TEST_WALLET_ENV_KEYS)
const MAX_ENV_FILE_SIZE = 16_384

function decodeValue(rawValue, lineNumber) {
  const value = rawValue.trim()
  if (!value) return ''
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value)
      if (typeof decoded !== 'string') throw new Error('not a string')
      return decoded
    } catch {
      throw new Error(`Invalid quoted value on line ${lineNumber}`)
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`Invalid quoted value on line ${lineNumber}`)
    }
    return value.slice(1, -1)
  }
  if (/\s#/.test(value)) {
    throw new Error(`Inline comments are not supported on line ${lineNumber}`)
  }
  return value
}

export function parseTestWalletEnvironment(source) {
  const result = new Map()
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) {
      throw new Error(`Shell expressions are not supported on line ${lineNumber}`)
    }
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(`Invalid assignment on line ${lineNumber}`)
    const key = line.slice(0, separator).trim()
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unsupported test-wallet variable ${key} on line ${lineNumber}`)
    }
    if (result.has(key)) throw new Error(`Duplicate test-wallet variable ${key}`)
    result.set(key, decodeValue(line.slice(separator + 1), lineNumber))
  }
  return result
}

function assertPrivateRegularFile(filePath, maximumSize, label) {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`)
  let metadata
  try {
    metadata = lstatSync(filePath)
  } catch (error) {
    const sanitized = new Error(`${label} does not exist or cannot be read`)
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      sanitized.code = error.code
    }
    throw sanitized
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumSize) {
    throw new Error(`${label} must be a bounded regular file, not a symlink`)
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must use mode 0600`)
  }
  return metadata
}

export function loadLocalTestWalletEnvironment({
  environment = process.env,
  filePath = environment.NOIR_TEST_WALLET_ENV_FILE || DEFAULT_TEST_WALLET_ENV_FILE,
  allowMissing = true
} = {}) {
  if (!path.isAbsolute(filePath)) {
    throw new Error('NOIR_TEST_WALLET_ENV_FILE must be an absolute path')
  }
  try {
    assertPrivateRegularFile(filePath, MAX_ENV_FILE_SIZE, 'Test-wallet environment file')
  } catch (error) {
    if (allowMissing && error && typeof error === 'object' && error.code === 'ENOENT') {
      return Object.freeze({ loaded: false, loadedKeys: Object.freeze([]) })
    }
    throw error
  }

  const parsed = parseTestWalletEnvironment(readFileSync(filePath, 'utf8'))
  const loadedKeys = []
  for (const [key, value] of parsed) {
    if (!value || environment[key] !== undefined) continue
    environment[key] = value
    loadedKeys.push(key)
  }
  return Object.freeze({ loaded: true, loadedKeys: Object.freeze(loadedKeys) })
}

export function assertPrivateTestWalletFile(filePath, maximumSize, label) {
  return assertPrivateRegularFile(filePath, maximumSize, label)
}
