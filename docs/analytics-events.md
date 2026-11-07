# Analytics Event Reference

> Event and page identifiers are defined in [constants.ts](../packages/extension/src/lib/analytics/constants.ts). Field filtering, transport, and preference behavior are defined in [payload.ts](../packages/extension/src/lib/analytics/payload.ts), [index.ts](../packages/extension/src/lib/analytics/index.ts), and [ga.ts](../packages/extension/src/lib/analytics/ga.ts). This is an event reference, not a substitute for the [privacy policy](../packages/docs/content/docs/privacy-policy.mdx).

## Reporting

| Property           | Behavior                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collector endpoint | `POST https://datareport.rhea.finance/v1/events/common`                                                                                                                                                                                           |
| Build scope        | Production mainnet builds, excluding local browser-verification builds; see the [build policy](../packages/extension/analytics-build-policy.ts)                                                                                                   |
| Request body       | `{ "data": "<encrypted string>" }`; plaintext is a JSON array of event objects                                                                                                                                                                    |
| Encryption         | AES-128-CBC, PKCS#7, Base64; the key and IV are the first 16 bytes of the password, matching the collector's Go `DecryptStringFast`                                                                                                               |
| Batching           | The background service worker batches for 2 seconds, up to 20 events per batch and 200 queued events. Failed uploads retry after 15 seconds; the current batch is dropped after the third failure. Collector business rejections are not retried. |
| Channels           | GA receives the same event name with filtered params and extra, device fields, and country when available; the collector receives the full payload.                                                                                               |
| User control       | **Share Google Analytics** defaults to on. Turning it off stops Google requests and country lookups and clears the GA session. Collector reporting continues and the per-install identifier remains.                                              |

## Shared Fields

| Field                                         | Meaning                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`                                  | Fixed value `noir_wallet`                                                                                                                   |
| `chain`                                       | Fixed value `zcash`                                                                                                                         |
| `wallet_address`                              | Required collector field, `anon_<install-id>`, never a real wallet address. GA uses a stable numeric ID derived from the stored install ID. |
| `page_id`                                     | `noir_<route>`; background events use `noir_background` and dApp RPC events use `noir_dapp`. See `PAGE_IDS` in `constants.ts`.              |
| `timestamp`                                   | Event time in milliseconds, assigned at the call site                                                                                       |
| `extra`                                       | JSON string with empty fields removed                                                                                                       |
| `input_amount`, `output_amount`, `usd_amount` | The collector can receive valid input and output amounts and estimated USD values; absent or invalid values become empty strings.           |

The payload excludes real wallet addresses, transaction hashes, dApp origins, raw errors, recovery phrases, private keys, passwords, UFVKs, memo contents, contact names, and signed dApp messages. The collector can receive the amount fields above, so it must not be described as excluding exact amounts. `extra` uses a bounded allowlist of metadata, including version, build channel, network mode, browser, operating system, language, and event identifier; the filter defines the exact fields.

GA client ID normalization changes GA identity for legacy UUID installations; earlier GA events cannot be joined to later ones. Stored installation IDs and collector identities remain unchanged.

## Event Catalog

`has_transaction: 1` marks a transaction-related call site, not a broadcast or confirmation. Events marked ★ retain historical GA names for report continuity. Every event also carries shared metadata; “no raw error” does not mean the request contains only an event name.

### Extension and Wallet Lifecycle

| `event_name`          | Trigger                    | Key fields                                                                         |
| --------------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `extension_installed` | First installation         | None                                                                               |
| `extension_updated`   | Extension update           | `extra.previous_version`                                                           |
| `wallet_created`      | Wallet creation            | `extra.method`: create, import, or hardware; import includes `has_birthday_height` |
| `wallet_unlocked`     | Successful password unlock | `extra.from_dapp`                                                                  |
| `wallet_locked`       | Wallet lock                | `extra.reason`: manual or auto                                                     |

### Page Views

| `event_name`           | Trigger                                                               | Key fields                                        |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `show_page`            | Each route change, including first view, unlock, and onboarding steps | `page_id`; GA uses `page_view`                    |
| `extension_engagement` | Time visible and focused                                              | `extra.engagement_time_msec`                      |
| `click`                | Explicitly marked external link                                       | `extra.link_id`, `extra.link_domain`; no full URL |

### Accounts and Addresses

| `event_name`       | Trigger                   | Key fields                                    |
| ------------------ | ------------------------- | --------------------------------------------- |
| `account_switched` | Successful account switch | `extra.cross_wallet`                          |
| `address_copied`   | Copy on Receive page      | `extra.address_type`: transparent or shielded |

### Send and Shield

| `event_name`         | Trigger                                                              | Key fields                                             |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `send_submitted`     | Confirm send, including entry into hardware flow; transaction marker | `input_symbol=ZEC`, `extra.fee_tier`, `extra.hardware` |
| `transaction_sent` ★ | Successful broadcast, including hardware signing; transaction marker | Hardware flow includes `extra.kind`                    |
| `send_failed`        | Broadcast failure                                                    | No raw error                                           |
| `shield_succeeded`   | Shielding transaction broadcast                                      | `input_symbol=ZEC`, `input_amount`                     |
| `shield_failed`      | Shielding failure                                                    | No raw error                                           |

### Swap

| `event_name`             | Trigger                                               | Key fields                                   |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------- |
| `swap_quoted`            | Quote succeeds; start of funnel                       | Input and output symbols                     |
| `swap_submitted`         | User confirms ZEC to asset swap; transaction marker   | Symbols, `extra.hardware`                    |
| `swap_initiated` ★       | ZEC deposit broadcast; transaction marker             | Symbols                                      |
| `swap_deposit_shown`     | External deposit address shown for asset to ZEC swap  | Input and output symbols                     |
| `swap_deposit_confirmed` | User selects “I have deposited” for asset to ZEC swap | Same symbols                                 |
| `swap_failed`            | ZEC deposit send fails                                | No raw error                                 |
| `swap_completed`         | Cross-chain monitor reaches terminal state            | `extra.status`: SUCCESS, FAILED, or REFUNDED |

Shared swap metadata: `extra.direction` is `zec_to_other` or `other_to_zec`.

### Hardware Wallets (Keystone / Ledger)

| `event_name`                  | Trigger                                                                 | Key fields                  |
| ----------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| `hardware_wallet_connected` ★ | QR pairing succeeds; also reports `wallet_created` with method=hardware | `extra.is_existing_wallet`  |
| `hardware_sign_failed`        | QR signing or broadcast fails                                           | `extra.kind`, `extra.phase` |

### dApp RPC

| `event_name`              | Trigger                                        | Key fields                                                            |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `dapp_connected` ★        | Connection authorized                          | `extra.account_count`                                                 |
| `dapp_disconnected`       | User or dApp disconnects                       | No origin                                                             |
| `dapp_request_rejected`   | User rejects approval request                  | `extra.method`: connect, sendTransaction, signMessage, or shieldFunds |
| `dapp_transaction_sent` ★ | dApp transaction broadcast; transaction marker | `input_symbol=ZEC`; hardware flow includes `extra.hardware`           |
| `dapp_transaction_failed` | Approved dApp transaction fails                | No origin or raw error                                                |
| `dapp_message_signed`     | Message signing approved                       | `extra.signing_mode`; no origin or message body                       |

## Verification

```bash
pnpm --filter @noir-wallet/extension exec node --import ../../scripts/register-test-loader.mjs --test tests/analytics.test.mjs
```

The core test checks encryption, field filtering, amounts, the preference, and batch retries without connecting to the live collector. There is no `ANALYTICS_E2E` switch. A live collector check requires a separately authorized isolated test; a passing core test does not establish collector availability.
