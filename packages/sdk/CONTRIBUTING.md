# Contributing

The SDK and its example app live in `packages/sdk/` of the Noir Wallet repository.
Submit SDK changes through a pull request to this repository.

## Development

```bash
pnpm install
pnpm --filter @noir-wallet/sdk type-check
pnpm --filter @noir-wallet/sdk test
pnpm --filter @noir-wallet/sdk build
pnpm --filter @noir-wallet/example type-check
pnpm --filter @noir-wallet/example build
pnpm --filter @noir-wallet/sdk pack:dry
node scripts/sdk-package-check.mjs
```

Run these commands from the Noir Wallet repository root. The root [contribution guide](../../CONTRIBUTING.md)
describes pull request targets and review expectations.
