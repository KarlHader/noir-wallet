# Noir Wallet

A privacy-focused Zcash and multichain Chrome wallet with a dApp SDK.

## Project Structure

```
noir-wallet/
├── packages/
│   ├── extension/            # Chrome Extension wallet
│   ├── sdk/                  # dApp SDK workspace package
│   │   └── example/          # SDK integration example app
│   ├── web/                  # Website
│   ├── docs/                 # User and developer documentation site
│   ├── rpc-registry/         # Managed RPC registry
│   └── zcash-wallet-wasm/    # Nested Rust/WASM wallet repository
├── docs/                     # Maintainer reference guides
├── package.json
└── pnpm-workspace.yaml
```

The nested Rust/WASM source checkout is maintained separately. Extension builds use the committed
generated packages and do not require that source checkout.

## Documentation

- [Project rules and documentation ownership](./AGENTS.md), including [architecture](./AGENTS.md#architecture)
- [Wallet user guide](./packages/docs/content/docs/wallet-guide/index.mdx)
- [SDK integration guide](./packages/docs/content/docs/noir-sdk-integration.mdx) and [provider API](./packages/docs/content/docs/developers/provider-api.mdx)
- [Multichain product and architecture index](./docs/mutil-chain/README.md)
- [Analytics events](./docs/analytics-events.md) and [error messages](./docs/error-messages.md)
- [Release operations](./docs/release-workflow.md) and [developer release history](./CHANGELOG.md)

The documentation site's source is `packages/docs/content/docs/`. The top-level `docs/` directory contains English maintenance references.

## Features

- **Privacy-First**: Zero-knowledge proofs for private transactions with shielded addresses
- **Private Broadcast**: Optional ZeroIndexer broadcasting with managed or custom nodes, independent of the synchronization RPC
- **Worker-Based WASM**: Offscreen worker architecture for non-blocking cryptographic operations
- **Multichain Accounts**: Zcash and EVM networks follow the wallet's global Mainnet/Testnet Mode; deferred chains remain feature-gated
- **dApp Integration**: TypeScript SDK for seamless wallet connection and transaction signing
- **Optimistic UI**: Instant interface response with background computation for better UX

## Quick Start

Run commands from the repository root with Node.js 22 and the pnpm version in `package.json`.

### Install Dependencies

```bash
pnpm install
```

The SDK and its example are included in the clone. `packages/zcash-wallet-wasm/` is a separate source checkout, excluded from the workspace. Ordinary extension builds use the complete committed WASM packages and do not require that checkout. Intentional upgrades follow the [WASM package update procedure](docs/release-workflow.md#wasm-package-updates).

### Development

For Swap and Confidential Funding development, copy `.env.example` to
`packages/extension/.env.local` and replace `RHEA_SWAP_ACCESS_TOKEN` with a development
token. Keep this local file out of Git. Release builds use process environment variables
instead; see the [release runbook](docs/release-workflow.md).

Start the development servers with hot reload:

```bash
# Start extension + website + SDK example together (recommended)
pnpm dev

# Extension only
pnpm dev:extension

# Website only
pnpm dev:web

# Example app only (SDK showcase)
pnpm dev:example

# SDK development (watch mode)
pnpm --filter @noir-wallet/sdk dev

# Documentation site
pnpm dev:docs
```

**Note**:

- After starting `pnpm dev:extension`, load `packages/extension/dist-dev/` in `chrome://extensions` with Developer Mode enabled. Generated build and test output is excluded from HMR so verification builds do not reload the development extension.
- EVM History uses the deployed proxy by default. Set `EVM_HISTORY_API_ORIGIN` only to use another proxy; configuration details are in the [release runbook](docs/release-workflow.md#verification-and-build).
- Main local entrypoints match production routes:
  - `http://localhost:5001`
  - `http://localhost:5001/beta`
- The SDK example runs separately at `http://localhost:5002/example/` so it can be tested with the extension injection flow intact

### Build

```bash
# Build all packages
pnpm build

# Build specific packages
pnpm build:extension
pnpm build:extension:testnet
pnpm --filter @noir-wallet/sdk build
pnpm build:web
pnpm build:docs
```

### Type Checking and Tests

Build the SDK before checking the whole workspace so its example can resolve the generated declarations.

```bash
pnpm --filter @noir-wallet/sdk build
pnpm type-check
pnpm lint:eslint packages/extension/src
pnpm knip --workspace @noir-wallet/extension
pnpm test
pnpm --filter @noir-wallet/sdk test
pnpm --filter @noir-wallet/example type-check
pnpm --filter @noir-wallet/example build
pnpm test e2e extension
```

Extension type checking covers both application code and the Vite/manifest configuration; extension builds run the same checks.

`pnpm test` runs the wallet's offline behavior tests; `pnpm test --help` lists the browser, live, and RC subcommands. The SDK's native tests run separately with `pnpm --filter @noir-wallet/sdk test`. See [contributor verification](./CONTRIBUTING.md#verification) for suite organization, commands, and output boundaries.

### Load Extension in Chrome

1. Build the extension: `pnpm build:extension`
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select `packages/extension/dist` directory

### Debugging the Extension

Inspect the popup from its window and the Background service worker from `chrome://extensions`. History-proxy and token-discovery requests originate in Background, so inspect that worker's Network panel. Inspect the offscreen Worker host at `chrome-extension://<extension-id>/src/offscreen/index.html`; Worker logs are forwarded to the Background console.

## Example Application

The SDK workspace package includes an example application:

```bash
# Start example app
pnpm --filter @noir-wallet/example dev

# Build example app
pnpm --filter @noir-wallet/example build
```

The example runs at http://localhost:5002/example/ and demonstrates:

- Wallet connection and detection
- Account and balance queries
- Transaction sending
- Message signing
- Event listeners (accountsChanged, chainChanged)

**Requirements**: Noir Wallet extension must be installed and loaded in Chrome.
The current V2 extension supports the optional `fundingSource` parameter for SDK Max estimates and sends. See the [provider API](./packages/docs/content/docs/developers/provider-api.mdx) for account and hardware limitations.

## SDK Usage

- [SDK integration guide](./packages/docs/content/docs/noir-sdk-integration.mdx): installation, provider detection, account access, and examples.
- [Provider API](./packages/docs/content/docs/developers/provider-api.mdx): methods, request and response types, and limitations.
- [SDK package README](./packages/sdk/README.md): package installation and quick start.

## Release

See the [CI/CD and release runbook](./docs/release-workflow.md) for PR development previews,
manual Beta builds from the trusted `main` workflow, production promotion, and Chrome Web Store submission.

## License

Noir Wallet source code is available under [Business Source License 1.1](./LICENSE), with a Change Date of January 1, 2029 and a Change License of Apache License 2.0. The license permits non-production use, including development, testing, research, and security review. Its Additional Use Grant permits end users to run official, unmodified releases for any purpose and other production use for non-commercial purposes. Commercial operation of a wallet fork or incorporation into a commercial wallet product requires a separate license before the Change Date. Extension ZIPs include the license.

The SDK under `packages/sdk/`, including its example, remains separately licensed under [MIT](./packages/sdk/LICENSE). Extension ZIPs include the [SIL Open Font License notices](./packages/extension/public/fonts/) for Jost and DM Mono, plus original licenses and any supplied notices for Ledger SDKs and their signing libraries under `licenses/`. Separately distributed WASM packages and other third-party components retain their own licenses; the root license does not replace those terms.
