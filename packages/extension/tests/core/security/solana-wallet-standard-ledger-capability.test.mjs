import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'vite'

async function loadWalletStandard() {
  const result = await build({
    configFile: false,
    publicDir: false,
    build: {
      lib: {
        entry: new URL('../../../src/content-script/solana-wallet-standard.ts', import.meta.url)
          .pathname,
        formats: ['es']
      },
      write: false,
      minify: false
    },
    define: { 'import.meta.env.NOIR_PROVIDER_ICON_DATA_URL': '"data:image/svg+xml,"' },
    logLevel: 'silent'
  })
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(output => output.output)
  const entry = chunks.find(output => output.type === 'chunk' && output.isEntry)
  assert.ok(entry && entry.type === 'chunk')
  return import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`)
}

it('keeps Ledger message signing unavailable unless the connected account gains that capability', async () => {
  const previousWindow = globalThis.window
  const page = new EventTarget()
  globalThis.window = page
  try {
    const { registerSolanaWalletStandard, encodeBase58 } = await loadWalletStandard()
    const ledgerAddress = encodeBase58(new Uint8Array(32).fill(7))
    const softwareAddress = encodeBase58(new Uint8Array(32).fill(8))
    const signature = encodeBase58(new Uint8Array(64).fill(9))
    const requests = []
    let wallet
    let accountsChanged
    let capabilitiesChanged
    const changes = []
    page.addEventListener('wallet-standard:register-wallet', event => {
      event.detail({
        register: registered => {
          wallet = registered
        }
      })
    })
    registerSolanaWalletStandard({
      chain: 'solana:mainnet',
      request: async (method, params) => {
        requests.push({ method, params })
        if (method === 'getAccounts') return [ledgerAddress, softwareAddress]
        if (method === 'signMessage') return { signature }
        throw new Error(`Unexpected request: ${method}`)
      },
      onAccountsChanged: listener => {
        accountsChanged = listener
      },
      onAccountCapabilitiesChanged: listener => {
        capabilitiesChanged = listener
      }
    })
    await new Promise(resolve => setImmediate(resolve))
    const signMessage = wallet.features['solana:signMessage'].signMessage
    wallet.features['standard:events'].on('change', change => changes.push(change))
    const input = address => ({
      account: wallet.accounts.find(account => account.address === address),
      message: new Uint8Array([1, 2, 3])
    })
    const signRequests = () => requests.filter(request => request.method === 'signMessage').length

    assert.equal(wallet.accounts.length, 2)
    assert.equal(
      wallet.accounts.every(account => !account.features.includes('solana:signMessage')),
      true
    )
    await assert.rejects(() => signMessage(input(ledgerAddress)), /not supported/)
    assert.equal(signRequests(), 0)
    capabilitiesChanged([
      { address: ledgerAddress, signMessage: false },
      { address: softwareAddress, signMessage: true }
    ])
    assert.equal(changes.length, 1)
    assert.equal(wallet.accounts[0].features.includes('solana:signMessage'), false)
    assert.equal(wallet.accounts[1].features.includes('solana:signMessage'), true)
    assert.equal(Object.isFrozen(wallet.accounts[0].features), true)
    assert.throws(() => wallet.accounts[0].features.push('solana:signMessage'), TypeError)
    await assert.rejects(
      () =>
        signMessage({
          account: { address: ledgerAddress, features: ['solana:signMessage'] },
          message: new Uint8Array([1, 2, 3])
        }),
      /not supported/
    )
    await assert.rejects(
      () => signMessage(input(softwareAddress), input(ledgerAddress)),
      /not supported/
    )
    assert.equal(signRequests(), 0)

    const signed = await signMessage(input(softwareAddress))
    assert.deepEqual(signed[0].signedMessage, new Uint8Array([1, 2, 3]))
    assert.deepEqual(signed[0].signature, new Uint8Array(64).fill(9))
    assert.equal(signRequests(), 1)
    capabilitiesChanged([])
    assert.equal(
      wallet.accounts.some(account => account.features.includes('solana:signMessage')),
      false
    )
    await assert.rejects(() => signMessage(input(softwareAddress)), /not supported/)
    assert.equal(signRequests(), 1)
    accountsChanged([ledgerAddress])
    assert.equal(wallet.accounts.length, 1)
    assert.equal(wallet.accounts[0].features.includes('solana:signMessage'), false)

    registerSolanaWalletStandard({
      chain: 'solana:mainnet',
      request: async method => (method === 'getAccounts' ? [ledgerAddress] : { signature }),
      onAccountsChanged: () => {}
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(wallet.accounts[0].features.includes('solana:signMessage'), false)
    await assert.rejects(
      () => wallet.features['solana:signMessage'].signMessage(input(ledgerAddress)),
      /not supported/
    )
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
