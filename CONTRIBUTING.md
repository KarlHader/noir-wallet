# Contributing

This repository contains the Noir Wallet extension, SDK and example, website, documentation, and supporting packages. Contribute SDK changes in `packages/sdk/` through this repository. The Rust/WASM source is maintained separately; this repository tracks built packages and their integrity files.

Start with the [README quick start](./README.md#quick-start). Keep changes scoped, describe the behavior changed in your pull request, and report the checks you ran. Apply the [documentation scope](./AGENTS.md#documentation-governance) before editing guidance; code changes alone do not require documentation changes.

Use synthetic data or published test vectors. Do not put real recovery phrases, private keys, passwords, wallet exports, or sensitive transaction data in issues, pull requests, fixtures, or logs. Report vulnerabilities through the private channel in [SECURITY.md](./SECURITY.md).

## Licensing

Wallet contributions are provided under the [root license](./LICENSE), including its scheduled Apache License 2.0 grant. Contributions under `packages/sdk/` remain under the SDK's [MIT license](./packages/sdk/LICENSE). Preserve notices and licenses for third-party material.

## Development Practice

Read the affected code, configuration, tests, and Git state before editing. Use existing modules and conventions, keep TypeScript strict, validate external input, and handle rejection, cancellation, and resource cleanup. Prefer a focused fix over a new dependency or parallel implementation. Public comments and API documentation use English.

Add maintained tests only when a core business invariant or critical public contract has a realistic failure risk affecting business correctness, authorization, funds safety, or persisted-data integrity, and existing tests do not cover it. Before adding a case, identify the rule, failure, and coverage gap. A bug fix, a file's location, or a coverage target alone does not justify a new case. Copy, styling, layout, ordinary display, and wiring need no new tests when core behavior is unchanged; approval, signing, and recipient or amount confirmation remain in scope when they affect safety.

Read the owning suites' input conditions, assertions, and fixtures first. Reuse existing coverage; extend an existing case or parameter table for a missing boundary. Create a new file only for an independent behavior boundary that cannot reasonably fit an existing suite. Do not create separate suites per fix, task, or agent. Keep shared fixtures and helpers simple, and assert behavior and outcomes rather than source text or private call order.

Choose the lowest-cost deterministic layer that exercises the failing boundary: unit tests for isolated logic, integration tests for module or persistence interactions, and real-extension checks for browser, MV3, popup, window, or dApp boundaries that lower layers cannot exercise. Before adding integration or E2E coverage, explain the additional boundary it proves; do not duplicate a unit test's full input matrix across layers.

Group wallet tests by execution environment and domain under `packages/extension/tests/`:

- `core/<domain>/**/*.test.mjs` (or `.test.ts`): offline tests using Node's test runner. These may use the existing `expect` assertion library, but require no browser, external services, hardware, or funded credentials.
- `extension/`: real isolated MV3 checks using Playwright. Keep reusable browser setup in `helpers/` and packaged integration pages beside their extension tests.
- `live/`: external-service and funded integration checks, gated by explicit opt-in flags. Keep them outside the default test command.
- `helpers/` and `fixtures/`: shared setup and immutable compatibility data; neither directory is discovered as a test suite.
- `.local/`: ignored, temporary investigations. Keep reusable coverage in its owning suite instead of accumulating per-defect scripts as maintained tests.

Share repeated setup without merging unrelated behavior into large catch-all files. Do not add tests that only mirror implementation wiring. Keep SDK and service tests in their owning packages; do not add a second runner for wallet logic or new testing dependencies.

## Verification

Run checks that match the change and report both results and omissions. Choose checks independently of whether new cases are needed; required CI, browser, security, and compatibility verification still apply. Documentation-only work needs formatting, link, and source consistency checks, not a full build. Root `pnpm test` recursively discovers wallet core behavior tests; SDK tests run separately. Use `pnpm test --list` to audit discovery, and pass Node test options such as `--test-name-pattern` for focused checks. When moving or consolidating suites, reconcile discovered files and behavior cases before and after the change. For extension behavior, run focused regressions, then core tests, extension type checking, and a default build. Verify that a distributable build excludes test harnesses. For browser, storage, service-worker, or WASM behavior, check the actual isolated MV3 extension; do not treat a mocked page as wallet acceptance.

The wallet uses one test entry point from either the repository root or extension package:

```bash
pnpm test                            # Offline core tests
pnpm test e2e release-default        # Build and run one MV3 project
pnpm test live                       # Opt-in service checks only
pnpm test live evm-testnet-live      # Explicit funded project selection
pnpm test rc                         # Existing multichain RC sequence
pnpm test screenshots                # Screenshot catalog check
```

`pnpm test --help` lists projects. Add `--dry-run` to inspect commands, or `--skip-build` to reuse a matching build for `e2e`/`live`; other options are forwarded to Node or Playwright. The runner supplies each project's network, feature flags, and build prerequisites. `development-extension` uses an already running `pnpm dev:extension`. Live projects retain their existing opt-in requirements; selecting `live` alone never selects funded flows. `production-dist` and RC production build checks use test configuration and write local distributable output that must not be published.

Keep browser test builds in `packages/extension/e2e-dist/` and screenshots, traces, and logs in ignored root `e2e-output/`, separate from release packages. Use existing opt-in flags for live-service tests and hardware checks; send real transactions only in user-authorized scenarios. Report checks blocked by missing hardware or credentials. Reusable fixtures follow the [test-wallet registry](./docs/mutil-chain/operations/test-wallet-registry.md); never print or commit funded credentials.

## Pull Request Targets

Target `main` for V1 maintenance and `v2` for V2 development. Only PRs targeting `v2` receive the `v2` version label; changing the target to `main` removes it. V1 PRs have no version label. Other labels such as `bug`, `enhancement`, and `documentation` are unaffected.

When a fix is needed in both versions, open one pull request from each target branch and link them to each other. Use English Conventional Commit titles and describe the behavior and verification relevant to that version.

Pull requests changing extension code, tests, WASM, or related build inputs run **Extension CI**. Its development ZIP is not a release candidate; see [V2 preview downloads](./docs/release-workflow.md#routine-previews) for the current process.

For SDK changes, follow the [SDK contribution checks](./packages/sdk/CONTRIBUTING.md). Root `pnpm test` covers the wallet core suite separately.

Maintainers review pull requests and verify affected wallet flows before merging. Browser, hardware, and real transaction checks require the relevant environment or device; report any checks that could not be run.
