# @noir-wallet/shield-sdk

Client for NEAR Confidential Shield requests. The package sends typed requests to an installed Noir Wallet. It does not hold keys, quote, or approve transactions.

This package is not published. Install it from the workspace while developing:

```bash
pnpm add @noir-wallet/shield-sdk@workspace:* --filter <your-app>
```

The local tester lives in `example/` and follows the same Vite shape as `@noir-wallet/example`.

```bash
pnpm --filter @noir-wallet/shield-sdk example:dev
```

Open `http://localhost:5003`. The page loads this package from source, so a separate package build is not required. Connect uses the installed Noir Wallet extension. A timeout or cancelled wait leaves the wallet operation unchanged.

## Call entry

`connect()` starts a Shield session. It does not grant permission to receive or transfer. Each of those calls is approved in the wallet.

```ts
import { NoirShieldSDK } from '@noir-wallet/shield-sdk'

const shieldSdk = new NoirShieldSDK()
await shieldSdk.connect()

const receive = await shieldSdk.shield.receive({
  layer: 'near-confidential',
  source: { chainId: 56, assetId: 'eip155:56/slip44:714' },
  amount: '0.10'
})
const received = await receive.wait()

const transfer = await shieldSdk.shield.transfer({
  layer: 'near-confidential',
  token: { chainId: 1, assetId: 'eip155:1/slip44:60' },
  amount: '0.05',
  destination: {
    kind: 'public',
    chainId: 8453,
    address: '0x1111111111111111111111111111111111111111'
  }
})
await transfer.wait({ timeoutMs: 120_000 })

const quote = await shieldSdk.getQuote({
  layer: 'near-confidential',
  action: 'receive',
  source: { chainId: 56, assetId: 'eip155:56/slip44:714' },
  amount: '0.10'
})

const restored = await shieldSdk.getTransactionStatus({
  layer: 'near-confidential',
  operationId: receive.id
})
```

`wait({ signal, timeoutMs })` only ends the client wait. A timeout or abort does not mark the operation failed and does not submit it again. Amounts are decimal strings. The token is a chain plus an asset id. `56`, `eip155:56`, and canonical hex all normalize to `eip155:56`. A transfer destination names a chain and a recipient. The wallet settles that same token on the destination chain.
