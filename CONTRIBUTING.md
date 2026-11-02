# Contributing

This repository contains the Noir Wallet extension, SDK, website, documentation, and supporting packages. Contribute SDK changes here; its [package guide](./packages/sdk/CONTRIBUTING.md) lists the focused checks. The Rust/WASM source is maintained separately; this repository tracks its built package and [lock file](./wasm-package.lock.json).

Start with the [README quick start](./README.md#quick-start). Keep changes scoped, and include a short description of the behavior changed and the checks you ran when opening a pull request. Update affected documentation at its [authoritative location](./AGENTS.md#documentation-governance).

Do not include real user or production recovery phrases, private keys, passwords, wallet exports, or sensitive transaction data in issues, pull requests, test fixtures, or logs. Use published test vectors or synthetic values in fixtures. Report a security vulnerability through the private channel in [SECURITY.md](./SECURITY.md).

## Licensing

Wallet contributions are provided under the [root license](./LICENSE), including its scheduled Apache License 2.0 grant. Contributions under `packages/sdk/` remain under the SDK's [MIT license](./packages/sdk/LICENSE). Preserve notices and licenses for third-party material.

## Development and Verification

Use the workspace's existing package manager and scripts; the [README](./README.md#quick-start) has installation, test, type-check, and build commands. Keep TypeScript strict, validate runtime data at boundaries, handle async cleanup and failures, and prefer existing utilities over new dependencies. Code comments and public API JSDoc are in English and explain why a non-obvious choice exists.

Match checks to the change. Run focused regression tests while iterating, `pnpm test` for core behavior or public contracts, extension type-check and production build for extension changes, and broader workspace checks for shared or public SDK changes. Confirm production builds contain no test harness. For documentation-only changes, check formatting, links, and consistency with implementation sources; a full build is unnecessary unless the changed guidance requires it. Report commands that actually completed and any remaining unverified behavior.

Committed core tests use `node:test` and `node:assert/strict`, with one flat `tests/` directory and `test` script per package. Add deterministic behavior tests for core rules, contracts, security boundaries, and regressions, at the lowest reliable layer; do not add source-text assertions or tests that mirror constants or UI markup. Standard tests must not need a browser, network, credentials, hardware, or real transactions. Root `pnpm test` aggregates package suites; the independent WASM repository is outside it.

For popup, storage, and MV3 lifecycle changes, verify the real isolated extension locally. Keep local browser tooling under ignored `packages/extension/tests/.local/`, extension builds in `output/extension/`, and screenshots, traces, logs, and disposable runs under ignored `output/` (use `output/browser/runs/` for disposable runs). Do not add Playwright or local UI tooling to workspace dependencies, standard tests, or CI; do not overwrite production artifacts. Browser, hardware, and transaction checks are separate from the core suite; do not imply one covers the others.

## Pull Request Targets

Target `main` for V1 maintenance and `v2` for V2 development. Use the `v2` version label only for PRs targeting `v2`; V1 PRs have no version label. Manual Beta or candidate preparation maintains this label for open PRs whose HEAD matches the selected source commit, adding it for `v2` targets and removing it for other targets. Set or adjust it manually at PR creation or retargeting when immediate triage is needed. Other labels such as `bug`, `enhancement`, and `documentation` are unaffected.

When a fix is needed in both versions, open one pull request from each target branch and link them to each other. Use English Conventional Commit titles and describe the behavior and verification relevant to that version.

## Review and Acceptance

Contributors own self-testing and regression tests for core behavior or defects. Pull requests changing extension code, tests, WASM, or related build inputs automatically run **Extension CI** with core tests, type checking, and ZIP builds in one job. No preview label is required. V1 builds separate network ZIPs; V2 produces one development ZIP. V2 previews from this repository include the configured Swap access token; fork previews receive no repository secrets and cannot use Swap. New commits cancel older runs for the same PR. Download the latest package from the PR comment or Actions; see [preview downloads and retention](./docs/release-workflow.md#pr-previews-and-beta-builds). Changes limited to Markdown documentation or SDK source run their relevant workflows. Maintainers review the change and verify affected wallet flows before merging; hardware changes require verification by someone with the device.

Release owners review the selected source and verify production candidate ZIPs before manually promoting that exact build. When enabled, Chrome Web Store automation signs the accepted production ZIP for staged review; release owners publish it manually after approval. Follow the [release runbook](./docs/release-workflow.md); CI success alone does not establish browser, hardware, or real-transaction acceptance.

Before changing release CI, inspect the affected workflows under `.github/workflows/`, `scripts/extension-release*.mjs`, and preview reporting code; the runbook is guidance, not a substitute for the current implementation.
