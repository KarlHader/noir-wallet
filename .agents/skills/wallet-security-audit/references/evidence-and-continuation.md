# Evidence, continuation, and completion

## Local artifact contract

Use an existing ignored output area (for Noir, verify `output/` is ignored). A practical run directory is `output/audits/<date>-<target>-<short-sha>/`. Check for existing runs before creating one; use a safe path component rather than raw user/ref text. Keep evidence private to the local workspace unless disclosure is explicitly authorized.

Keep only artifacts needed to reproduce conclusions or continue the audit:

- `state.json`: target and audit-method identity, selected mode/scope, artifact/build identities, coverage ledger, reviewed paths and boundaries, finding/candidate IDs, completed checks, blockers, and next work.
- `report.md`: the six deliverables below, maintained as the human-readable assessment.
- `evidence/`: bounded redacted command output, minimal probes, synthetic fixtures, screenshots/traces when necessary, and reproduction instructions referenced by the report. Avoid retaining irrelevant raw dumps.

These are audit deliverables, not product documentation. Do not add a second plan, progress report, or duplicate finding database. If the user requests chat-only output, respect that choice and disclose the resulting continuation limitation. Use temporary storage when the project lacks an appropriate ignored location; report its lifetime limitation.

State can use a compact schema adapted to the run. Record at least:

```text
target: repository, requested_ref, resolved_sha, remote_verification,
        PR/base/merge_base if applicable, selected build/artifact hashes
method: skill source/revision or content hash, scope and exclusions
coverage[]: path_or_boundary, invariant, status, depth, evidence, gap
findings/candidates: stable IDs and report/evidence locations
checks[]: command, cwd, tool version when material, outcome/exit code, evidence
blockers[]: missing condition, affected assertion, safe next action
next_work: pending investigations and incomplete validation
```

Update state at meaningful boundaries and before handoff/context loss. On resumption, verify target, build inputs/artifacts, and evidence still match. For a changed target, retain old evidence with its original SHA, assess affected dependencies/callers, and revalidate impacted conclusions. Do not automatically rerun unrelated checks or carry forward stale verdicts.

## Finding contract

Each finding needs:

1. Stable ID/title; category; severity with rationale; separate confidence and verification status.
2. Affected revision/build, repository-relative files with precise one-based lines at that revision, and the relevant call chain. Include immutable source links where available; lines from another checkout are not equivalent evidence.
3. Attacker capabilities, preconditions, default/nondefault configuration, entrypoint, guards examined, and concrete impact.
4. Root cause and the violated security/privacy property. For PRs, label introduced, pre-existing, or undetermined, with base-version evidence where available.
5. Minimal safe reproduction or static proof: synthetic inputs, steps, expected versus observed outcome, commands actually run, and evidence references. Explain missing conditions for any unexecuted reproduction.
6. Remediation, compatibility/migration implications, and a focused regression verification method. Recommendations do not authorize implementation.

Use independent dimensions:

- **Category:** implementation vulnerability; architectural trust limitation; privacy design risk; hardening recommendation.
- **Verification:** dynamically reproduced; statically confirmed through a reachable path; pending verification. Keep pending candidates outside confirmed-findings counts.
- **Confidence:** high/medium/low with the material uncertainty. Static evidence can have high confidence; a dynamic test with unrealistic attacker privileges may have low confidence.
- **Severity:** critical/high/medium/low/informational based on impact, feasible attacker capability, reachability, defaults, and protections. Explain the rating; do not inflate it because the code handles funds. An unresolved candidate's estimated severity is provisional. If using CVSS, provide the version/vector and distinguish its score from wallet-specific impact.

Deduplicate common root causes without hiding distinct prerequisites or consequences. Record counterevidence and rejected candidates briefly when it prevents repeating the investigation. Never expose sensitive data to make evidence look more concrete.

## Coverage ledger

| Module/path or trust boundary | Property/attack hypothesis | Method | Depth | Status | Evidence | Gap or reason |
| ----------------------------- | -------------------------- | ------ | ----- | ------ | -------- | ------------- |

During work, status is planned, in progress, checked, not applicable, or blocked. “Checked” must state depth: inventory only, call-chain review, core runtime test, real isolated extension, hardware, or artifact verification, as appropriate. Reading a file or matching a string does not establish its entire behavior. Not applicable requires absence/unreachability evidence; a missing tool, source, device, credential, or network is a blocker, not absence of the feature.

Map every user-requested category into this ledger. Keep core logic, browser lifecycle, hardware, external services, and cryptographic internals as distinguishable coverage levels. A coarse row such as “security checked” cannot support completion.

## Final delivery and release judgment

Deliver:

1. Risk-ranked confirmed findings and remediation priorities, with unresolved candidates separate.
2. Full finding details and verifiable evidence.
3. Privacy data-flow table and assessment of product promises.
4. Coverage matrix with depth, results, and blind spots.
5. Executed checks and outcomes, including failures, blocked work, and checks not run. Distinguish pre-existing failures and infrastructure failures from audit findings.
6. Use/release advice tied to the exact target, build, threat model, findings, and unresolved critical paths. Report “insufficient evidence” when appropriate; do not force a pass/fail verdict.

Before claiming completion, reconcile scope with coverage, resolve or explicitly block material candidates, verify evidence links/line numbers, redact outputs, and confirm target/artifact identity. Planned/in-progress items mean the audit is still partial. Blocked scope remains an explicit limitation even if all currently executable work is finished; critical unverified paths prevent an unqualified release recommendation. Report completion as completed within stated scope, partial, or blocked, with reasons. Do not equate absence of identified findings with absence of vulnerabilities.
