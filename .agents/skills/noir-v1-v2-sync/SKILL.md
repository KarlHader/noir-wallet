---
name: noir-v1-v2-sync
description: Inventory, analyze, and safely synchronize selected V1 wallet changes into the V2 Noir Wallet extension when explicitly requested.
---

# Noir V1 to V2 Sync

Use this skill when a task asks to compare or port changes from the V1 history into the V2 extension. Keep the source commit history as evidence; do not assume a V1 commit should be copied verbatim.

## Modes

Choose one mode from the user's request:

- **Inventory:** Read-only. Run `scripts/inventory.mjs --source <ref> --target <ref>` and return the report. The first run derives the source-unit start from `git merge-base`; later runs use `reviewedSource.sha` in the version 1 `docs/v1-v2-sync/checkpoint.json`. An explicit `--base <sha>` takes precedence for source units. V2 overlap always compares target changes from the source/target merge-base to the frozen target. The CLI never writes to the repository.
- **Analysis:** Read-only. Compare each source behavior with V2 and classify it as `adopt`, `adapt`, `equivalent`, `reject`, or temporary `defer`. Split mixed commits by behavior. Use [references/decision-policy.md](references/decision-policy.md) and the report template in `assets/report-template.md`.
- **Execute:** Make only the user-requested port. Before the first mutation in the current task, confirm that the user has authorized execution of the identified changes. A broad request to inspect, inventory, analyze, or recommend is not authorization to modify code. If authorization is already explicit in the current task, proceed without asking again. Keep changes limited to the approved units and follow repository guidance.

For analysis or execution, inspect the V2 target at its frozen SHA and read only the policy sections relevant to the affected behavior. Preserve unrelated worktree changes. Never edit source history or rewrite either branch.

Before an execute run, fetch and pin full source/target SHAs once. Confirm that the source still represents V1 and the target V2; stop if branch roles changed. Work from an isolated target worktree when the current checkout contains unrelated changes. Compare first-parent units in order, keep the report tied to the pinned source SHA, and leave later source commits for a later run. Advance `docs/v1-v2-sync/checkpoint.json` only when every behavior slice has a terminal decision and its required verification has completed; any unresolved `defer` blocks advancement. Do not use merge ancestry or an `-s ours` merge as the checkpoint.

## Inventory

Run from the repository root:

```sh
node .agents/skills/noir-v1-v2-sync/scripts/inventory.mjs \
  --source <v1-ref> --target <v2-ref> --format markdown
```

Use `--format json` for machine processing. The checkpoint records `schemaVersion`, `sourceRef`, `targetRef`, `reviewedSource` (`sha` and `tag`), `targetBaselineSha`, and `reportPath`. The inventory freezes resolved source, target, source-unit base, and comparison base SHAs; lists first-parent source units, per-unit paths and diff size; and identifies exact-path overlap with target changes since merge-base. Review overlap as a routing hint, not proof of equivalent behavior. Invalid refs, a source-unit base outside the source's first-parent chain, checkpoint ancestry failures, or a malformed checkpoint are errors to resolve before analysis.

Read [references/decision-policy.md](references/decision-policy.md) for the V2 comparison and safety rules before recommending or executing a port.
