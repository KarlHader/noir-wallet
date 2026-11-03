# Privacy, dependencies, and release

## Privacy data flows

Enumerate actual recipients: nodes/indexers, registries, CDNs, swap/lending providers, analytics/crash collectors, explorers, name resolvers, update infrastructure, browser surfaces, and local storage/export consumers. Trace collection, transmission, retention, and deletion. Distinguish wallet behavior from providers' documented policies and unknown practices.

For each material data flow record:

| Data item | Recipient | Trigger | Default? | Retention/linkability | Existing protection | Remaining risk | Evidence |
| --------- | --------- | ------- | -------- | --------------------- | ------------------- | -------------- | -------- |

Cover keys/viewing capabilities, addresses/accounts, balances/amounts, transaction IDs, memos, scan metadata, IP/DNS, timing, device/session identifiers, diagnostics, clipboard, screenshots, notifications, backups, and explorer links where applicable. Use synthetic descriptions, not user data.

- Follow default settings, opt-in/out persistence, first launch, upgrade, retry, reconnect, fallback endpoints, and failures. If proxy/Tor/private-broadcast modes exist, determine their actual traffic coverage and bypass paths rather than inferring anonymity from their labels.
- Inspect both payload and metadata. Removing an address from analytics does not by itself prevent correlation via transaction IDs, stable identifiers, timestamps, service accounts, or shared infrastructure.
- Compare each substantive privacy claim in UI, documentation, and shipped settings with observed behavior under a stated adversary. Mark it supported within evidence, contradicted, qualified by a trust limit, or unverified. Cite the claim and implementation separately.
- State retention as unknown when backend evidence is absent. Avoid assigning implementation-vulnerability severity to inherent chain transparency without a concrete violated property or misleading behavior.

## Dependencies and advisories

- Resolve actual versions from lockfiles and build outputs, including transitive dependencies, Git refs, forks, patches, bundled JS, generated code, WASM/native binaries, and install hooks. Distinguish development/build exposure from runtime exposure.
- Check vendor advisories and authoritative vulnerability records at audit time; record query date, affected/fixed ranges, enabled features, reachable function/path, attacker control, and actual impact. An affected package version alone is a candidate, not a confirmed project exploit.
- Inspect lock consistency, integrity hashes, mutable Git/action references, registry configuration, and vendored artifact provenance. Assess whether dependency installation/build executes code before the assumed protections apply.
- If the advisory service, registry, source, or package is inaccessible, list the blocked verification and available evidence. Do not interpret an empty or failed scanner run as a clean result.

## Build, CI, and distribution

- Trace source commit → build environment/inputs → artifact → signing/publication → installed update. Record toolchain, lockfile, build flags, artifact hashes, and which links are independently verified.
- Inspect CI event triggers, fork handling, permissions, secrets, reusable workflows/actions, caches, dependency installation, artifact download/selection, and release promotion. Follow untrusted PR content to privileged execution or publication before claiming a supply-chain exploit.
- Check browser-store/update ownership, extension identity, signing and update verification, release channel selection, and rollback behavior according to the actual platform. Separate protections supplied by the browser/store from application-controlled checks; do not demand an in-app mechanism already enforced by the platform without a concrete gap.
- Verify whether the inspected artifact is the one users receive. Successful local builds and importer-recorded hashes do not establish signed-release provenance or reproducibility. Document unavailable store artifacts, credentials, external build systems, and nested repositories as specific boundaries.
- Earlier audit reports apply only to their stated revisions/components and exclusions. Verify report scope before using it as supporting evidence; never inherit a “safe” conclusion for changed code or binary packages.
