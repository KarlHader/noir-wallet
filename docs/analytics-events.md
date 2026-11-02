# Analytics Event Reference

Event names and page IDs are defined in [constants.ts](../packages/extension/src/lib/analytics/constants.ts). This reference does not replace the [privacy policy](../packages/docs/content/docs/privacy-policy.mdx).

## Module Boundaries

| Responsibility                                    | Owner                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI events, page context and engagement            | [UI entry](../packages/extension/src/lib/analytics/index.ts), which sends runtime messages without importing storage or network transports.                                                                                                                                                                                                    |
| Event names, allowed fields and operation mapping | Pure [policy](../packages/extension/src/lib/analytics/policy.ts), [Zcash operation mapping](../packages/extension/src/lib/analytics/operations.ts), [transaction broadcast checks](../packages/extension/src/core/transactions/transaction-analytics.ts) and [Swap event model](../packages/extension/src/popup/services/swap-event-model.ts). |
| Transaction lifecycle events                      | Existing execution handlers and transaction monitors emit events from their business results and state transitions. Analytics does not maintain a second transaction ledger.                                                                                                                                                                   |
| Metadata, privacy filtering and channel dispatch  | The background-only [reporter](../packages/extension/src/background/analytics/reporter.ts). Background initialization owns preferences and outbox recovery; Chrome alarms resume pending delivery.                                                                                                                                             |
| Collector delivery and GA transport               | [Collector client](../packages/extension/src/lib/analytics/client.ts), [outbox model](../packages/extension/src/lib/analytics/outbox.ts) and [GA adapter](../packages/extension/src/lib/analytics/ga.ts). These are composed by the reporter, never the UI entry.                                                                              |

UI event calls, background `trackEvent()` and runtime event handling return `void`. Reporting errors, storage writes and network requests never determine a wallet operation's result or delay transaction cleanup. There are no analytics-specific transaction registration commands, intent records or reporting receipts.

Zcash execution requests carry operation context rather than caller-selected success and failure event names. The execution owner maps the event after observing its outcome; hardware signing uses the same mapping. Multichain monitors use existing transaction state and broadcast evidence. Signed transactions awaiting broadcast remain pending even when they already have a hash.

## Reporting

| Property     | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build scope  | Production Mainnet builds, excluding local browser-verification builds; see [vite.config.ts](../packages/extension/vite.config.ts).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Collector    | `POST https://datareport.rhea.finance/v1/events/common` with `{ "data": "<encrypted string>" }`. The plaintext is a JSON array of event objects.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Encryption   | AES-128-CBC, PKCS#7, Base64; the key and IV use the first 16 bytes of the configured password.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Batching     | The background persists at most 200 pending events in a local outbox. It flushes after 2 seconds or at 20 events, with a Chrome alarm as the suspension fallback. Failed requests, malformed responses and collector business rejections retry after 15 seconds, up to three attempts per event. Pending events expire after seven days. A full outbox rejects new entries without evicting pending entries.                                                                                                                                        |
| Delivery     | HTTP success with JSON `code: 0` removes a batch from the collector queue. Recovery discards pending events outside the current catalog. This response is internal to the uploader. Queued keys and up to 500 process-local delivered keys suppress duplicates; no delivery receipts are persisted. Reporting is best effort: an event can be lost before enqueue, and a later observation after a worker restart can duplicate a delivered event. Collector retries reuse event IDs; ambiguous network outcomes require server-side deduplication. |
| Channels     | Google Analytics receives the event name and allowed event context, including controlled chain and page IDs. The collector receives the filtered payload. Page views use GA `page_view` and collector `show_page`. GA dispatch does not wait for collector storage or delivery; it uses a separate, bounded process-local deduplication cache. GA transport remains best effort.                                                                                                                                                                    |
| User control | **Share Google Analytics** defaults to on. Turning it off stops GA requests and clears the GA session. Collector reporting continues, as does the per-install anonymous identifier.                                                                                                                                                                                                                                                                                                                                                                 |

## Collector Fields And Privacy Boundary

| Field                                         | Meaning                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`, `chain`                         | Project `noir_wallet`; chain family `zcash`, `evm`, `bitcoin`, `solana` or `near`. Legacy or chain-neutral calls default to `zcash`.        |
| `wallet_address`                              | Collector compatibility field set to `anon_<uuid>`, a random per-install identifier shared with the GA client ID; never a wallet address.   |
| `page_id`                                     | `noir_<route>`; background events use `noir_background` and dApp RPC events use `noir_dapp`. The full list is `PAGE_IDS` in `constants.ts`. |
| `timestamp`                                   | Event time in milliseconds, assigned when the event is raised.                                                                              |
| `extra`                                       | JSON string of allowed event metadata, with empty fields omitted.                                                                           |
| `input_amount`, `output_amount`, `usd_amount` | Compatibility fields always sent as empty strings; exact amounts are discarded at the payload boundary.                                     |

The typed event API excludes exact amount and address options; `sanitizeAnalyticsEvent()` and `buildPayload()` also discard unrecognized inputs at runtime. The policy rejects wallet and recipient addresses, transaction hashes, dApp origins, raw errors, recovery phrases, private keys, passwords, UFVKs, memo contents, contact names and signed messages. `params` and `extra` use event-specific allowlists. Idempotency keys stay local and are hashed before outbox persistence; they are never included in either channel.

Page metadata uses registered page IDs and a synthetic `https://noir-wallet.extension/<page_id>` location. Query strings, fragments, unknown route paths and the real extension origin are excluded. Unknown pages map to `noir_background`.

`has_transaction: 1` supplies event context; it does not establish chain confirmation. Send-success events require broadcast evidence. Signed bytes, a prepared graph, an ERC-20 approval or a scheduled rebroadcast do not count as a successful send. Asset labels may accompany relevant events, subject to bounded format checks.

Runtime metadata adds the extension version, build channel, network mode, a random event ID, and coarse browser, operating-system, desktop category, and language labels. It excludes the raw user agent. Foreground events create or refresh a 30-minute GA session; background monitoring may reuse an active session but cannot create or extend one. Engagement measures focused, visible extension time and excludes background work. It is sent with UI events or a periodic `extension_engagement` event while the UI remains active.

## Measurement Scope

Retain an event only when it supports a defined metric or operational decision. Local diagnostic logs own routine interaction details. Clipboard copies, account switches and wallet locks are not analytics events.

| Measurement                       | Events and intended use                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Activation and version coverage   | Installation, update, wallet creation/import and unlock identify adoption and return usage.                                             |
| Feature usage                     | Page views identify visited features; focused engagement measures visible usage time.                                                   |
| Send and Shield reliability       | Submission, broadcast and failure outcomes identify conversion and execution failures.                                                  |
| Swap conversion                   | Quote, submission, origin broadcast and terminal outcome identify the stage where a flow stops.                                         |
| dApp usage and friction           | Authorized connections, signed messages, transaction outcomes and user rejection distinguish usage, cancellation and execution failure. |
| Hardware adoption and reliability | Successful account provisioning and signing failure identify adapter usage and failures.                                                |

## Event Catalog

| Event                               | Trigger and permitted context                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension_engagement`              | Focused visible UI time; bounded engagement duration, excluding background work.                                                                                |
| `extension_installed`               | First installation.                                                                                                                                             |
| `extension_updated`                 | Update; `previous_version`.                                                                                                                                     |
| `wallet_created`                    | Successful creation or mnemonic/private-key/hardware import; controlled `method`, `hardware` and optional `has_birthday_height`.                                |
| `wallet_unlocked`                   | Successful password unlock; `from_dapp`.                                                                                                                        |
| `show_page`                         | Route view; `page_id`. GA receives `page_view`.                                                                                                                 |
| `send_submitted`                    | Send confirmation, including transfer/private-transfer and entry to hardware signing; chain, asset label, `fee_tier`, `funding_source`, `kind` and `hardware`.  |
| `transaction_sent`                  | Successful send broadcast, including hardware flow; optional `hardware`, `funding_source` and `kind`.                                                           |
| `send_failed`                       | Send failure; bounded `funding_source`, `kind` or `phase`, never the raw error.                                                                                 |
| `shield_succeeded`, `shield_failed` | Shield broadcast or failure.                                                                                                                                    |
| `swap_quoted`                       | Quote received; asset labels and `direction`.                                                                                                                   |
| `swap_submitted`                    | Swap confirmed; asset labels, `direction` and `hardware`.                                                                                                       |
| `swap_initiated`                    | Swap origin broadcast, including multichain flows; asset labels, `direction` and controlled `sourceFamily`.                                                     |
| `swap_failed`                       | Deposit send failure; `direction`, never the raw error.                                                                                                         |
| `swap_completed`                    | Terminal cross-chain status; `status` and `action`.                                                                                                             |
| `hardware_wallet_connected`         | Successful Ledger or Keystone account provisioning; `hardware` and `is_existing_wallet`. A newly created wallet also reports `wallet_created`.                  |
| `hardware_sign_failed`              | Hardware signing or broadcast failure; `kind` and `phase`.                                                                                                      |
| `dapp_connected`                    | Connection authorized; `account_count` and `source`, never the origin.                                                                                          |
| `dapp_disconnected`                 | Connection removed; no origin.                                                                                                                                  |
| `dapp_request_rejected`             | User rejects a request; allowed `method` category.                                                                                                              |
| `dapp_transaction_sent`             | dApp transaction broadcast or completed private route; chain, asset label, `funding_source` and `hardware`. Signature-only operations do not report this event. |
| `dapp_transaction_failed`           | Approved dApp transaction fails; bounded context, no origin or raw error.                                                                                       |
| `dapp_message_signed`               | Message signing approved; `signing_mode`, no origin or message body.                                                                                            |

`transaction_sent`, `swap_initiated`, `hardware_wallet_connected`, `dapp_connected` and `dapp_transaction_sent` retain established GA names for report continuity. Swap `direction` preserves `zec_to_other` and `other_to_zec`; other routes use `same_chain` or `cross_chain`. Same-asset public/private transfers use the Send event family rather than the Swap funnel. Events follow current business execution and monitor observations; old history is not backfilled. A dApp private transfer can contribute to both its dApp event family and the Send lifecycle family, which are distinct metrics.

## Verification

Core tests cover catalog filtering, canonical metadata, bounded delivery, operation mapping and dApp outcomes. Reporting tests exercise the UI/runtime boundary, independent channel dispatch and non-blocking failure behavior. Transaction tests cover broadcast evidence and exclude signed-only transactions, user cancellation and approval-only stages from send success.

The local [analytics tests](../packages/extension/tests/core/platform/analytics.test.mjs) cover encryption compatibility, field filtering, payload construction, preferences, batching, and retries without contacting the collector:

```bash
pnpm test
```

`ANALYTICS_E2E=1` enables the separate `pnpm test live` collector check when `CUSTOM_ANALYTICS_PASSWORD` is supplied. It sends a test event to the live service; a passing local test alone does not establish collector availability.
