# Epic: Retain Latest Known Quota Evidence for Proxy Accounts

## User Story

As a local operator managing multiple Proxy Accounts, I want the dashboard to retain the latest known quota evidence for every Proxy Account, so that quota visibility is not lost when the page refreshes, the dashboard restarts, or traffic rotates to another account.

## Problem

The dashboard currently derives 5-hour and weekly quota from recent response logs. If a Proxy Account has not recently handled traffic, or its observed logs age out of the parser window, the dashboard reports quota as unknown even when it previously observed useful quota evidence.

Unknown should mean no Quota Snapshot has ever been captured for that Proxy Account, not that the account simply has no recent traffic.

## Decisions

- Quota visibility is scoped to Proxy Accounts.
- The dashboard stores Retained Quota Snapshots in a Dashboard State Store.
- The Dashboard State Store is server-side and dashboard-owned, not browser local storage.
- Retained Quota Snapshots are separate from Proxy Account credential files and proxy configuration.
- Retained Quota Snapshots are keyed by an opaque Proxy Account Key that remains stable when a Proxy Account is enabled or disabled.
- A page refresh, dashboard restart, or account rotation must not erase the last known quota values.
- A reset time passing must not automatically rewrite usage to 0%; it marks the snapshot as refresh-needed until newer evidence arrives.
- Session Verification remains credential/session validation and must not imply Quota Refresh.
- A Quota Probe spends quota and is not normal refresh behaviour.
- Quota Refresh requires an Identity-Bound Quota Read and must not spend model quota or redeem reset credits.
- For this retention story, revalidation timing beyond reset-time passage is deferred.

## Acceptance Criteria

- The dashboard persists the latest Quota Snapshot per Proxy Account in a small server-side JSON state file.
- The dashboard merges persisted Quota Snapshots into `/api/state` for all configured Proxy Accounts.
- Existing response-header evidence updates the matching Proxy Account's Quota Snapshot only when the traffic log identifies that same Proxy Account.
- Proxy Accounts with no snapshot are shown as unknown.
- Proxy Accounts with retained but older evidence still show their latest known values.
- Proxy Accounts whose reset time has passed still show their latest known values with a refresh-needed status.
- The API and UI expose quota status separately from retained percentages, so expired reset windows do not render as 0% used or 100% available unless newer evidence confirms that state.
- Browser refresh and dashboard restart preserve retained quota evidence.
- No access tokens, refresh tokens, ID tokens, or raw request/response bodies are written to the Dashboard State Store.

## Proxy Account Identity

- A Proxy Account Key is an opaque local key used only for snapshot matching.
- The key must be stable across `.disabled` suffix changes.
- Implementation must document one Proxy Account Key strategy before persistence.
- The intended first strategy is: match response logs to live Proxy Accounts by normalized local auth name with any `.disabled` suffix stripped, then derive the stored Proxy Account Key from that canonical local identity using dashboard-local keyed material.
- Proxy Account Keys and key-derivation metadata must be random or keyed with dashboard-local secret material.
- Proxy Account Keys must not be raw, truncated, normalized, unsalted-hashed, or token-derived emails, filenames, paths, provider account IDs, Codex App Account identifiers, or credential values.
- Proxy Account Key derivation uses a dashboard-local HMAC secret generated on first run and stored as owner-only secret local state outside Quota Snapshot entries.
- Snapshot records may persist only derived opaque Proxy Account Keys, never canonical local auth names, raw or normalized filenames, credential-derived values, or unsalted hashes.
- The derivation secret and metadata must never be exposed by `/api/state` or logs.
- The Dashboard State Store must not persist email addresses, full account filenames, file paths, full account IDs, credential contents, or Codex App Account identifiers as display data.
- `/api/state` must not expose retained snapshot keys or key-derivation metadata.
- Display labels are derived from the live Proxy Account list, not from retained snapshots.
- If a configured Proxy Account cannot be matched to a retained key, it is shown as unknown.
- If a retained snapshot no longer matches any configured Proxy Account, it is hidden from `/api/state`; deletion or garbage collection policy can be implemented conservatively but must not expose orphaned identifiers in the UI.

## Snapshot Merge Rules

- Newer identity-bound response-header evidence wins over older retained evidence for the same Proxy Account and quota window.
- Persisted snapshots fill gaps when there is no newer response-header evidence.
- Older response logs must not overwrite newer retained snapshots.
- A partial update for one quota window must preserve the last known value for the other quota window unless newer evidence for that other window is present.
- Unattributed logs, malformed logs, and Codex App Account quota reads must not update a Proxy Account snapshot.
- Reset-credit availability must remain separate from Proxy Account quota snapshots.

## Dashboard State Store

- Default path: a dashboard-owned JSON file under the configured auth directory, such as `<authDir>/cliproxy-dashboard/quota-snapshots.json`.
- The server may accept an explicit state-file override for tests or local operation, but API requests must never choose the state-file path.
- The state directory must be created with owner-only permissions where supported, and the state file must be written with owner-only permissions where supported.
- State writes must use atomic replace.
- Atomic temp writes must occur in the same directory as the state file.
- Read-merge-write updates must be serialized within the dashboard process to avoid losing newer evidence during concurrent refreshes.
- A missing or corrupt state file must not crash `/api/state`; the dashboard should report a non-secret error and continue with in-memory/log-derived evidence.
- Path resolution must prevent traversal outside the chosen dashboard-owned state location.
- The default path and trusted process-config override must resolve to a regular file inside a dashboard-owned state directory after realpath and symlink checks.
- Existing symlinks, directories, non-regular files, credential files, proxy config paths, and paths outside the chosen state root must be rejected.

## Persisted Schema

The persisted schema is allowlisted. It may contain only:

- schema version;
- local store metadata needed to derive opaque Proxy Account Keys, excluding display identifiers and credential-derived values;
- Proxy Account Key;
- per-window quota evidence for `primary5h` and `weekly`, each limited to:
  - used percent when known;
  - reset time when known;
  - observation timestamp;
  - source kind, such as `response-header` or forward-compatible `identity-bound-read`;
  - non-authoritative migration/debug status, if needed.

The persisted schema must not contain `DashboardState`, `AccountView`, `PublicAccountView`, paths, config, log summaries, raw log lines, request text, response text, tokens, credential JSON, emails, display names, or raw provider account identifiers.

`identity-bound-read` is a forward-compatible source kind only. This epic does not add any UI, API, command, or background job that performs an Identity-Bound Quota Read.

## Public Quota Status Contract

Each quota window exposed by `/api/state` should include retained values and a separate status. Status values are:

- `unknown`: no retained evidence exists for this Proxy Account and quota window.
- `current`: retained evidence is the latest known evidence and the reset time has not passed.
- `stale`: retained evidence exists but a future revalidation policy marks it as old while the reset time has not passed.
- `refresh-needed`: retained evidence exists and the reset time has passed, or a future revalidation policy requires a new observation.
- `blocked`: a refresh or read path was attempted but could not produce identity-bound evidence.

`/api/state` derives each window's public status on every read from retained evidence, current time, reset time, and revalidation policy. Persisted status, if present for migration or debugging, is non-authoritative and must be recomputed. Retained evidence with a missing, invalid, or unparsable reset time must not be exposed as `current`; expose it as `refresh-needed` while preserving retained values.

The UI renders retained `usedPercent` values with their status. It must not convert reset-passed evidence to 0% used or 100% available unless newer identity-bound evidence confirms that state.

## Safety Requirements

- The dashboard remains a loopback-only local tool.
- All dashboard API routes that return Proxy Account, quota, reset-credit, state-store, or local identifier data must be same-origin only and must not use wildcard CORS.
- Mutating, quota-affecting, reset-credit, and quota-spending routes additionally require same-origin checks and an operator/CSRF token before implementation.
- Reset-credit read, reset-credit redemption, and Codex App Account quota reads must not update Proxy Account snapshots unless identity binding is proven.
- Any mutating endpoint, reset-credit redemption, or quota-spending request requires explicit operator approval.

## Out of Scope

- Automatic quota-spending probes.
- Reset-credit redemption.
- Any Quota Refresh UI/API, including one-account manual refresh.
- Historical charts or long-term trend storage.
- SQLite or another database unless latest-snapshot JSON becomes insufficient.

## Future Discovery: Account-Scoped Quota Refresh

Quota Refresh should be explored separately as an account-scoped flow. The intended direction is to trigger refresh for one Proxy Account at a time, potentially requiring the operator to authenticate a Codex App Account session for the same identity, then proving that `account/rateLimits/read` or another read-only endpoint is identity-bound to that Proxy Account.

Before implementation, discovery must prove:

- the exact read-only command or endpoint;
- the authentication source it uses;
- how the response identity is matched to the Proxy Account;
- whether it works for all configured Proxy Accounts or only the current Codex App Account;
- failure modes for unauthenticated, mismatched, expired, or disabled Proxy Accounts.

## Test Coverage Required Before Completion

- State-file default path and state-file override.
- Persisted snapshot survives page refresh style `/api/state` reads, dashboard restart, no current logs, and log aging.
- Newer response-header evidence updates the persisted snapshot.
- Older response-header evidence does not overwrite newer retained evidence.
- Partial 5-hour or weekly updates preserve the other retained window.
- Enable/disable renames preserve the Proxy Account Key and retained snapshot.
- Deleted or missing Proxy Accounts do not expose orphaned snapshots in `/api/state`.
- Passed reset times preserve retained percentages and expose refresh-needed status.
- Missing or corrupt state file does not crash `/api/state`.
- Concurrent state reads/updates do not lose newer evidence.
- Persisted JSON contains only allowlisted fields and no token, raw body, path, email, display label, or raw account object fields.
- Persisted JSON does not contain full filenames, normalized filenames, account IDs, Codex App Account identifiers, or unsalted hashes of those values.
- `/api/state` recomputes public status from retained evidence and does not trust persisted status.
- Missing, invalid, or unparsable reset times are exposed as refresh-needed, not current.
- API-supplied state paths are ignored or rejected.
- Traversal, symlink, directory, non-regular-file, credential-file, and proxy-config-file state path cases are rejected.
- Owner-only state directory/file modes and same-directory atomic replacement are asserted where supported by the platform.
