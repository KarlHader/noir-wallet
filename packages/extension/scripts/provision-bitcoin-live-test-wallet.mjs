import { randomBytes } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import init, { WalletEngine } from '../src/infrastructure/generated/wasm/multichain/wallet_wasm.js'

const outputPath = process.argv[2]
if (!outputPath || !path.isAbsolute(outputPath)) {
  throw new Error('An absolute output path is required')
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const wasmPath = path.resolve(
  scriptDirectory,
  '../src/infrastructure/generated/wasm/multichain/wallet_wasm_bg.wasm'
)
const password = randomBytes(24).toString('base64url')
const wasmBytes = await readFile(wasmPath)
await init({ module_or_path: wasmBytes })

const engine = new WalletEngine()
let sessionId = null
try {
  const created = engine.createWallet(24, password, '')
  const session = engine.unlock(created.vault, password)
  sessionId = session.sessionId
  const account = engine.deriveBitcoinAccount(
    sessionId,
    'bip122:000000000933ea01ad0ee984209779ba',
    'p2wpkh',
    0,
    false,
    0
  )
  const fixture = {
    schemaVersion: 1,
    network: 'bitcoin-testnet3',
    mnemonic: created.mnemonic,
    password,
    address: account.address
  }
  await writeFile(outputPath, JSON.stringify(fixture), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  })
  await chmod(outputPath, 0o600)
  process.stdout.write(`${account.address}\n`)
} finally {
  if (sessionId !== null) engine.lock(sessionId)
  engine.free()
}
