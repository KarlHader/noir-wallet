# Noir Wallet CI/CD and Release Workflow

This runbook covers V2 extension previews and Beta releases. [Extension CI](../.github/workflows/extension-ci.yml) checks V2 pull requests and creates development inspection artifacts. Betas are prepared by the [manual release workflow on `v2`](../.github/workflows/extension-release.yml); production candidates use the separate [workflow on `main`](https://github.com/NoirWallet/noir-wallet/blob/main/.github/workflows/extension-release.yml). The [SDK workflow](../.github/workflows/sdk.yml) validates the SDK and example separately; the [documentation workflow](../.github/workflows/docs.yml) validates documentation without deploying it. Maintainers submit to the Chrome Web Store manually.

On repeated PR pushes, SDK and documentation verification reuse a prior successful run only when the target branch commit and relevant inputs are unchanged. A failed, cancelled, or incomparable run performs the checks again.

## Branches and Versions

- Feature and fix PRs merge into `v2`. PRs that change extension code, tests, WASM, the EVM history Worker, or related build and test inputs automatically run Extension CI and build a development extension. New commits cancel older runs for the same PR; no preview label is needed. Changes limited to Markdown documentation, SDK source, or unrelated tooling do not start Extension CI.
- To prepare a V2 Beta, dispatch `extension-release.yml` from the `v2` workflow branch with mode `beta` and `source_ref=v2`. The workflow builds that dispatched commit; optional `confirm_sha` checks it against the reviewed full SHA. Publishing is controlled by that manual run's `publish_beta` input; see [Routine Previews](#routine-previews).
- V2 pushes and tags do not publish releases. The V2 manual workflow accepts only Betas. Production candidates and publication use the separate trusted workflows on `main`; see the [shared release runbook](https://github.com/NoirWallet/noir-wallet/blob/main/docs/release-workflow.md).
- The production extension has one ZIP with runtime Mainnet/Testnet Mode. `NETWORK_MODE=testnet` is reserved for isolated local test builds, not a second release package.

## Verification and Build

Extension CI installs dependencies, type-checks the EVM History Worker, runs `pnpm test`, and builds and packages the development extension:

```bash
pnpm install --frozen-lockfile
pnpm --filter @noir-wallet/evm-history-worker type-check
pnpm test
pnpm build:extension
```

`pnpm test` runs the wallet's offline suite; see [contributor verification](../CONTRIBUTING.md#verification) for suite organization and commands. Browser projects run through `pnpm test e2e <project>` for local verification; they are not CI or release gates. The extension build verifies both packaged Zcash and Multichain WASM integrity manifests and excludes E2E-only files. The `production-dist` project uses test analytics/RHEA values and produces a local `dist/` that must not be published. For browser, MV3, storage, hardware, or network changes, maintainers should run the relevant local tools according to risk.

Default extension builds write `packages/extension/dist/`; the HMR development server writes `dist-dev/`; isolated browser and Testnet verification builds write `e2e-dist/<profile>/`. Keep these outputs separate. Do not delete an active HMR or browser-test directory, and never submit a test-only build as a release package.

V2 PR builds use `BUILD_CHANNEL=development` with `BETA_INVITE_REQUIRED=1` so their download packages exercise invite activation. Repository PR previews include `RHEA_SWAP_ACCESS_TOKEN` for Swap and fail the build if it is missing. Fork PR previews receive no repository secrets and cannot use Swap. Preview packages are not Beta or production candidates. Manual Beta builds use `BUILD_CHANNEL=beta` and require the release repository's `RHEA_SWAP_ACCESS_TOKEN`; missing values fail the build. Production builds additionally require `GA_API_SECRET` and `CUSTOM_ANALYTICS_PASSWORD`. The repository variable `EVM_HISTORY_API_ORIGIN` may override the default public History proxy origin; it must be a credential-free HTTPS origin without a path or query. The Worker API key stays in a Worker secret and is not passed into the extension build.

The default V2 build enables Zcash and EVM networks. Bitcoin, Solana, and NEAR remain deferred; their chain-selection entries show **Coming soon** and cannot start wallet operations. Use the default feature flags when preparing this Beta. Explicit `ENABLED_CHAIN_FEATURE_FLAGS` values are available for isolated implementation checks and must match their Playwright build profile; they do not change the default release scope.

Beta builds require invite activation before wallet use, including installations upgraded from V1. An unused invite code is checked before wallet setup or unlock, then bound to the first wallet's first available account. Binding prefers its ordinary EVM address; Zcash-only hardware accounts use a transparent receive address. A successful bind completes activation. When the bind response explicitly confirms that the requested wallet address is already bound (`2004`, `wallet address has already been bound`), the extension restores activation for that address and continues. An already-used invite code remains an error, even though the service also uses `2004` for that conflict. Other failures preserve the wallet for retry or another code; `bound=true` on a code check alone never activates an installation.

Activation persists locally for the installation across wallet reset and network changes. Activated wallets do not contact the invite service on each startup; uninstalling or clearing extension storage requires activation again. After checking an unused code and unlocking or setting up the wallet, the server's explicit confirmation of an existing address binding can restore activation, including after a lost successful response. Production builds disable the gate. For local development verification, set `BETA_INVITE_REQUIRED=1` with `BUILD_CHANNEL=development`; `BUILD_CHANNEL=beta` always enables it. Invite generation is an operator API operation: its management key must never be supplied to an extension build.

The public History proxy serves only the existing Ankr History, EVM token discovery, and icon services. The client selects History adapters across chains; other chains request their own data sources directly. See the [Activity architecture](mutil-chain/architecture/transaction-lifecycle.md#6-local-first-activity-merge) for routing and cache fallback, and the [History proxy deployment](#history-proxy-deployment) for Worker configuration and deployment checks.

Private broadcast uses the separate `/v1/zero-indexer-endpoints` endpoint on `https://rpc.zknoir.com`, maintained in `packages/rpc-registry/src/zero-indexer-registry.ts`. Broadcast nodes are excluded from the scheduled synchronization-RPC monitor. Deploying that registry is separate from publishing the extension; check its response when updating managed nodes. If the registry is unavailable, the extension uses its cache or bundled broadcast nodes. Wallet settings and recovery behavior are documented in the [broadcasting guide](../packages/docs/content/docs/wallet-guide/install-and-setup.mdx#transaction-broadcasting).

The V2 Beta contains one ZIP for both runtime network modes, `SHA256SUMS`, and Release notes with its source commit. The manual workflow builds the dispatched `v2` commit and publishes the verified artifact in a separate write-scoped job. CI previews retain numeric base-version labels for the existing [preview reporter on `main`](https://github.com/NoirWallet/noir-wallet/blob/main/.github/workflows/extension-preview-comment.yml); their metadata retains the full Beta version and tested merge commit.

## WASM Package Updates

WASM source and releases are maintained separately. V2 commits complete packages for Zcash at `packages/extension/src/lib/wasm-pkg/` and Multichain at `packages/extension/src/infrastructure/generated/wasm/multichain/`. Each contains a `wasm-integrity.json` with source, ABI, build-tool versions, and artifact hashes. Upstream releases do not automatically update the wallet; ordinary builds and merges use these committed packages without rebuilding or synchronizing WASM. Merges do not amend commits.

For an intentional upgrade, select an upstream release and update the relevant engine's source/build/ABI pins and compatibility checks in this wallet repository. Use a clean separate source checkout at the pinned full commit. The explicit local commands rebuild with the checked tool versions and generate the complete package and integrity manifest:

```bash
pnpm sync-wasm-pkg -- --source <zcash-checkout>
pnpm sync-multichain-wasm-pkg -- --source <multichain-checkout>
```

Run only the command for the engine being updated. These commands build fresh output; they do not import an existing `pkg/`. They reject dirty source checkouts, mismatched commits, and mismatched tool versions. Check the sync script for its pinned tools and optional local tool paths before running it.

Develop and test the extension against the generated package, then submit its complete files, integrity manifest, updated pins, and related extension changes in one PR targeting `v2`. Include the upstream version and checks performed. Never submit only TypeScript bindings without their matching loader, binary, and support files. Run the [verification and build commands](#verification-and-build); the build checks both engine manifests without access to the source repositories.

## Routine Previews

1. Open a PR against `v2` and check **Extension CI**. Download the development package from its PR comment or **Actions → Extension CI** after the run succeeds. Downloads require GitHub sign-in and repository access and expire after three days. Rerun Extension CI for the current PR commit if the package expires. Fork PRs receive no repository secrets.
2. After the Beta workflow is merged into `v2`, run `gh workflow run extension-release.yml --ref v2 -f mode=beta -f source_ref=v2 -F publish_beta=false` to build the dispatched V2 commit without publishing. Set `publish_beta=true` to create its public GitHub prerelease. Optionally pass `confirm_sha` with the reviewed full SHA; a mismatch stops the build. The workflow uses the filename already registered on `main`, so no `main` change is needed.
3. Check Mainnet and Testnet Mode separately in a real isolated MV3 extension. Verify invite activation, unavailable chain selectors, and V1 Golden Profile upgrade compatibility using the same default flags as the Beta. Run browser and external-service checks locally; the workflow does not run them.

Set the extension package version to `2.0.0-beta.N` and add its matching `CHANGELOG.md` section. The workflow publishes `v2.0.0-beta.N` with ZIP `noir-wallet-v2.0.0-beta.N.zip` and notes from that section. Increment `N` for each public Beta.

## Production Release

Production is prepared as a candidate and promoted through the trusted `main` workflows after acceptance. A V2 tag push no longer starts a build or publication. Follow the [shared release runbook](https://github.com/NoirWallet/noir-wallet/blob/main/docs/release-workflow.md) for the current candidate, acceptance, and promotion steps. Confirm the resulting single ZIP and `SHA256SUMS` before submitting that ZIP manually in the Chrome Web Store Developer Dashboard. Do not move a publicly released tag or reuse a published version number.

Retain the candidate metadata, ZIP checksum, and store submission confirmation according to the shared runbook's [store provenance requirements](https://github.com/NoirWallet/noir-wallet/blob/main/docs/release-workflow.md#5-submit-to-chrome-web-store). Repository visibility and branch protection follow its [open-source publication procedure](https://github.com/NoirWallet/noir-wallet/blob/main/docs/release-workflow.md#open-source-publication). A development preview or a matching store version does not prove that the accepted production ZIP was submitted.

`CHANGELOG.md` contains developer release history; `packages/web/public/changelog.json` contains the concise update notes shown in the extension. Add the matching version before release and describe meaningful user-visible changes without internal refactors or test details. The changelog JSON schema defines the current length limits.

## Failure Recovery

- PR check/build failure: fix the source and update the PR; Extension CI builds the new commit automatically. An existing development artifact is not a release candidate.
- Missing Beta build input: configure `RHEA_SWAP_ACCESS_TOKEN` in the trusted release repository and rerun the manual workflow. Do not publish the PR development ZIP as Beta.
- Incorrect selected source: review the current `v2` commit and dispatch again with its full SHA in `confirm_sha`; verify the source commit and checksums before publication.
- Beta publication failure: inspect the original run and any tag or Release it created before retrying. The workflow never reuses an existing tag; a failure after tag creation requires manual review and recovery rather than moving the tag or replacing its assets.
- Production candidate or publication failure: follow the recovery procedure in the shared release runbook. Do not move an existing published tag or replace its package.

## SDK Example V1/V2 Coexistence

The V2 SDK uses `2.x.y-beta.N` versions on the npm `beta` dist-tag, starting at `2.0.0-beta.1`; V1 stable releases remain on `latest`. SDK publication runs through the trusted workflow on `main` and accepts only the current merged `v2` commit for the Beta line. Follow the shared [SDK npm staging procedure](https://github.com/NoirWallet/noir-wallet/blob/main/docs/release-workflow.md#sdk-npm-staging) for candidate construction, npm approval, and verification. SDK Beta publication is independent of extension releases.

The existing public SDK repository continues to host the Example page: `main` serves V1 at the root path and the `/v1/` alias; `v2` serves `/v2/`. Both paths share the same web origin. The example source in this wallet repository is now maintained at `packages/sdk/example/`; its workspace CI builds it but does not deploy it. Before first-connection checks across versions, disconnect the wallet authorization and clear the Example's local state. The wallet extension release Workflow does not deploy or modify the SDK Example.

## History Proxy Deployment

The existing Worker source is `packages/evm-history-worker/`; its production hostname is `https://history-proxy.zknoir.com`. It serves the bounded Ankr methods used by the extension. Bitcoin, Solana, NEAR, and Blockscout providers remain direct client requests.

Runtime caching is enabled in the [History proxy configuration](../packages/evm-history-worker/wrangler.json) and [RPC registry configuration](../packages/rpc-registry/wrangler.json), so deployments retain the setting. Public icon and registry responses use their existing cache headers; History and token-discovery responses use `Cache-Control: no-store`.

Configure `ANKR_API_KEYS` as a Worker runtime secret containing one to eight comma-separated keys. Do not commit the keys or pass them into the extension build. Use interactive input:

```bash
pnpm --filter @noir-wallet/evm-history-worker exec wrangler secret put ANKR_API_KEYS
pnpm --filter @noir-wallet/evm-history-worker deploy
```

Missing or invalid keys return service-unavailable errors. When using a Cloudflare Git build, select `v2` and the repository-relative `packages/evm-history-worker` root. A retry of an old build still uses that build's source revision.

Before enabling a new deployment, verify supported chains, native and token history, bounded or partial responses, account isolation, rate limiting, and failure fallback. A remote failure must retain existing cache and locally initiated transactions. Deployment and live-service verification are separate from local unit tests and extension builds.
