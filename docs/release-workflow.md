# Noir Wallet CI/CD and Release Workflow

This runbook describes automatic PR checks and preview packages in [extension-ci.yml](../.github/workflows/extension-ci.yml), manual Beta and production candidate builds in [extension-release.yml](../.github/workflows/extension-release.yml), and promotion and optional Chrome Web Store submission in [publish-extension.yml](../.github/workflows/publish-extension.yml). The [documentation workflow](../.github/workflows/docs.yml) verifies the documentation site on relevant pull requests but does not deploy it. The [SDK workflow](../.github/workflows/sdk.yml) checks the SDK package and example; [SDK npm staging](#sdk-npm-staging) is a separate workflow. Website and signup Worker deployment are described in [Website and Signup Worker](#website-and-signup-worker). SDK npm staging approval and final Chrome Web Store go-live remain manual operations.

On repeated PR pushes, SDK and documentation verification reuse a prior successful run only when the target branch commit and relevant inputs are unchanged. A failed, cancelled, or incomparable run performs the checks again.

## SDK npm Staging

The SDK has its own version in `packages/sdk/package.json`. Before npm setup or merge, the [SDK PR workflow](../.github/workflows/sdk.yml) must pass its no-publication rehearsal: it checks and retains one tarball, then a separate read-only job validates that artifact, runs the npm CLI staging dry-run, and installs the same tarball as a consumer. The dry-run does not verify GitHub OIDC or npm server staging. The [SDK staging workflow](../.github/workflows/publish-sdk.yml) runs only in the public, non-fork `NoirWallet/noir-wallet` repository on `main`. Publication is manual: maintainers dispatch `operation=stage`, select a release line, and confirm the exact version and full source SHA. The workflow builds and tests the selected SDK and example, packs the SDK once, checks that tarball as an installed consumer, and retains the tarball and source metadata as an Actions artifact for up to 30 days. Its separate upload job uses the `sdk-npm` environment to stage that same tarball using npm trusted publishing with provenance; it does not directly publish a version or change npm dist-tags.

| Release line | Source branch | SDK versions                               | npm dist-tag |
| ------------ | ------------- | ------------------------------------------ | ------------ |
| `stable`     | `main`        | `0.x.y`, starting at `0.2.0`               | `latest`     |
| `beta`       | `v2`          | `2.x.y-beta.N`, starting at `2.0.0-beta.1` | `beta`       |

Only the current commit of the selected source branch can start a candidate; unmerged branches cannot be staged. Subsequent jobs use that fixed source SHA. Source and workflow commits are recorded separately: npm provenance identifies the trusted `main` workflow commit, while the original candidate artifact binds the selected SDK source and package bytes. SDK Beta releases do not require a simultaneous extension release.

### One-time npm setup

After the PR rehearsal passes and the workflow is merged to `main`, add a Trusted Publisher in the npm settings for `@noir-wallet/sdk` with GitHub owner `NoirWallet`, repository `noir-wallet`, workflow filename `publish-sdk.yml`, and environment `sdk-npm`. New configurations automatically allow `npm stage publish`; leave **Allow npm publish** and **Allow npm dist-tag** disabled. Create the GitHub `sdk-npm` environment and restrict deployment to `main`. Keep npm account two-factor authentication enabled for the maintainer who approves staging. Configure and validate a new Trusted Publisher within npm's two-day setup window; check the current npm settings before staging. The workflow uses npm CLI `11.21.1` and GitHub OIDC; do not add an npm access-token secret. After migration succeeds, review and remove obsolete Trusted Publishers or tokens for the former SDK repository.

After `SDK Gate` has run successfully, configure an additional ruleset for `main` only: require one approval, approval of the most recent reviewable push by another maintainer, and the `SDK Gate` check from GitHub Actions with the branch up to date before merging. Use no bypass actors. Preserve the existing ruleset shared with `v2`. The SDK PR workflow runs for every PR to `main` and `v2`; its gate accepts complete checks or explicit reuse of a prior successful check of unchanged relevant inputs.

### Stage and accept a version

1. Open a PR for the SDK version change against its source branch and require `SDK Gate` to pass before merging the reviewed PR. Choose an unpublished version from the release line above; do not reuse a version already present on npm or in staging. Complete the one-time npm setup. Before starting a new candidate, check npm **Staged Packages** and finish or resolve any pending candidate for this package.
2. Select `Stage SDK on npm` on `main`, choose `operation=stage` and `release_line=stable` or `beta`, and enter the package version and full current SHA of `main` or `v2`, respectively. Keep the run ID, original build attempt, source SHA, workflow SHA, and artifact name. Verify the tarball checksum and inspect its contents before approval.
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

Failure logs contain only bounded diagnostic fields and the outcome, never recipient addresses, credentials, exception messages, or raw SMTP responses. `EAUTH` with SMTP code `535` identifies an authentication rejection; verify the actual Google login account and App Password. `ESOCKET`, `ETLS`, or `ETIMEDOUT` at `CONNECT` identifies connection or TLS setup failure. `WORKER_INTERRUPTED` records a restarted in-flight job. Correct configuration failures without deleting saved signups or mail history. See the [README](../README.md#frost-beta-signup) for signup and retry behavior.

### Automatic Deployment and Recovery

- Relevant pushes to `main` verify the Worker, test and build the signup client, then deploy the production Worker. The workflow's path filters define relevant changes.
- Pull requests run verification without deployment or access to the deployment credentials. Forks do not deploy.
- Manual runs can deploy from `main`; other branches only verify. Missing credentials fail deployment with a configuration error.
- Deployment uses the committed Wrangler configuration, including runtime caching and the existing Durable Object binding and migration. Signup responses use `Cache-Control: no-store`. Signups use a separate named instance from historical votes; neither stored dataset is reset, and local test data is not uploaded.
- Before deployment, the run's commit must still match current `main`. Rerunning an older workflow cannot replace a newer Worker deployment; start a new manual run from current `main` instead.
- The final step performs a read-only health request to the production API and validates its response against the client contract. It does not submit a production signup or read email addresses.

After pushing, check **Actions → Website Signup Worker** and the existing Pages deployment status. These are independent deployments; the page may publish before its API is ready. If credential or route setup fails, correct the relevant account, token, or DNS configuration and rerun the workflow from `main`. If the post-deployment API check fails, inspect the route and API response: the deployment may already have succeeded. Do not remove the Durable Object or reset stored data to recover a failed deployment. For a code regression, revert the affected change on `main` and let the normal deployment workflow publish the correction. No production deployment is verified merely by a local dry run.

## Branches and Releases

- `main` is the integration branch. Submit features and fixes through short-lived pull request branches; `v2` is also an extension verification target.
- Pull requests targeting `main`, `v2`, or `release/**` automatically run Extension CI when extension code, tests, WASM, or related build inputs change. Each new commit runs checks and builds a downloadable preview in one job; no label is needed. A new commit cancels an older run for that PR. Merging to `main` does not repeat the preview build. Automatic builds do not publish GitHub Releases.
- Manual Beta builds select a repository branch or full commit SHA without requiring a merge to `main`.
- V1 sources use separate mainnet and testnet ZIPs. V2 sources (extension version major 2 or later) use one multichain ZIP with runtime network selection. Both use the trusted manual workflow dispatched from `main`; select `source_ref=v2` for the current V2 source.
- A temporary `release/{version}` branch holds the reviewed production source. For a partial release or hotfix, start from a verified stable wallet source commit or a real production source tag, and cherry-pick only the intended changes. Historical migration tags are not usable source baselines; see [historical Releases](#historical-releases).
- Build a production candidate, accept its production ZIPs, then run a separate manual promotion. Promotion publishes those exact bytes and creates `v{version}` on the accepted source commit. Pushing a tag alone does not publish.
- The canonical `NoirWallet/noir-wallet` repository publishes wallet Releases even while private. Other public, non-fork repositories also publish to themselves. Forks and other private repositories retain Actions build artifacts without publishing Releases.
- Release workflow definitions must run from `main`; the source input selects wallet code independently. Keep the release branch until promotion completes, then merge applicable fixes back to integration branches and remove the temporary branch.

```mermaid
flowchart LR
  A["Feature / Fix PR"] --> B["Checks; requested preview: V1 two ZIPs / V2 one ZIP"]
  C["Selected branch / commit"] --> D["Manual Beta build"]
  D --> E["Optional GitHub prerelease"]
  F["Reviewed release/X.Y.Z source"] --> G["Manual production candidate build"]
  G --> H["Accept production ZIPs"]
  H --> I["Manual promotion of same ZIPs"]
  I --> J["GitHub Release + vX.Y.Z tag"]
  J --> K["Optional signed CRX upload and staged review submission"]
  K --> L["Manual store go-live after approval"]
```

### PR previews and Beta builds

The [Extension CI path filters](../.github/workflows/extension-ci.yml) cover extension code and tests, the EVM history Worker, related packaging and test helpers, and shared build inputs. Changes limited to Markdown documentation, SDK source, or unrelated tooling do not start extension builds. Core tests run once in the same job as the extension builds, which include TypeScript checking. V1 verifies the vendored WASM package and builds Mainnet and Testnet ZIPs with the `beta` channel. V2 type-checks the EVM history Worker and builds one `development` ZIP with an explicit development artifact name. Repository V2 previews include `RHEA_SWAP_ACCESS_TOKEN` for Swap and fail the build if it is missing. Fork PR previews receive no repository secrets and cannot use Swap. Manual Beta artifacts use `beta`. PR metadata records the tested merge commit plus PR head and base commits.

[Extension Preview Download](../.github/workflows/extension-preview-comment.yml) updates one bot comment when Extension CI starts or finishes. It shows a build in progress, its failure, or the current download. Successful builds link the package for the PR head with build and expiration times; package metadata names the tested merge commit. Old commits and superseded attempts cannot overwrite a newer result. Downloads require GitHub sign-in and repository access, expire after three days, and remain under **Actions → Extension CI**. Rerun Extension CI for the current PR commit if its package has expired or is unavailable. Only the two newest verified preview artifacts per PR are retained.

The reporting workflow runs only trusted `main` code with `actions: write` for verified preview artifact retention and `pull-requests: write` for the comment. It reads GitHub metadata without downloading or executing PR artifacts. Wallet builds retain read-only permissions. Merge reporting changes into `main` to enable them for both V1 and V2 PRs, including fork PRs. Ignored local UI tools and `output/` are not committed or release triggers.

Manual builds generate labels containing the run ID, attempt, and source commit; do not create them manually:

```text
v{version}-beta.{run ID}.{attempt}.{short source SHA}
v{version}-rc.{run ID}.{attempt}.{short source SHA}
```

Multiple Betas can use the same extension version. Manual runs are queued rather than cancelling an earlier build. Candidate labels identify Actions artifacts only; a candidate does not create a tag or Release. Manual build artifacts are retained for 30 days.

### Manual confirmation and production validation

Both manual workflows require repository write access and must be dispatched from `main`. Candidate construction requires confirmation of the full reviewed source SHA. `operation=publish` requires a separate dispatch with the accepted candidate run ID, attempt, and full source SHA; `operation=check-auth` needs no candidate and only checks read-only store authorization. These are maintainer confirmations; the workflows do not enforce a second independent reviewer. Configure `cws-production` for `main` only, without a required reviewer. See [manual workflow permissions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) and [environment review availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments).

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
2. The candidate uses production build settings and includes the expected packages: separate mainnet/testnet ZIPs for V1 or one multichain ZIP for V2.
3. `CHANGELOG.md` has exactly one nonempty `## [version]` section for that version.
4. `packages/web/public/changelog.json` has a matching entry accepted by the wallet's release-notes parser.

Promotion additionally verifies a successful candidate workflow dispatched from this repository's `main`, the exact run attempt and artifact ID, artifact metadata, every ZIP checksum, and unchanged release branch HEAD. A Beta or PR artifact cannot be promoted. Source code need not be contained in `main`. Existing production tags are never moved, and published assets are never overwritten.

## Workflow Stages

### Prepare

Resolve the selected branch once to a full source SHA and read its extension version and build profile. Candidates additionally confirm the source SHA and matching release branch. The same trusted preparation job maintains [associated PR version labels](../CONTRIBUTING.md#pull-request-targets) and reads recent commit history without executing selected-source code. Release notes include a folded commit log with up to 20 non-merge commits from the pinned source's most recent 100 commits, excluding subjects prefixed with `ci`, `fix(ci)`, `chore`, or `test`. Checkout the pinned source for testing and building. The trusted packaging job validates developer changelog and user-facing notes before exposing a candidate for acceptance.

### Verify

Every preview, Beta, and candidate build installs the frozen dependencies and runs deterministic core tests. V1 additionally verifies the vendored WASM lock:

```bash
pnpm install --frozen-lockfile
pnpm verify-wasm-pkg
pnpm test
```

`verify-wasm-pkg` checks the V1 vendored WASM provenance metadata, file inventory, sizes, and SHA-256 values against `wasm-package.lock.json`. V2 type-checks its EVM history Worker and verifies both packaged WASM engines through its existing build-surface gate after compilation. CI does not build or download WASM. Beta and production use the selected source's deterministic core tests. UI, Playwright, and hardware checks are local development activities, not automated release gates.

Before promotion, run `pnpm audit --prod` and `pnpm audit` against the frozen lockfile. Review each reported dependency path and affected API against the shipped extension bundles; apply compatible fixes and assess any remaining findings before release.

### Build

After verification, V1 builds both networks in order:

```bash
pnpm build:extension
pnpm build:extension:testnet
```

V2 runs only `pnpm build:extension`; that ZIP includes its runtime mainnet/testnet selection. `BUILD_CHANNEL` is `beta` for manual Betas and V1 PRs, `development` for V2 PRs, or `production` for candidates. Pull requests run tests and builds without publishing or receiving build secrets.

Build jobs keep read-only repository permissions. Manual builds upload their ZIPs to a fresh packaging job that executes tooling from the trusted workflow commit. It downloads ZIPs into a new directory outside the selected wallet checkout and reads only version and release-note data from that checkout. The final artifact contains the ZIP assets, `SHA256SUMS`, `release-metadata.json`, and `release-body.md`. Metadata binds the files to their source commit, build channel, repository, workflow commit, run ID, and attempt. V2 metadata identifies its single asset as `multichain`. Repository retention policies can shorten the requested retention.

V2 manual Beta and candidate builds require the existing `RHEA_SWAP_ACCESS_TOKEN` repository secret. The optional `EVM_HISTORY_API_ORIGIN` repository variable configures its history API and must satisfy V2's existing HTTPS-origin validation. These values are passed only to the selected V2 build. Missing required inputs fail the build; a development PR artifact cannot be published as Beta or promoted to production.

Production mainnet candidate builds require the repository secrets `GA_API_SECRET` and `CUSTOM_ANALYTICS_PASSWORD`. The workflow injects them only into the mainnet build step after the source SHA confirmation; a missing value stops the build. Local default builds, Beta builds, testnet builds, and local browser verification do not embed these values. For a local production mainnet build, supply the same environment variables through your shell and set `BUILD_CHANNEL=production`.

Analytics values embedded in the extension are visible to its users. They must not grant privileged server access or be relied on as confidential authentication. Rotate previously committed values before exposing repository history, and configure the replacements in repository secrets without committing them.

### Publish

The publish job runs in `NoirWallet/noir-wallet` regardless of visibility, and in other public, non-fork repositories. It downloads the exact artifact ID, validates provenance and checksums, and publishes to `github.repository`. Only publication jobs receive `contents: write`; they use the built-in `GITHUB_TOKEN`. Production promotion performs validation and publication in one job, executes no wallet source code, and performs no build. Releases in a private repository are visible only to people with repository access.

- Beta uses a prerelease and is not marked Latest. Its tag points to the wallet source commit that produced the ZIPs.
- Production creates `v{version}` at the accepted source SHA and is marked Latest. If that tag already exists, it must resolve to the same source commit. Earlier prereleases remain available.
- Production notes come from the matching `CHANGELOG.md` section. Each Release includes a source commit link, the ZIPs for its build profile, and `SHA256SUMS`.

V1 production assets are `noir-wallet-v{version}.zip` and `noir-wallet-v{version}-testnet.zip`; V2 has only the first asset. Candidate artifacts already use these filenames. Beta asset names include the Beta label. A promotion retry skips an existing Release only if its tag, all ZIP digests, and `SHA256SUMS` match the accepted candidate. GitHub's automatically attached source archives come from the wallet repository at the release tag.

### Historical Releases

The SDK is maintained in `packages/sdk/` with its own version and [npm staging process](#sdk-npm-staging). For historical stable wallet Releases migrated from [the SDK repository](https://github.com/NoirWallet/noir-wallet-sdk/releases), copy the binary assets byte-for-byte and link each original Release in the migration notes. Preserve wallet source commit links where the original notes provide them, pointing old `NoirWallet/noir-wallet` commit URLs to `NoirWallet/noir-wallet-private` with the same SHA; do not infer missing wallet source commits from the SDK Release target. Migration tags in this repository point to its initial commit (`5d7fcf4`); their source archives are not snapshots of the historical wallet source. This workflow does not modify those Releases.

The wallet source repository is public. Use its Releases for current wallet downloads; existing Releases in the former SDK repository remain historical mirrors. The wallet download and repository entry points are [wallet builds](https://zknoir.com/beta/versions) and [wallet source](https://zknoir.com/github); see the [website build configuration](../README.md#build).

## WASM Package Updates

WASM source and releases are maintained in a separate repository. This wallet repository commits the complete web package at `packages/extension/src/lib/wasm-pkg/`. The root `wasm-package.lock.json` records the source commit and ref, build features, release artifact SHA-256 when available, and individual file hashes. Upstream releases do not automatically update the wallet. Ordinary builds and merges use the committed package without downloading, rebuilding, or synchronizing WASM; merges do not amend commits.

Prefer an immutable published archive with its SHA-256:

```bash
pnpm update-wasm-pkg -- \
  --repository https://github.com/NoirWallet/zcash-wallet-wasm \
  --commit <full-commit-sha> \
  --ref <release-tag> \
  --features <comma-separated-features> \
  --artifact-url <https-url> \
  --artifact-sha256 <sha256>
```

For local WASM builds, check out the desired upstream tag or full commit in the separate repository. Start with a clean source checkout, remove its old generated `pkg/`, and rebuild the complete web release package using that repository's build instructions and the features you will record below. Then adopt it explicitly:

```bash
pnpm update-wasm-pkg:local -- \
  --ref <tag-or-full-commit-sha> \
  --features <comma-separated-features>
```

The local importer rejects tracked or untracked source changes and a ref that does not resolve to the checkout's HEAD. It records the full commit and hashes of the imported files; it does not rebuild or prove that an existing `pkg/` came from that commit. Rebuilding after selecting the source ref is the developer's responsibility. Use `--source <checkout>/pkg` when the separate checkout is outside `packages/zcash-wallet-wasm/`.

Develop and test the extension against that package, then submit the lock file, complete generated package, and related extension changes in one PR. Include the upstream version, build features, and verification performed. Never submit only updated TypeScript bindings without their matching loader, binary, and support files. Generated package files are excluded from formatting to preserve their hashes.

`pnpm sync-wasm-pkg` restores only the locked package and rejects source commits or `pkg/` hashes that differ from the lock; it is not an upgrade command. Run `pnpm verify-wasm-pkg` after an update. Both local extension build commands also verify the package before compilation, and CI verifies it without access to the source checkout. Do not create feature-specific `pkg-voting` directories.

## Beta Procedure

1. Push the intended branch and open a pull request. Relevant changes automatically run **Extension CI**; after it succeeds, download the package from its PR comment or Actions artifact and test it before merging.
2. For a distributable Beta, open **Actions → Prepare Extension Release → Run workflow** with the workflow branch set to `main`.
3. Select `mode=beta`, set `source_ref` to the intended repository branch or full lowercase 40-character commit SHA, and choose whether `publish_beta` should create a prerelease. Leave `confirm_sha` empty.
4. Check the resolved source SHA in the run summary. Download its artifact or published Beta ZIPs and test the affected flows. For V2 use `source_ref=v2` (or the intended V2 branch/full SHA); keep the workflow branch set to `main`.

No merge, version bump, or manually created tag is required for each Beta. Selecting a branch pins its HEAD for that run; later pushes do not change the built source.

## Production Procedure

### Release notes

`CHANGELOG.md` holds developer-oriented GitHub Release notes; `packages/web/public/changelog.json` holds the concise notes displayed after an extension update. Give each meaningful user-visible feature or important fix its own bullet, but combine minor fixes where appropriate. Do not pad the list or include internal refactors, tests, CI, or dependency updates unless they materially affect users. Keep the wording plain and specific. The changelog schema permits 1–8 bullets of at most 120 characters each; verify the current schema before changing this format.

### 1. Prepare and review the release source

Create a temporary `release/{version}` branch from the source you intend to ship. For a selective release, use the verified stable source commit or an actual production source tag, then cherry-pick the required fixes. Open a preparation PR for review; merging unrelated integration changes is not required.

1. Set a new version in `packages/extension/package.json`, for example `1.0.40`, and use branch `release/1.0.40`.
2. Add exactly one nonempty `## [1.0.40]` section to `CHANGELOG.md`.
3. Add the matching user-facing update entry in `packages/web/public/changelog.json`, following the [release notes rules](#release-notes).

Review the exact diff against the stable baseline and run the relevant local checks. For V1:

```bash
pnpm test
pnpm build:extension
pnpm build:extension:testnet
```

For V2, run `pnpm test` and `pnpm build:extension`; there is no separate testnet build. Use the actual V2 version and corresponding `release/{version}` branch in the steps below.

### 2. Build and accept the production candidate

Open **Actions → Prepare Extension Release → Run workflow** from `main`. Select `mode=candidate`, set `source_ref=release/1.0.40`, and enter the full reviewed release branch HEAD in `confirm_sha`. `publish_beta` is ignored for candidates.

After all jobs succeed, download the final `noir-wallet-v1.0.40-rc.…` artifact, check `SHA256SUMS`, and validate both V1 network ZIPs or the single V2 multichain ZIP. Use the actual ZIPs, not a local rebuild or a previous Beta. Keep the run ID, attempt, and full source SHA from the run summary for promotion. See [review responsibilities](../CONTRIBUTING.md#review-and-acceptance).

### 3. Promote the accepted artifact

After acceptance, open **Actions → Publish Accepted Extension → Run workflow** from `main`. Leave `operation=publish` selected and enter the accepted `candidate_run_id`, `candidate_run_attempt`, and `confirm_sha`. This separate action is the production publication confirmation.

The workflow verifies the candidate's origin and current release branch before creating the GitHub Release and `v1.0.40` tag. It downloads and publishes the accepted ZIPs without rebuilding. With store automation enabled, separate `sign`, `upload`, `submit`, and `notify` jobs then process the production ZIP. Keep the source branch unchanged and present until publication completes.

### 4. Check publication

Confirm **Publish Accepted Extension** succeeded. In the wallet repository's Releases page, check the source tag/commit, Latest status, the expected ZIP assets, and release notes. Download `SHA256SUMS` beside the ZIPs and run `sha256sum --check SHA256SUMS` (or `shasum -a 256 --check SHA256SUMS` on macOS). Compare those hashes with the accepted candidate. Forks and private repositories other than `NoirWallet/noir-wallet` retain build artifacts only.

### 5. Submit to Chrome Web Store

When `CWS_AUTOMATION_ENABLED=true`, the promotion signs the accepted production ZIP (`noir-wallet-v{version}.zip`, V1 mainnet or V2 multichain) into a CRX3 package without rebuilding it, uploads the CRX, submits it with `STAGED_PUBLISH`, `skipReview=false`, and `blockOnWarnings=true`, then sends the result to the configured Slack channel. The V1 testnet ZIP is excluded. The signed CRX and stage intent/result receipts are separate 30-day Actions artifacts, not GitHub Release assets. Each external write has a persisted intent first; an unconfirmed result is not blindly retried.

Check the workflow's `sign`, `upload`, `submit`, and `notify` results, ZIP and CRX checksums, and the Developer Dashboard status. A successful submission means the item is awaiting review or staged; it is not live. After approval, verify the version, permissions, and release notes in the Dashboard and publish it manually. [Chrome's deferred publication guidance](https://developer.chrome.com/docs/webstore/update#deferred_publishing_option) gives up to 30 days after approval before the staged submission returns to draft. Record the store publication time and retain the submission evidence; a matching version alone does not prove package correspondence. Historical migration tags remain subject to the [source limitations above](#historical-releases).

## Open-Source Publication

Select and review the exact `main` and `v2` commits before changing repository visibility. Confirm the intended public branches, tags, Releases, and retained Actions logs and artifacts, including material outside the default branch. Complete the wallet's licensing, sensitive-information review, clean-source builds, and applicable wallet acceptance on those commits. Repeat the wallet integration checks when the separately maintained WASM source becomes available.

Review repository collaborators and their roles, and retain only the agreed maintainers' administrative and release access. Keep the default Actions token read-only and automatic pull-request review approval disabled. Untrusted PR builds must receive no release credentials; `contents: write` belongs only in the trusted publication jobs.

Protect `main` and `v2` against direct updates, force pushes, and deletion, with pull-request review required. Select required status checks that actually run for the affected PRs; wallet build path filters intentionally exclude documentation-only changes. If the current private-repository plan does not support branch rules, arrange supported protection before publication or enable and verify it immediately after the approved visibility change. Changing visibility still requires maintainer acceptance of the selected source and access settings. Verify signed-out access to the selected source, documentation, and intended Release downloads after publication.

## Failure Recovery

- **Preview or Beta failure:** fix the selected branch and push again for PR artifacts, or dispatch a new Beta. For transient manual build failures, rerun all jobs so the artifact and publication use one matching run attempt; rerunning only Beta publication will reject artifacts from an older attempt. Keep unusable published Betas for traceability.
- **Candidate validation or build failure:** correct the release source and notes, review its new SHA, and build a new candidate. For an infrastructure retry, rerun all build jobs and accept the resulting attempt before promotion.
- **Release branch advanced or was removed:** restore the accepted branch HEAD only if it is still the intended source, or build and accept a new candidate. Promotion rejects a candidate whose branch no longer matches.
- **Candidate artifact expired:** build and accept a new candidate. Promotion never reconstructs the old package from source.
- **Publication failure:** retry promotion with the same accepted run, attempt, and SHA while its artifact remains available. A completely published Release with identical asset digests is left unchanged. If a partial or conflicting Release exists, inspect it before recovery; the workflow will not overwrite it automatically.
- **Store stage failure or uncertain result:** inspect the matching Actions intent/result receipts and Developer Dashboard before retrying with the same candidate. The workflow blocks a different candidate for the same version, conflicting review or staged states, and unconfirmed external writes. A confirmed successful notification is not sent again; if only Slack definitely failed, select **Re-run failed jobs** on the original Actions run to retry `notify` only. Missing or expired receipts require manual investigation in the Dashboard and must not be reconstructed from a new package or retried automatically. Do not move the tag or cancel review to recover an ambiguous result.
- **Incorrect published Release:** stop promoting it and release a new patch version. Do not reuse or move the old tag.

For an urgent fix, start a new `release/{patch-version}` branch from the verified stable wallet source, apply the fix and regression test, update the version and both release notes, then review, build, accept, and promote it independently of unfinished integration changes. Merge the applicable fix back to `main` and `v2` afterward. An extension already published in the browser store cannot be rolled back in place; publish a new patch version.

## Pre-Release Checks

- [ ] The release source and its diff against the stable baseline have been reviewed.
- [ ] Extension version is new and unpublished.
- [ ] Changelog has exactly one matching, nonempty version section.
- [ ] User-facing update notes match the version and visible changes.
- [ ] The manual candidate workflow succeeded for the confirmed source SHA.
- [ ] The expected production candidate ZIPs for the selected profile passed acceptance: V1 mainnet and testnet, or V2 multichain.
- [ ] The recorded run ID, attempt, and SHA identify that accepted artifact.
- [ ] The release branch is unchanged through promotion.
- [ ] The separate manual promotion succeeded.
- [ ] Production tag points to the accepted release source commit.
- [ ] Wallet source tag/commit, all expected GitHub Release ZIPs, checksums, and release notes were checked.
- [ ] Final acceptance used the production ZIP intended for Chrome Web Store.
- [ ] When enabled, the signed production package was submitted for staged review and the store status and Slack result were checked.
- [ ] After approval, the production version was published manually in the Developer Dashboard.

Final Chrome Web Store go-live, SDK npm staging approval, candidate construction confirmation, and production promotion remain manual. Website and signup Worker operations follow [Website and Signup Worker](#website-and-signup-worker). Do not add unverified secret names or third-party publication actions to the workflow.
