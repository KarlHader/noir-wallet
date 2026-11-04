# Noir Wallet

A self-custodial Zcash Chrome wallet with shielded transactions, cross-chain swaps, lending, and a dApp SDK.

## Project Structure

```
noir-wallet/
├── packages/
│   ├── extension/            # Chrome Extension wallet
│   │   └── tests/            # Wallet core tests
│   ├── rpc-registry/         # RPC registry and monitoring service
│   │   └── tests/            # Service core tests
│   ├── sdk/                  # dApp SDK
│   │   └── example/          # SDK integration example app
│   ├── web/                  # Landing page and installation guide
│   │   └── tests/            # Website signup contract tests
│   ├── web-vote/             # Website FROST signup Worker
│   │   └── tests/            # Signup API and persistence tests
│   ├── docs/                 # User and developer documentation site
│   └── zcash-wallet-wasm/    # Separate Rust/WASM repository, if available locally
├── docs/                     # Module references, release and integration guides
├── output/                   # Ignored local verification artifacts
├── package.json
└── pnpm-workspace.yaml
```

## Documentation

- [Project rules and document maintenance](./AGENTS.md), including [architecture responsibilities](./AGENTS.md#architecture)
- [Wallet user guide](./packages/docs/content/docs/wallet-guide/index.mdx)
- [SDK integration and package references](#sdk-usage)
- Module references: [analytics events](./docs/analytics-events.md) and [error messages](./docs/error-messages.md)
- [Release operations](#release) and [developer release history](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md), [security reporting](./SECURITY.md), and [license](./LICENSE)

The documentation site is maintained in `packages/docs/content/docs/`. The top-level `docs/` directory holds module references, release procedures, and integration checks.

## Features

- **Zcash Privacy**: Shielded addresses and funding when available; transparent activity remains public on-chain
- **Worker-Based WASM**: Offscreen worker architecture for non-blocking cryptographic operations
- **Cross-Chain Flows**: Supported asset swaps and lending on mainnet through external services
- **dApp Integration**: TypeScript SDK for seamless wallet connection and transaction signing
- **Optimistic UI**: Instant interface response with background computation for better UX

## WASM Component Audit

BlockSec's [June 9, 2026 audit report](https://github.com/blocksecteam/audit-reports/blob/main/rust/blocksec_noirwallet_zcash_wallet_wasm_signed_20260609.pdf) covers the separate `zcash-wallet-wasm` component: the Rust/WASM bindings under `src` and specified project modifications to `librustzcash`.

| Report revision            | WASM source commit                         |
| -------------------------- | ------------------------------------------ |
| Version 1 — initial review | `4511c41c1cb0f963e739f493df7843d821f7af6d` |
| Version 2 — fix review     | `6493a7cab79c44afdb2014eef7036692cb955d87` |
| Version 3 — fix review     | `e24eae7fc72e367be0bd99adafc05b5ce006645c` |

The later review rounds covered fixes for reported issues. New Version 2 functionality and Version 3 library upgrades and SDK integration were excluded. The report does not cover this browser extension or the full upstream dependency codebase; see the report's scope and host-application assumptions.

The extension's [bundled WASM package](./packages/extension/src/lib/wasm-pkg/) is identified by [wasm-package.lock.json](./wasm-package.lock.json), which records its source commit, ref, and artifact/file hashes. The currently recorded source commit differs from the report revisions above, so the report must not be treated as an audit of the current package or extension. The hashes support package integrity checks; they do not prove source-to-binary correspondence.

## Quick Start

Run commands from the repository root. Use the Node.js version in [`.node-version`](./.node-version) and the pnpm version declared in `package.json` to match CI. Node.js 22 or newer is supported:

```bash
git clone https://github.com/NoirWallet/noir-wallet.git
cd noir-wallet
```

The SDK and its example are included in the clone. The source under `packages/zcash-wallet-wasm/` is a separate checkout, not a Git submodule, and is excluded from this pnpm workspace. Ordinary extension builds use the vendored package at `packages/extension/src/lib/wasm-pkg/` and do not require that source checkout. Updating the vendored package requires access to the WASM source or a published artifact and must follow the [WASM package workflow](./docs/release-workflow.md#wasm-package-updates). Do not replace the vendored package with an unrelated build.

No `.env` file or analytics credentials are required for local development, default builds, beta builds, or testnet builds. Production mainnet builds require the process environment variables listed in [`.env.example`](./.env.example); see the [release configuration](./docs/release-workflow.md#workflow-stages). Those values are embedded in the extension and are visible to its users, so they must not grant privileged server access.

### Install Dependencies

```bash
pnpm install
```

### Development

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

- After starting `pnpm dev:extension`, load the `packages/extension/dist/` directory in `chrome://extensions` with Developer Mode enabled
- Default local entrypoints match production routes:
  - `http://localhost:5001`
  - `http://localhost:5001/beta`
- The SDK example defaults to `http://localhost:5002/example/` so it can be tested with the extension injection flow intact
- The extension dev server selects a free port; the website and SDK example use the next available port when their default is occupied. Use the URL printed in that terminal and load each worktree's own extension build when debugging multiple versions.

### Build

```bash
# Build all packages
pnpm build

# Build specific packages
pnpm build:extension
pnpm build:extension:testnet
pnpm --filter @noir-wallet/sdk build
pnpm --filter @noir-wallet/example build
pnpm build:web
pnpm build:docs
```

Website builds use the public `NoirWallet/noir-wallet` repository for the GitHub links and `/github`, `/beta`, and `/beta/versions` redirects. Set `WALLET_REPOSITORY=owner/repo` when building `packages/web` to point these links and routes at another GitHub repository and its Releases page. The value is validated during the build; see [`.env.example`](./.env.example).

### Type Checking

```bash
pnpm type-check
```

This command builds the SDK before checking all workspace packages, so consumers can resolve its exported JavaScript and declaration files on a fresh checkout. The pre-commit hook uses the same command.

### Core Tests

The root command aggregates the extension, RPC registry, website signup client, and signup Worker core suites:

```bash
pnpm test

# Run one package's core suite
pnpm --filter @noir-wallet/extension test
pnpm --filter @noir-wallet/rpc-registry test
pnpm --filter @noir-wallet/web test
pnpm --filter @noir-wallet/web-vote test

# Run one core regression test
pnpm --filter @noir-wallet/extension exec node --import ../../scripts/register-test-loader.mjs --test tests/tx-monitor-policy.test.mjs
```

See [contributor verification](./CONTRIBUTING.md#development-and-verification) for test scope, local real-MV3 browser verification, and artifact locations.

### Load Extension in Chrome

1. Build the extension: `pnpm build:extension`
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select `packages/extension/dist` directory

## Example Application

The application in `packages/sdk/example/` uses the entrypoint and commands in [Development](#development) and [Build](#build). It demonstrates:

- Wallet connection and detection
- Account and balance queries
- Transaction sending
- Message signing
- Event listeners (accountsChanged, chainChanged)

**Requirements**: Noir Wallet extension must be installed and loaded in Chrome.
The optional `fundingSource` parameter for SDK Max estimates and sends is
supported by Noir Wallet extension **1.0.27 or later**.

## SDK Usage

- [SDK integration guide](./packages/docs/content/docs/noir-sdk-integration.mdx): installation, provider detection, account access, and usage examples.
- [API reference](./packages/docs/content/docs/developers/provider-api.mdx): methods, request and response types, and limitations.
- [SDK package README](./packages/sdk/README.md): package installation and quick start.

## RPC Registry Service

`packages/rpc-registry/` is a Cloudflare Worker serving `GET /v1/rpc-endpoints`; add `?scope=multichain` for the full registry. `GET /v1/zero-indexer-endpoints` serves independent Mainnet and Testnet broadcast-node lists maintained in [zero-indexer-registry.ts](./packages/rpc-registry/src/zero-indexer-registry.ts). The extension uses cached or bundled ZeroIndexer nodes when that API is unavailable. Its scheduled monitor checks ordinary RPC availability and sends Slack notifications; ZeroIndexer nodes are excluded from that monitor. The domain, schedule, and Durable Object migration are defined in [wrangler.json](./packages/rpc-registry/wrangler.json).

From the repository root, verify the service without deploying or sending notifications:

```bash
pnpm --filter @noir-wallet/rpc-registry verify # Type checking, core tests, and build dry run
pnpm --filter @noir-wallet/rpc-registry dev   # Local API at http://localhost:8787
```

Set `SLACK_WEBHOOK_URL` as a Worker secret for notifications. Local scheduled runs also probe external RPCs and can send notifications when this secret is configured. Failed deliveries remain pending and are retried on a later scheduled run.

## FROST Beta Signup

The website's independent `/frost` page introduces the planned 2-of-3 FROST vault: Mobile and Chrome Extension hold the everyday signing shares, with a third share kept offline for recovery together with the remaining device if one is lost. The page collects email addresses for Beta interest. Its API is a separate Cloudflare Worker in `packages/web-vote/`.

Run both servers from the repository root:

```bash
pnpm --filter @noir-wallet/web-vote dev
pnpm dev:web
```

Open `http://localhost:5001/frost`. Vite proxies `/api/frost-signups` to the local Worker on port 8788. Local signups persist under ignored `output/web-vote/state/`, separately from production.

`POST /api/frost-signups` accepts JSON `{ "email": "you@example.com" }` from a configured website Origin and returns `{ "ok": true }`. The API validates the address, trims surrounding whitespace, and lowercases its domain. A SQLite-backed Durable Object stores the email address and first signup time. Duplicate submissions return the same receipt without changing that time or revealing whether the address was already registered. This collects interest; it does not verify email ownership.

New production signups atomically enqueue a welcome email sent through Gmail SMTP from `NoirWallet <support@zknoir.com>`. Existing signups are not backfilled, and repeated submissions do not enqueue another email. Durable Object alarms process the persistent queue at most once per minute across recipients. Explicit temporary SMTP rejections retry up to three total attempts; ambiguous delivery outcomes remain stopped for investigation. Mail failures do not remove saved signups. See [signup email configuration and recovery](./docs/release-workflow.md#signup-email-configuration).

Production requires valid mail secrets; missing or invalid configuration returns a generic 503 for submissions and readiness checks. `GET /api/frost-signups` otherwise returns `{ "status": "ok" }` after checking storage readiness without contacting Gmail. It exposes no addresses or signup counts. Local development sets `MAIL_MODE=disabled`, storing signups without sending email or requiring mail secrets.

The existing Durable Object binding and migration are retained, but signups use a separate named instance; historical vote data is left untouched. The client no longer creates a browser voting identity.

Verify before deployment:

```bash
pnpm --filter @noir-wallet/web-vote verify
pnpm --filter @noir-wallet/web type-check
pnpm build:web
pnpm test
```

The website keeps its existing Cloudflare Pages Git deployment. The signup Worker has an independent [GitHub Actions workflow](./.github/workflows/web-vote.yml). See [website and signup Worker deployment](./docs/release-workflow.md#website-and-signup-worker) for credentials setup, triggers, and recovery. The Worker routes, allowed production origins, and Durable Object migration are maintained in [wrangler.json](./packages/web-vote/wrangler.json). Routes cover only the signup API paths; the existing Pages site serves `/frost` and all other pages. Local verification does not confirm production routing or deployment.

## Release

See the [CI/CD and release runbook](./docs/release-workflow.md) for PR test artifacts,
Beta builds from selected branches or commits, production candidate acceptance and promotion,
Chrome Web Store submission, and failure recovery.

## License

Noir Wallet source code is available under [Business Source License 1.1](./LICENSE), with a Change Date of January 1, 2029 and a Change License of Apache License 2.0. The license permits non-production use, including development, testing, research, and security review. Its Additional Use Grant permits end users to run official, unmodified releases for any purpose and other production use for non-commercial purposes. Commercial operation of a wallet fork or incorporation into a commercial wallet product requires a separate license before the Change Date. Extension ZIPs include the license.

The SDK under `packages/sdk/`, including its example, remains separately licensed under [MIT](./packages/sdk/LICENSE). Bundled Jost and DM Mono fonts retain their [Jost](./packages/extension/public/fonts/jost-OFL.txt) and [DM Mono](./packages/extension/public/fonts/dm-mono-OFL.txt) SIL Open Font License notices, which are included with the fonts in extension ZIPs. Separately distributed WASM packages and other third-party components retain their own licenses; the root license does not replace those terms.
