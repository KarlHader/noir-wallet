# Contributing

The SDK and example live in `packages/sdk/` of the Noir Wallet workspace. Submit SDK and example changes through the wallet repository's `main` branch.

## Development

```bash
pnpm install --frozen-lockfile
pnpm --filter @noir-wallet/sdk type-check
pnpm --filter @noir-wallet/sdk test
pnpm --filter @noir-wallet/example type-check
pnpm --filter @noir-wallet/example build
pnpm --filter @noir-wallet/sdk pack:dry
```

Run these commands from the wallet repository root. The SDK's `test` script builds the package before running native tests. Root `pnpm test` runs the wallet core suite separately.
