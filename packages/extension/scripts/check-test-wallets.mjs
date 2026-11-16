import { readFileSync } from 'node:fs'
import {
  assertPrivateTestWalletFile,
  loadLocalTestWalletEnvironment
} from './lib/test-wallet-env.mjs'

const loaded = loadLocalTestWalletEnvironment({ allowMissing: true })
const results = []

function checkOptionalFile(key, maximumSize, validate) {
  const filePath = process.env[key]
  if (!filePath) {
    results.push({ key, status: 'not configured' })
    return
  }
  try {
    assertPrivateTestWalletFile(filePath, maximumSize, key)
    validate(readFileSync(filePath, 'utf8'))
    results.push({ key, status: 'ready' })
  } catch (error) {
    results.push({
      key,
      status: 'invalid: path, permissions, content, or schema check failed'
    })
    process.exitCode = 1
  }
}

function validateMnemonic(value) {
  if (value.trim().split(/\s+/).length !== 24) {
    throw new Error('expected one 24-word mnemonic')
  }
}

function validateEvmFixture(source) {
  const value = JSON.parse(source)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'address,mnemonic,network,password,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.network !== 'sepolia' ||
    typeof value.mnemonic !== 'string' ||
    value.mnemonic.trim().split(/\s+/).length !== 24 ||
    typeof value.password !== 'string' ||
    value.password.length < 8 ||
    value.password.length > 64 ||
    typeof value.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.address)
  ) {
    throw new Error('fixture schema does not match the Sepolia wallet contract')
  }
}

function validateBitcoinFixture(source) {
  const value = JSON.parse(source)
  const mnemonicWordCount =
    typeof value?.mnemonic === 'string' ? value.mnemonic.trim().split(/\s+/).length : 0
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'address,mnemonic,network,password,schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.network !== 'bitcoin-testnet3' ||
    ![12, 24].includes(mnemonicWordCount) ||
    typeof value.password !== 'string' ||
    value.password.length < 8 ||
    value.password.length > 64 ||
    typeof value.address !== 'string' ||
    !/^tb1q[023456789acdefghjklmnpqrstuvwxyz]{38}$/.test(value.address)
  ) {
    throw new Error('fixture schema does not match the Bitcoin Testnet3 wallet contract')
  }
}

function validateSolanaNearFixture(source) {
  const value = JSON.parse(source)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'mnemonic,nearAccountId,networks,password,schemaVersion,solanaAddress,solanaRecipientAddress' ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.networks) ||
    value.networks.join(',') !== 'solana-devnet,near-testnet' ||
    typeof value.mnemonic !== 'string' ||
    value.mnemonic.trim().split(/\s+/).length !== 24 ||
    typeof value.password !== 'string' ||
    value.password.length < 8 ||
    value.password.length > 64 ||
    typeof value.solanaAddress !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.solanaAddress) ||
    typeof value.solanaRecipientAddress !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.solanaRecipientAddress) ||
    value.solanaRecipientAddress === value.solanaAddress ||
    typeof value.nearAccountId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.nearAccountId)
  ) {
    throw new Error('fixture schema does not match the Solana/NEAR Testnet wallet contract')
  }
}

checkOptionalFile('NOIR_BITCOIN_TESTNET_WALLET_FILE', 16_384, validateBitcoinFixture)
checkOptionalFile('NOIR_EVM_TESTNET_WALLET_FILE', 16_384, validateEvmFixture)
checkOptionalFile('NOIR_SOLANA_NEAR_TESTNET_WALLET_FILE', 16_384, validateSolanaNearFixture)
checkOptionalFile('NOIR_TESTNET_MNEMONIC_FILE', 2_048, validateMnemonic)
checkOptionalFile('TESTNET_1_MNEMONIC_FILE', 2_048, validateMnemonic)
checkOptionalFile('TESTNET_2_MNEMONIC_FILE', 2_048, validateMnemonic)

console.log(`Local test-wallet environment: ${loaded.loaded ? 'loaded' : 'not found'}`)
for (const result of results) console.log(`${result.key}: ${result.status}`)
console.log('Public deterministic wallets and the V1 Golden Profile: documented/tracked')
