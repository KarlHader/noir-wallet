# Noir Wallet UI Design Baseline

This reference applies to the extension popup, dApp approval window, side panel, and full-tab hardware flows. The production [theme](../../../packages/extension/src/popup/index.css) and reusable [UI components](../../../packages/extension/src/popup/components/ui/) are the source of truth. A Figma screen may guide layout and visual hierarchy, but its old dimensions, fonts, or hard-coded colors do not override the production system.

## Foundations

| Role       | Production token or value | Use                                                                    |
| ---------- | ------------------------- | ---------------------------------------------------------------------- |
| Background | `background`, `#12121c`   | Wallet pages                                                           |
| Foreground | `foreground`, `#ffffff`   | Primary text                                                           |
| Primary    | `primary`, `#00d18a`      | One filled primary action per screen, focus, selected borders, success |
| Card       | `card`, `#282832`         | Items and selections                                                   |
| Popover    | `popover`, `#202029`      | Dialogs and layered surfaces                                           |
| Muted      | `muted`, `#7e8a93`        | Secondary text                                                         |
| Border     | White at 10% opacity      | Dividers and default item borders                                      |
| Input      | White at 15% opacity      | Default input borders                                                  |
| Warning    | `#ffc201`                 | Recoverable risk requiring attention                                   |
| Danger     | `#ff4444`                 | Errors and destructive actions                                         |

Use semantic theme classes such as `bg-primary`, `text-muted`, and `bg-card`. Do not add screen-local copies of these colors. A selected item uses a subtle primary border or tint and a radio/check marker; it does not compete with the filled primary button. Selection must not depend on color alone.

Product UI uses **Jost** at weights 400-700. Addresses, hashes, and precise machine-readable values use **DM Mono**. The bundled font files and licenses live under [public/fonts](../../../packages/extension/public/fonts/). Do not add an old Figma font to reproduce a legacy mockup. Typical hierarchy is an 18px page title, 16px navigation title, 14-16px body, 13-14px field label, and 12px caption; match the component and available space.

Use a 4px spacing scale, favoring 8, 12, 16, 20, 24, and 32px. The content column has 20px horizontal padding; the 56px header has 16px horizontal padding. The footer has 20px horizontal padding, 20px bottom padding, and must remain visible. Reuse the [Button](../../../packages/extension/src/popup/components/ui/button.tsx) and [PageHeader](../../../packages/extension/src/popup/components/common/PageHeader.tsx) implementations for actual size, radius, focus, loading, and disabled behavior.

## Viewports And Layout

| Surface                | Verification viewport                                       |
| ---------------------- | ----------------------------------------------------------- |
| Popup                  | 375 x 600                                                   |
| dApp approval          | 375 x 632                                                   |
| Full-tab hardware flow | Full browser tab with a centered content column up to 440px |
| Side panel             | Available panel width and height                            |

Pages use a header, a scrollable content region with `min-h-0` where needed, and a footer that does not shrink over content. Avoid horizontal scrolling and unnecessary vertical scrolling at the target viewport. Long addresses, hashes, names, and balances must wrap or truncate without covering adjacent labels; retain a way to inspect the full value.

## Components And Content

- Use one filled primary action for the current task. Secondary actions use the existing outline, ghost, or link variants. Loading and disabled states keep control dimensions stable.
- Use [InlineError](../../../packages/extension/src/popup/components/common/InlineError.tsx) for recoverable failures: danger-colored error text and a primary-colored Retry text action on the same row. Retry has no background, border, or icon; retain keyboard focus and disable it while retrying. Do not render a separate Retry button or repeat the error beside it.
- Use existing input and password components for default, focus, error, and disabled states. Recovery-phrase input must show word position and invalid words without logging or transmitting the phrase.
- Use compact segmented selections for two or three short mutually exclusive options; use a vertical list when labels or supporting details need more room. Show the selected state directly.
- Use the existing Dialog for high-impact confirmation. Show actionable consequences for deletion, reset, permission expansion, and high-risk signing. Never display raw RPC/WASM errors, secrets, or full sensitive values as explanatory copy.
- Use [ChainIcon](../../../packages/extension/src/popup/components/common/ChainIcon.tsx) for network identity and [TokenIcon](../../../packages/extension/src/popup/components/tokens/TokenIcon.tsx) for assets. Chain icon URLs and aliases belong in the shared icon mapping; do not build a third-party favicon URL from a dApp origin.
- Native ETH uses the same token icon across wallet and Swap catalogs, including L2s. Resolve it from registered asset IDs and protocol mappings, never the symbol alone. Token icon fallbacks must use asset artwork; chain artwork belongs in the chain badge.
- General account, asset, Send/Receive, Activity, and dApp layouts should remain consistent across chains. Show only enabled chains with complete capabilities. Keep network identity alongside assets when identical symbols can refer to different chains.
- In an editable Swap pair, keep the opposite asset selectable when reversal is supported. Selecting that same asset and network reverses the pair through the existing switch action and clears its amount and quote. Fixed-asset transfer flows retain their selection limits.
- Asset details show holdings and their balance categories. Show Available within operations such as Send or Swap, scoped to the selected funding source, rather than as a generic asset-detail balance.
- Mainnet is the default and need not be repeated on routine cards. Keep explicit labels for Testnet and other non-mainnet environments, and for any choice where network changes behavior.
- Copy should help users complete the task, understand current data, or choose the next action. Put business limits into controls, field validation, confirmation, and failure feedback instead of standing rule text.
- Missing transaction amounts and unresolved dates use `—`; omit a missing recipient row while preserving known shielded-pool labels. Do not add a generic incomplete-details banner. Show reconfirmation in the shared transaction status, and show a last-update time only when a real status-update timestamp exists. Keep load failures concise with a retry action, and collapse an empty price plot without hiding current prices or recovery controls.

## Numeric Display

Use the contextual profiles in [number-format.ts](../../../packages/extension/src/lib/number-format.ts). Display strings are never arithmetic or transaction inputs. Keep base-unit values and asset decimals authoritative; Max fills the exact spendable value and must not copy a shortened balance label.

Lending protocol balances use each asset's `metadata.decimals + config.extra_decimals`; wallet token balances use base token decimals. Preserve decimal values through valuation and aggregation, and apply the display profile only when rendering.

| Surface                               | Display profile                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holdings and Activity quantities      | Preserve and group all integer digits. At or above 1,000, show at most 2 fraction digits; at or above 1, show at most 4. Below 1, keep 4 significant digits with an 8-fraction-digit cap. Truncate toward zero. |
| Transaction review and detail amounts | Show at most 8 fraction digits. Mark an omitted fraction with an ellipsis and provide tap-to-expand access to the full amount and copying of the ungrouped exact value.                                         |
| Fiat valuations                       | Show 2 fraction digits, rounded half up. Nonzero magnitudes below one cent use a minimum-value indicator.                                                                                                       |
| Token unit prices                     | At or above 1, show 2 fraction digits. Below 1, keep 4 significant digits. Only unit prices may compact long fractional zero runs with a subscript count; retain the complete price for inspection.             |
| Network fees                          | Keep 4 significant digits with at most 12 fraction digits, preserve all integer digits, and round up. Provide access to the exact fee.                                                                          |
| Percentages                           | Show at most 2 fraction digits, with a minimum-value indicator for smaller nonzero magnitudes. Retain the direction of signed changes.                                                                          |

Do not use K/M/B or scientific notation for wallet quantities. Remove insignificant fractional zeroes except in fiat valuations and unit prices at or above 1. A nonzero magnitude below a profile's precision uses `<` and the minimum shown unit; retain its direction separately from the magnitude. Unknown or invalid data displays `—`; only an observed zero displays zero.

Use a separate amount line or move the asset symbol when the full integer is too wide. Expanded exact values may wrap. Do not conceal integer digits with CSS truncation. Copy controls copy the complete ungrouped decimal value without display prefixes, ellipses, or threshold indicators. The shared [AmountDisplay](../../../packages/extension/src/popup/components/common/AmountDisplay.tsx) supports inspection of shortened review and fee values.

## Figma To Code

Inspect a target Figma screen's structure and screenshot before implementing it. Keep the original design intact and place experimental changes in a `CODEX REVIEW` section. Map designs to the production tokens, Jost/DM Mono, and the target 375px viewport; the older 344 x 588 canvas is not a production acceptance size.

Reuse components under [popup/components](../../../packages/extension/src/popup/components/) and use `cn()` for conditional classes. Compare a rendered screenshot at the target viewport, checking clipping, overlap, footer visibility, text density, and selection states. Run the relevant real extension flow when popup, storage, MV3 lifecycle, or approval behavior changes.
