# Browser extension boundaries

Establish the actual manifest version, permissions, build-time variants, CSP, content scripts, injected provider, extension pages, background context, offscreen documents, workers, and web-accessible resources. Trace each message hop and its trust boundary.

## Requests and approvals

- Follow page → provider → content script → runtime → background → worker/device and the response path. Determine which metadata is browser-authenticated and which can be supplied by a page. Check origin, frame, tab, extension ID, document identity, method, payload schema, and request ID handling.
- Examine cross-frame and navigation behavior, sandboxed/null origins, disconnected ports, cancelled tabs, duplicate request IDs, event subscriptions, and late responses. Verify that a response or approval cannot be consumed by another document, origin, account, or session.
- Audit internal extension messages separately from dApp messages. Check external messaging, web-accessible pages/resources, URL parameters, and forged approval completion. A UI route or hidden button is not an authorization boundary.
- Check review windows for accurate origin/account/network display, immutable request binding, cancellation, window reuse, and execution-time revalidation. Avoid inferring authorization from tab titles, icons, or dApp-provided display metadata.

## Isolation, data, and lifecycle

- Inspect CSP, remote code loading, unsafe HTML/rendering, URL schemes, external links, DOM injection, and object/message parsing. Trace attacker-controlled text to an executable or privileged sink before reporting XSS or injection.
- Inspect persistent storage, session storage, IndexedDB, in-memory state, storage access levels, content-script access, caches, and exported diagnostics. Check incognito/split profiles where supported, cross-window races, and secret/metadata cleanup at lock or deletion.
- Exercise service-worker suspension/restart, offscreen/worker termination, reconnect, extension update, and multi-window operations. Check dropped requests, stale credentials, duplicate workers, pending approvals, sync jobs, and transaction recovery.
- Review clipboard, downloads, screenshots, notifications, and external explorer links as separate disclosure channels. Browser permissions alone do not establish data access or exfiltration; correlate them with actual reachable behavior.

## Verification depth

Use the target's real isolated extension for browser-owned behavior. Record browser version, extension build/configuration, artifact identity, fresh profile, synthetic fixtures, steps, and observations. Mocked Chrome APIs or a standalone web page can verify logic but cannot establish MV3 lifecycle, actual permission enforcement, storage isolation, or approval-window identity.

If browser tooling cannot load the extension, finish static/core checks and mark the relevant platform assertions blocked. Do not reuse a user's normal logged-in profile to avoid the blocker. Hardware tests and real network transactions remain separate evidence tiers.
