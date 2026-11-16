# Noir Wallet CI/CD and Release Workflow

This runbook covers V2 extension previews, Beta releases, and production candidates on `main`. [Extension CI](../.github/workflows/extension-ci.yml) creates development inspection artifacts. The [manual release workflow](../.github/workflows/extension-release.yml) prepares Betas and production candidates; [Publish Accepted Extension](../.github/workflows/publish-extension.yml) promotes an accepted production artifact and optionally submits it for Chrome Web Store review. SDK staging and final store go-live remain separate manual operations. The [documentation workflow](../.github/workflows/docs.yml) validates documentation without deploying it.

On repeated PR pushes, SDK and documentation verification reuse a prior successful run only when the target branch commit and relevant inputs are unchanged. A failed, cancelled, or incomparable run performs the checks again.

## Branches and Versions

- Feature and fix PRs merge into `main`. PRs that change extension code, tests, WASM, the EVM history Worker, or related build and test inputs automatically run Extension CI and build a development extension. New commits cancel older runs for the same PR; no preview label is needed. Changes limited to Markdown documentation, SDK source, or unrelated tooling do not start Extension CI.
- To prepare a V2 Beta, dispatch `extension-release.yml` from the `main` workflow branch with mode `beta` and `source_ref=main`. The workflow builds that dispatched commit; required `confirm_sha` checks it against the reviewed full SHA. Publishing is controlled by that manual run's `publish_beta` input; see [Routine Previews](#routine-previews).
- `v1` retains the frozen V1 source. New development targets `main`; V1 packages are no longer built or published. Pushes and tags do not publish extension releases. Production candidates require a reviewed `release/X.Y.Z` branch and a separate manual promotion.
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

V2 repository PR previews and releases enable Mainnet analytics. PR previews use `BUILD_CHANNEL=beta`. Repository PR and manual Beta builds require `RHEA_SWAP_ACCESS_TOKEN`, `GA_API_SECRET` and `CUSTOM_ANALYTICS_PASSWORD`; missing values fail the build. Fork PRs run checks as development builds without repository secrets and do not upload distributable previews; move reviewed changes to a repository branch to generate a configured test package. Local development and isolated browser-verification builds do not report analytics. Preview packages are not production candidates. The repository variable `EVM_HISTORY_API_ORIGIN` may override the default public History proxy origin; it must be a credential-free HTTPS origin without a path or query. The Worker API key stays in a Worker secret and is not passed into the extension build.

The default V2 build enables Zcash and EVM networks. Bitcoin, Solana, and NEAR remain deferred; their chain-selection entries show **Coming soon** and cannot start wallet operations. Use the default feature flags when preparing this Beta. Explicit `ENABLED_CHAIN_FEATURE_FLAGS` values are available for isolated implementation checks and must match their Playwright build profile; they do not change the default release scope.

The public History proxy serves only the existing Ankr History, EVM token discovery, and icon services. The client selects History adapters across chains; other chains request their own data sources directly. See the [Activity architecture](mutil-chain/architecture/transaction-lifecycle.md#6-local-first-activity-merge) for routing and cache fallback, and the [History proxy deployment](#history-proxy-deployment) for Worker configuration and deployment checks.

Private broadcast uses the separate `/v1/zero-indexer-endpoints` endpoint on `https://rpc.zknoir.com`, maintained in `packages/rpc-registry/src/zero-indexer-registry.ts`. Broadcast nodes are excluded from the scheduled synchronization-RPC monitor. Deploying that registry is separate from publishing the extension; check its response when updating managed nodes. If the registry is unavailable, the extension uses its cache or bundled broadcast nodes. Wallet settings and recovery behavior are documented in the [broadcasting guide](../packages/docs/content/docs/wallet-guide/install-and-setup.mdx#transaction-broadcasting).

The V2 Beta contains one ZIP for both runtime network modes, `SHA256SUMS`, and Release notes with its source commit. The manual workflow builds the dispatched `main` commit and publishes the verified artifact in a separate write-scoped job. CI previews retain numeric base-version labels for the [preview reporter](../.github/workflows/extension-preview-comment.yml); their metadata retains the full Beta version and tested merge commit.

### Historical Releases

The SDK is maintained in `packages/sdk/` with its own version and [npm staging process](#sdk-npm-staging). For historical stable wallet Releases migrated from [the SDK repository](https://github.com/NoirWallet/noir-wallet-sdk/releases), copy the binary assets byte-for-byte and link each original Release in the migration notes. Preserve wallet source commit links where the original notes provide them, pointing old `NoirWallet/noir-wallet` commit URLs to `NoirWallet/noir-wallet-private` with the same SHA; do not infer missing wallet source commits from the SDK Release target. Migration tags in this repository point to its initial commit (`5d7fcf4`); their source archives are not snapshots of the historical wallet source. This workflow does not modify those Releases.

The wallet source repository is public. Use its Releases for current wallet downloads; existing Releases in the former SDK repository remain historical mirrors. The wallet download and repository entry points are [wallet builds](https://zknoir.com/beta/versions) and [wallet source](https://zknoir.com/github); see the [website build configuration](../README.md#build).

## WASM Package Updates

WASM source and releases are maintained separately. V2 commits complete packages for Zcash at `packages/extension/src/lib/wasm-pkg/` and Multichain at `packages/extension/src/infrastructure/generated/wasm/multichain/`. Each contains a `wasm-integrity.json` with source, ABI, build-tool versions, and artifact hashes. Upstream releases do not automatically update the wallet; ordinary builds and merges use these committed packages without rebuilding or synchronizing WASM. Merges do not amend commits.

For an intentional upgrade, select an upstream release and update the relevant engine's source/build/ABI pins and compatibility checks in this wallet repository. Use a clean separate source checkout at the pinned full commit. The explicit local commands rebuild with the checked tool versions and generate the complete package and integrity manifest:

```bash
pnpm sync-wasm-pkg -- --source <zcash-checkout>
pnpm sync-multichain-wasm-pkg -- --source <multichain-checkout>
```

Run only the command for the engine being updated. These commands build fresh output; they do not import an existing `pkg/`. They reject dirty source checkouts, mismatched commits, and mismatched tool versions. Check the sync script for its pinned tools and optional local tool paths before running it.

Develop and test the extension against the generated package, then submit its complete files, integrity manifest, updated pins, and related extension changes in one PR targeting `main`. Include the upstream version and checks performed. Never submit only TypeScript bindings without their matching loader, binary, and support files. Run the [verification and build commands](#verification-and-build); the build checks both engine manifests without access to the source repositories.

## Routine Previews

1. Open a PR against `main` and check **Extension CI**. Download the development package from its PR comment or **Actions → Extension CI** after the run succeeds. Downloads require GitHub sign-in and repository access and expire after three days. Rerun Extension CI for the current PR commit if the package expires. Fork PRs receive no repository secrets.
2. Run `gh workflow run extension-release.yml --ref main -f mode=beta -f source_ref=main -f confirm_sha=<reviewed-full-SHA> -F publish_beta=false` to build without publishing. The selected source must match the dispatched and current `main` commit. Set `publish_beta=true` to create its public GitHub prerelease. A mismatched `confirm_sha` stops the build.
3. Check Mainnet and Testnet Mode separately in a real isolated MV3 extension. Verify unavailable chain selectors and V1 Golden Profile upgrade compatibility using the same default flags as the Beta. Run browser and external-service checks locally; the workflow does not run them.

Set the extension package version to `2.0.0-beta.N` and add its matching `CHANGELOG.md` section. Chrome manifest versions remain numeric (`2.0.0`); `version_name` carries the Beta suffix. Product notes in `packages/web/public/changelog.json` use the numeric manifest version and keep `notifyUpdate: false` for this Beta. The workflow publishes `v2.0.0-beta.N` with ZIP `noir-wallet-v2.0.0-beta.N.zip` and notes from that section. Increment `N` for each public Beta.

## Production Release

### Release notes

`CHANGELOG.md` holds developer-oriented GitHub Release notes; `packages/web/public/changelog.json` holds the concise notes displayed after an extension update. Give each meaningful user-visible feature or important fix its own bullet, but combine minor fixes where appropriate. Do not pad the list or include internal refactors, tests, CI, or dependency updates unless they materially affect users. Keep the wording plain and specific. The changelog schema permits 1–8 bullets of at most 120 characters each; verify the current schema before changing this format.

### 1. Prepare and review the release source

Create a temporary `release/{version}` branch from the source you intend to ship. For a selective release, use the verified stable source commit or an actual production source tag, then cherry-pick the required fixes. Open a preparation PR for review; merging unrelated integration changes is not required.

1. Set a new version in `packages/extension/package.json`, for example `2.0.0`, and use branch `release/2.0.0`.
2. Add exactly one nonempty `## [2.0.0]` section to `CHANGELOG.md`.
3. Add the matching user-facing update entry in `packages/web/public/changelog.json`, following the [release notes rules](#release-notes).

Review the exact diff against the stable baseline and run the [verification and build commands](#verification-and-build). There is one extension ZIP for both runtime network modes.

### 2. Build and accept the production candidate

Open **Actions → Prepare Extension Release → Run workflow** from `main`. Select `mode=candidate`, set `source_ref=release/2.0.0`, and enter the full reviewed release branch HEAD in `confirm_sha`. `publish_beta` is ignored for candidates.

After all jobs succeed, open the `v2.0.0-rc.…` prerelease on the repository's Releases page or follow the download link in the run summary. Download its multichain ZIP and `SHA256SUMS`, check the hash, and validate both runtime network modes. The same files remain available in the final Actions artifact. Use these ZIPs, not a local rebuild or a previous Beta. Keep the run ID, attempt, and full source SHA from the prerelease notes or run summary for promotion. See [review responsibilities](../CONTRIBUTING.md#verification).

### 3. Promote the accepted artifact

After acceptance, open **Actions → Publish Accepted Extension → Run workflow** from `main`. Leave `operation=publish` selected and enter the accepted `candidate_run_id`, `candidate_run_attempt`, and `confirm_sha`. This separate action is the production publication confirmation.

The workflow verifies the candidate's origin and current release branch before creating the GitHub Release and `v2.0.0` tag. It downloads and publishes the accepted ZIPs without rebuilding. With store automation enabled, separate `sign`, `upload`, `submit`, and `notify` jobs then process the production ZIP. Keep the source branch unchanged and present until publication completes.

### 4. Check publication

Confirm **Publish Accepted Extension** succeeded. In the wallet repository's Releases page, check the source tag/commit, Latest status, the expected ZIP assets, and release notes. Download `SHA256SUMS` beside the ZIPs and run `sha256sum --check SHA256SUMS` (or `shasum -a 256 --check SHA256SUMS` on macOS). Compare those hashes with the accepted candidate. Forks and private repositories other than `NoirWallet/noir-wallet` retain build artifacts only.

### 5. Submit to Chrome Web Store

When `CWS_AUTOMATION_ENABLED=true`, the promotion signs the accepted production ZIP (`noir-wallet-v{version}.zip`) into a CRX3 package without rebuilding it, uploads the CRX, submits it with `STAGED_PUBLISH`, `skipReview=false`, and `blockOnWarnings=true`, then sends the result to the configured Slack channel. The signed CRX and stage intent/result receipts are separate 30-day Actions artifacts, not GitHub Release assets. Each external write has a persisted intent first; an unconfirmed result is not blindly retried.

Check the workflow's `sign`, `upload`, `submit`, and `notify` results, ZIP and CRX checksums, and the Developer Dashboard status. A successful submission means the item is awaiting review or staged; it is not live. After approval, verify the version, permissions, and release notes in the Dashboard and publish it manually. [Chrome's deferred publication guidance](https://developer.chrome.com/docs/webstore/update#deferred_publishing_option) gives up to 30 days after approval before the staged submission returns to draft. Record the store publication time and retain the submission evidence; a matching version alone does not prove package correspondence. Historical migration tags remain subject to the [source limitations above](#historical-releases).

### Chrome Web Store setup

Store automation runs only for `NoirWallet/noir-wallet` and only when the repository variable `CWS_AUTOMATION_ENABLED` is `true`; unset or `false` keeps promotion limited to the GitHub Release. Set these values in `cws-production`:

| Type     | Name                             | Value                                                      |
| -------- | -------------------------------- | ---------------------------------------------------------- |
| Variable | `CWS_PUBLISHER_ID`               | Publisher ID of the production store account               |
| Variable | `CWS_EXTENSION_ID`               | `mfoghjbpfanobmnoemoepenjjcmfpmdn`                         |
| Variable | `CWS_SIGNING_PUBLIC_KEY_SHA256`  | Lowercase SHA-256 of the RSA public key in DER SPKI format |
| Variable | `GCP_PROJECT_ID`                 | Google Cloud project with Chrome Web Store API enabled     |
| Variable | `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full Workload Identity provider resource name              |
| Variable | `GCP_SERVICE_ACCOUNT`            | Service account authorized for this store item             |
| Secret   | `CWS_SIGNING_PRIVATE_KEY`        | Existing PEM RSA CRX signing private key                   |
| Secret   | `CWS_SLACK_WEBHOOK_URL`          | Incoming Webhook bound to the intended Slack channel       |

Do not replace the existing signing key during setup. If store signing protection is enabled, retain its enrolled key; otherwise register the corresponding public key in Chrome Web Store before enabling automation. Verify its public key fingerprint against `CWS_SIGNING_PUBLIC_KEY_SHA256`; the CRX signing identity does not have to equal the store listing ID. Restrict the Workload Identity provider to this repository's numeric owner and repository IDs, `main`, the `publish-extension.yml` workflow, and `cws-production`. The workflow requests the `chromewebstore.readonly` scope for `check-auth` and the `chromewebstore` scope for upload and submission. Run [Extension Store Rehearsal](../.github/workflows/extension-store-ci.yml) on the PR and `operation=check-auth` successfully before setting `CWS_AUTOMATION_ENABLED=true`. The rehearsal runs release/store tests and transfers a synthetic CRX signed with a temporary key between runners; it uses no production credentials or package. Neither check proves a real upload, review submission, or Slack delivery.

Candidate packaging and promotion enforce:

1. The source branch is `release/` plus the numeric version in `packages/extension/package.json`, and its resolved commit matches the manually confirmed full SHA.
2. The candidate uses production build settings and includes one multichain ZIP for both runtime network modes.
3. `CHANGELOG.md` has exactly one nonempty `## [version]` section for that version.
4. `packages/web/public/changelog.json` has a matching entry accepted by the wallet's release-notes parser.

Promotion additionally verifies a successful candidate workflow dispatched from this repository's `main`, the exact run attempt and artifact ID, artifact metadata, every ZIP checksum, and unchanged release branch HEAD. A Beta or PR artifact cannot be promoted. Source code need not be contained in `main`. Existing production tags are never moved, and published assets are never overwritten.

## Failure Recovery

- PR check/build failure: fix the source and update the PR; Extension CI builds the new commit automatically. An existing development artifact is not a release candidate.
- Missing Beta build input: configure `RHEA_SWAP_ACCESS_TOKEN` in the trusted release repository and rerun the manual workflow. Do not publish the PR development ZIP as Beta.
- Incorrect selected source: review the current `main` commit and dispatch again with its full SHA in `confirm_sha`; verify the source commit and checksums before publication.
- Beta publication failure: inspect the original run and any tag or Release it created before retrying. The workflow never reuses an existing tag; a failure after tag creation requires manual review and recovery rather than moving the tag or replacing its assets.
- Production publication failure: inspect the original candidate run, artifact, and any existing Release before retrying with the same accepted run, attempt, and SHA. Matching published assets are retained; conflicting or partial publication requires manual review. For an uncertain store upload or review submission, inspect the saved receipts and Developer Dashboard before retrying. Do not move a published tag, rebuild its package, or cancel review as a retry mechanism.

## SDK npm Staging

The SDK has its own version in `packages/sdk/package.json`. Before npm setup or merge, the [SDK PR workflow](../.github/workflows/sdk.yml) must pass its no-publication rehearsal: it checks and retains one tarball, then a separate read-only job validates that artifact, runs the npm CLI staging dry-run, and installs the same tarball as a consumer. The dry-run does not verify GitHub OIDC or npm server staging. The [SDK staging workflow](../.github/workflows/publish-sdk.yml) runs only in the public, non-fork `NoirWallet/noir-wallet` repository on `main`. Publication is manual: maintainers dispatch `operation=stage`, select the Beta release line, and confirm the exact version and full source SHA. The workflow builds and tests the selected SDK and example, packs the SDK once, checks that tarball as an installed consumer, and retains the tarball and source metadata as an Actions artifact for up to 30 days. Its separate upload job uses the `sdk-npm` environment to stage that same tarball using npm trusted publishing with provenance; it does not directly publish a version or change npm dist-tags.

| Release line | Source branch | SDK versions                               | npm dist-tag |
| ------------ | ------------- | ------------------------------------------ | ------------ |
| `beta`       | `main`        | `2.x.y-beta.N`, starting at `2.0.0-beta.1` | `beta`       |

V1 SDK publication is frozen. New SDK candidates use the npm `beta` channel; `latest` remains on the existing V1 stable line. Only the current commit of the selected source branch can start a candidate; unmerged branches cannot be staged. Subsequent jobs use that fixed source SHA. Source and workflow commits are recorded separately: npm provenance identifies the trusted `main` workflow commit, while the original candidate artifact binds the selected SDK source and package bytes. SDK Beta releases do not require a simultaneous extension release.

### One-time npm setup

After the PR rehearsal passes and the workflow is merged to `main`, add a Trusted Publisher in the npm settings for `@noir-wallet/sdk` with GitHub owner `NoirWallet`, repository `noir-wallet`, workflow filename `publish-sdk.yml`, and environment `sdk-npm`. New configurations automatically allow `npm stage publish`; leave **Allow npm publish** and **Allow npm dist-tag** disabled. Create the GitHub `sdk-npm` environment and restrict deployment to `main`. Keep npm account two-factor authentication enabled for the maintainer who approves staging. Configure and validate a new Trusted Publisher within npm's two-day setup window; check the current npm settings before staging. The workflow uses npm CLI `11.21.1` and GitHub OIDC; do not add an npm access-token secret. After migration succeeds, review and remove obsolete Trusted Publishers or tokens for the former SDK repository.

After `SDK Gate` has run successfully, configure an additional ruleset for `main` only: require one approval, approval of the most recent reviewable push by another maintainer, and the `SDK Gate` check from GitHub Actions with the branch up to date before merging. Use no bypass actors. The SDK PR workflow runs for every PR to `main`; its gate accepts complete checks or explicit reuse of a prior successful check of unchanged relevant inputs.

### Stage and accept a version

1. Open a PR for the SDK version change against its source branch and require `SDK Gate` to pass before merging the reviewed PR. Choose an unpublished version from the release line above; do not reuse a version already present on npm or in staging. Complete the one-time npm setup. Before starting a new candidate, check npm **Staged Packages** and finish or resolve any pending candidate for this package.
2. Select `Stage SDK on npm` on `main`, choose `operation=stage` and `release_line=beta`, and enter the package version and full current SHA of `main`. Keep the run ID, original build attempt, source SHA, workflow SHA, and artifact name. Verify the tarball checksum and inspect its contents before approval.
3. Test three combinations in a real browser against the existing Zcash contract: the candidate SDK tarball with the accepted V1 Mainnet and Testnet ZIPs, the candidate SDK tarball with the accepted V2 candidate ZIP, and the existing published SDK with that V2 candidate ZIP. Record SHA-256 hashes for both SDK packages and every extension ZIP used. The CI consumer check does not establish browser or extension behavior.
4. Open npm **Staged Packages** from the account page in the run summary, find the reported Stage ID, confirm the candidate's target dist-tag, and approve with the authorized npm account and its two-factor authentication. Run the verification command from the candidate's build or staging summary; it binds `operation=verify` to the original `candidate_run_id` and `candidate_run_attempt`. The same fields can be entered manually when dispatching the workflow from `main`; verification restores the release line and target tag from the original candidate. It compares the published package and provenance with the accepted artifact, installs the registry version as a consumer, and runs `npm audit signatures`. Beta verification requires `beta` to point to the candidate and `latest` to remain on the V1 stable line; a newer V1 release does not invalidate the Beta. Check that verification succeeds before announcing the version.

Only the staging job has OIDC permission. The verification operation has read-only repository permissions and cannot approve or publish on npm. OIDC cannot query staged packages, so an upload timeout, command failure, or invalid receipt leaves the staging result unconfirmed. Check npm before retrying:

| Confirmed state                         | Recovery                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No staged or published version exists   | Use **Re-run failed jobs** while the original build artifact remains available; this preserves the original bytes and build attempt.                                        |
| The version is staged                   | Compare the package, version, target dist-tag, and downloaded tarball checksum with the accepted artifact. If they match, finish acceptance and approve the existing stage. |
| The version is published                | Run verification against the original candidate, including when its staging workflow failed.                                                                                |
| The state is unknown or contents differ | Stop and investigate before uploading or approving.                                                                                                                         |

Fix artifact or registry preflight failures before rerunning the affected job. An expired original artifact blocks standard verification; repacking cannot recover the accepted candidate. After a deliberate new build, use its new artifact and build attempt and repeat acceptance. Existing or conflicting npm versions, a newer target dist-tag, mismatched source or run metadata, and missing provenance stop the workflow. A verification failure reports whether the version was confirmed published, confirmed absent from the registry, or its publication state remains unknown; only the completed verification establishes release acceptance.

The SDK example in `packages/sdk/example/` is verified on pull requests and deployed by the existing GitHub Pages job after successful `main` checks. SDK npm publication is independent of extension releases.

## Website and Signup Worker

The website at `https://www.zknoir.com/` keeps its existing Cloudflare Pages Git integration. It builds and publishes the independent `/frost` page with the rest of the website. The [Website Signup Worker workflow](../.github/workflows/web-vote.yml) deploys only `packages/web-vote/`, independently of Pages and wallet releases. Homepage traffic continues to use Pages; signup API routing is defined in the [Worker configuration](../packages/web-vote/wrangler.json).

### One-Time Deployment Credentials

In the GitHub repository, open **Settings → Secrets and variables → Actions** and add these repository secrets:

| Secret                  | Value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account containing the website's zone and the signup Worker                |
| `CLOUDFLARE_API_TOKEN`  | A Cloudflare API token authorized to deploy the Worker and manage its routes in that zone |

Follow [Cloudflare's GitHub Actions authentication guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) to create a token using the **Edit Cloudflare Workers** template and restrict it to the intended account and website zone. See [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/) for Worker creation and route permissions. Store the token in Actions secrets, never in source files or frontend build variables. The configured hosts must use Cloudflare-proxied DNS for Worker routes.

### Signup Email Configuration

In Cloudflare **Workers & Pages → noir-web-vote → Settings → Variables and Secrets**, configure these runtime **Secrets** before production deployment:

| Secret               | Value                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `SMTP_USER`          | The Google account used for SMTP authentication; use the primary account if the sender is an alias |
| `SMTP_APP_PASSWORD`  | The account's 16-character Google App Password; grouping spaces are removed                        |
| `SIGNUP_MAIL_CONFIG` | A JSON object in the format below                                                                  |

The sender is fixed to `support@zknoir.com`; it must be the authenticated mailbox or its verified Gmail send-as alias. The transport uses certificate-verified TLS on port 465. Keep these values in Worker Secrets, outside Actions secrets, Wrangler `vars`, source files, and frontend builds. Production declares them required; the local environment disables sending.

```json
{
  "subject": "You're on the list — NoirWallet FROST",
  "preheader": "Thanks for your interest in FROST.",
  "title": "Two devices. One secure vault.",
  "paragraphs": ["Thanks for signing up for updates on our planned FROST vault."],
  "button": { "text": "Explore FROST", "url": "https://www.zknoir.com/frost" }
}
```

`subject`, `title`, and a nonempty `paragraphs` array are required; `preheader` and `button` are optional. Body values are plain text escaped by the HTML template; buttons require an HTTPS URL without credentials. Emails include HTML and a plain-text alternative. Pending jobs use the configuration in effect when processed.

After deploying, check readiness, then submit an email you control that has not already registered and inspect its inbox. Readiness and dry runs do not verify Gmail credentials, sender alias authorization, or inbox delivery. Local development disables sending and does not load SMTP secrets.

For delivery recovery, inspect the private `signup_mail` table using **Durable Objects → noir-web-vote/FrostVotes → Data Studio**, object name `frost-early-signup-v1`:

```sql
SELECT id, status, attempts, error_code, error_stage, smtp_code, error_name
FROM signup_mail
ORDER BY updated_at DESC
LIMIT 20;
```

`pending` awaits an alarm, `sending` is in flight, and `sent` means SMTP acceptance, not confirmed inbox delivery. `failed` marks a permanent rejection or exhausted retries. `unknown` marks ambiguous acceptance or an interrupted send; investigate before any resend. Invalid mail configuration leaves jobs pending and schedules another configuration check after at least five minutes, without consuming a send attempt. Do not reset signup records to resend mail. Existing signups are not backfilled, and historical votes remain untouched.

Failure logs contain only bounded diagnostic fields and the outcome, never recipient addresses, credentials, exception messages, or raw SMTP responses. `EAUTH` with SMTP code `535` identifies an authentication rejection; verify the actual Google login account and App Password. `ESOCKET`, `ETLS`, or `ETIMEDOUT` at `CONNECT` identifies connection or TLS setup failure. `WORKER_INTERRUPTED` records a restarted in-flight job. Correct configuration failures without deleting saved signups or mail history. The signup client lives in `packages/web/src/pages/FrostVotePage.tsx`.

### Automatic Deployment and Recovery

- Relevant pushes to `main` verify the Worker, test and build the signup client, then deploy the production Worker. The workflow's path filters define relevant changes.
- Pull requests run verification without deployment or access to the deployment credentials. Forks do not deploy.
- Manual runs can deploy from `main`; other branches only verify. Missing credentials fail deployment with a configuration error.
- Deployment uses the committed Wrangler configuration, including runtime caching and the existing Durable Object binding and migration. Signup responses use `Cache-Control: no-store`. Signups use a separate named instance from historical votes; neither stored dataset is reset, and local test data is not uploaded.
- Before deployment, the run's commit must still match current `main`. Rerunning an older workflow cannot replace a newer Worker deployment; start a new manual run from current `main` instead.
- The final step performs a read-only health request to the production API and validates its response against the client contract. It does not submit a production signup or read email addresses.

After pushing, check **Actions → Website Signup Worker** and the existing Pages deployment status. These are independent deployments; the page may publish before its API is ready. If credential or route setup fails, correct the relevant account, token, or DNS configuration and rerun the workflow from `main`. If the post-deployment API check fails, inspect the route and API response: the deployment may already have succeeded. Do not remove the Durable Object or reset stored data to recover a failed deployment. For a code regression, revert the affected change on `main` and let the normal deployment workflow publish the correction. No production deployment is verified merely by a local dry run.

## History Proxy Deployment

The existing Worker source is `packages/evm-history-worker/`; its production hostname is `https://history-proxy.zknoir.com`. It serves the bounded Ankr methods used by the extension. Bitcoin, Solana, NEAR, and Blockscout providers remain direct client requests.

Runtime caching is enabled in the [History proxy configuration](../packages/evm-history-worker/wrangler.json) and [RPC registry configuration](../packages/rpc-registry/wrangler.json), so deployments retain the setting. Public icon and registry responses use their existing cache headers; History and token-discovery responses use `Cache-Control: no-store`.

Configure `ANKR_API_KEYS` as a Worker runtime secret containing one to eight comma-separated keys. Do not commit the keys or pass them into the extension build. Use interactive input:

```bash
pnpm --filter @noir-wallet/evm-history-worker exec wrangler secret put ANKR_API_KEYS
pnpm --filter @noir-wallet/evm-history-worker deploy
```

Missing or invalid keys return service-unavailable errors. When using a Cloudflare Git build, select `main` and the repository-relative `packages/evm-history-worker` root. A retry of an old build still uses that build's source revision.

Before enabling a new deployment, verify supported chains, native and token history, bounded or partial responses, account isolation, rate limiting, and failure fallback. A remote failure must retain existing cache and locally initiated transactions. Deployment and live-service verification are separate from local unit tests and extension builds.

The website Beta guide pins an existing published ZIP in `packages/web/src/lib/v2-beta-release.ts`. Advance that link only after verifying the new Release download; a source merge alone does not make a Beta available.
