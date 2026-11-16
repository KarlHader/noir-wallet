# V1 to V2 Sync Report

## Frozen inventory

- Source: `<full SHA>` (`<ref>`)
- Target: `<full SHA>` (`<ref>`)
- Source unit base: `<full SHA>` (`merge-base | checkpoint | explicit`)
- V2 overlap base: `<full SHA>` (`merge-base`)
- First-parent source units: `<count>`

## Decisions

| Source unit         | Changed paths / behavior | V2 evidence                    | Decision                                      | Verification or follow-up |
| ------------------- | ------------------------ | ------------------------------ | --------------------------------------------- | ------------------------- |
| `<sha>` `<subject>` | `<concise summary>`      | `<V2 file, behavior, or test>` | `adopt / adapt / equivalent / reject / defer` | `<focused evidence>`      |

## Scope and outcome

- Approved units: `<units>`
- Files changed: `<paths or none>`
- Verification: `<commands and results>`
- Deferred items: `<reason or none>`
