# Required upstream CLIProxy priority mutation contract

Status: accepted for self-use from fork commit `75df9810620eae13f04f906c4ec7aad3355a844e`, pushed to `tuanpham21/CLIProxyAPI:main`. Upstream review is open as [router-for-me/CLIProxyAPI#4351](https://github.com/router-for-me/CLIProxyAPI/pull/4351). No real credential, account, or provider mutation was used for validation.

The dashboard adapter now defaults to accepted runtime version `7.2.75` and exact commit `75df9810620eae13f04f906c4ec7aad3355a844e`, uses only the dedicated conditional priority route, verifies response plus re-read revision/presence/value, and binds that result to the dashboard-owned HMAC credential fingerprint. Tests may override the pin to exercise mismatch handling.

An actual cross-contract test passed with fork commit `75df9810620eae13f04f906c4ec7aad3355a844e` built with the exact pinned headers, bound to loopback, and backed by a temporary synthetic auth directory. Outbound HTTP, HTTPS, and generic proxy traffic was forced to closed `127.0.0.1:1`; the blocked Antigravity updater attempt could not leave the machine. The dashboard adapter successfully set priority `101`, verified the new revision and synthetic identity fingerprint, restored true priority-field absence, and verified the restored revision. The process was terminated after the test.

## Accepted fork build

- Fork: `https://github.com/tuanpham21/CLIProxyAPI`
- Branch: `main`
- Commit: `75df9810620eae13f04f906c4ec7aad3355a844e`
- Runtime version header: `7.2.75`
- Upstream PR: `https://github.com/router-for-me/CLIProxyAPI/pull/4351`

## Validated baseline

- CLIProxy version: `7.2.75`
- Commit: `e57416731aec87051ac00d0812df6aebd0e9d57a`
- Repository: `github.com/router-for-me/CLIProxyAPI/v7`
- Existing authenticated route: `PATCH /v0/management/auth-files/fields`

The existing route can set a numeric priority and update the in-memory scheduler, but it cannot meet Quota-Balanced Rotation's safety contract:

- no exact delete/unset operation for an originally absent `priority` field;
- no atomic expected-revision precondition, so replacement or refresh can race mutation;
- `Manager.Update` ignores persistence errors after changing runtime state;
- refresh and management mutation do not share one per-auth mutation lock;
- management list reports numeric priority but not exact field presence;
- persistent Codex WebSocket sessions can retain the old auth for later messages.

## Proposed management API

Add a narrow authenticated route:

```http
PATCH /v0/management/auth-files/priority
Authorization: Bearer <management-key>
Content-Type: application/json
```

Set request:

```json
{
  "name": "synthetic-auth.json",
  "expected_revision": "opaque-process-local-revision",
  "operation": "set",
  "priority": 101
}
```

Unset request:

```json
{
  "name": "synthetic-auth.json",
  "expected_revision": "opaque-process-local-revision",
  "operation": "unset"
}
```

Success response, returned only after durable persistence and runtime publication both succeed:

```json
{
  "status": "ok",
  "id": "synthetic-auth.json",
  "name": "synthetic-auth.json",
  "revision": "new-opaque-process-local-revision",
  "priority": {
    "present": true,
    "value": 101
  },
  "persisted": true
}
```

Unset success returns `"present": false` and omits `value`.

Required statuses:

- `400`: malformed operation or unsafe priority;
- `401`/`403`: management authentication failure;
- `404`: auth not found or management disabled;
- `409`: `expected_revision` mismatch or auth changed during mutation;
- `422`: unsupported virtual/plugin auth or storage backend cannot preserve exact field semantics;
- `500`: persistence failed; runtime state must remain unchanged.

The existing generic fields route remains unchanged for compatibility. Quota-Balanced Rotation must use only the dedicated route.

## Revision contract

Each runtime auth gets an opaque process-local revision:

- generated from cryptographic randomness;
- never derived from filename, email, account ID, token, credential contents, or a stable cross-install identifier;
- included in authenticated `GET /v0/management/auth-files` responses;
- rotated after every successful auth mutation, token refresh, credential replacement, watcher reload, enable/disable change, or metadata change;
- regenerated on process restart.

Revision is a compare-and-swap token, not an identity claim. Dashboard binds it to its own non-linkable HMAC credential fingerprint before requesting mutation. Atomic revision validation prevents mutation of a replacement credential between dashboard validation and CLIProxy persistence.

`GET /v0/management/auth-files` must also expose:

```json
{
  "revision": "opaque-process-local-revision",
  "priority": 101,
  "priority_present": true
}
```

No credential value or linkable credential hash is added.

## Manager transaction

Add one manager-owned per-auth mutation primitive used by management updates, refresh, watcher replacement, and other auth updates.

Required sequence:

1. Acquire per-auth mutation lock.
2. Read current auth and revision.
3. Reject stale `expected_revision` before mutation.
4. Clone current auth.
5. Apply exact set or delete to clone metadata and derived attributes.
6. Persist clone; propagate storage error.
7. Re-check current revision while still holding mutation ownership.
8. Publish clone to manager and scheduler.
9. Rotate revision.
10. Emit update hook and return persisted state.

Persistence failure must leave manager, scheduler, revision, hooks, and credential file unchanged. Runtime publication failure after persistence must return error and force deterministic reload/reconciliation; it must not report success.

`Manager.Update` must stop discarding `m.persist` errors. Call sites must handle returned failures.

## Refresh coordination

Current refresh holds a refresh-only lock, performs provider refresh on a clone, then calls `Manager.Update`. Replace this with the shared per-auth mutation ownership:

- refresh holds mutation ownership from snapshot selection through persistence/publication;
- conditional priority mutation cannot interleave with refresh;
- stale refresh clone cannot overwrite new priority;
- priority mutation cannot modify a replacement credential;
- failed refresh or priority persistence cannot publish partial state.

Provider refresh behavior remains unchanged otherwise.

## Exact priority semantics

- `set`: store exact integer metadata field and synchronize scheduler attribute.
- `unset`: delete metadata key, delete scheduler attribute, and persist true field absence.
- missing priority remains CLIProxy runtime priority `0`.
- dashboard preserves field presence separately from displayed/default dashboard priority.
- reject non-integer, negative, unsafe, overflow, and ambiguous numeric values.
- do not change credentials, notes, disabled state, proxy URL, headers, WebSocket setting, or unrelated metadata.

## WebSocket routing contract

Priority mutation must not interrupt an already-started request or response stream. Existing Codex WebSocket sessions need explicit generation-aware handoff behavior:

- in-flight request stays on its selected auth;
- session records auth selection generation;
- when a later request begins and selected auth differs, old upstream connection enters drain state;
- after existing in-flight work completes, next request reconnects using newly selected auth;
- no new request is silently sent through an old-auth connection after scheduler selection changed;
- failure to prove safe handoff reports routing incompatibility instead of silently accepting the mutation.

If protocol constraints prevent request-boundary handoff, upstream must expose an authenticated, non-disruptive session-drain operation and rotation must remain disabled until dashboard can verify it.

## Watcher and verification

- Auth watcher errors or dropped events trigger bounded reconciliation.
- Dedicated priority response is authoritative only after persistence succeeds.
- Follow-up `GET /auth-files` must return new revision and exact priority presence/value.
- Scheduler must observe the same published auth revision.
- Runtime headers `X-CPA-VERSION`, `X-CPA-COMMIT`, and `X-CPA-BUILD-DATE` remain required for dashboard contract gating.

## Required upstream tests

1. Authenticated set changes only target priority.
2. Unset restores exact field absence on disk and runtime priority `0`.
3. Missing/stale revision returns `409` with zero mutation.
4. Credential replacement under same filename invalidates revision.
5. Concurrent token refresh and priority set preserve refreshed credentials and priority.
6. Concurrent token refresh and priority unset preserve refreshed credentials and field absence.
7. Persistence failure returns `500` and leaves runtime/scheduler unchanged.
8. Runtime publication failure never reports success and reconciles deterministically.
9. Future HTTP request selects unique highest-priority target.
10. Started HTTP/stream request retains selected auth.
11. Existing WebSocket in-flight work stays selected; later request safely hands off or reports incompatibility.
12. Notes, disabled state, credentials, proxy config, headers, and WebSocket metadata remain unchanged.
13. Plugin/virtual auth and unsupported storage backends fail closed.
14. Runtime response contains no credential or stable identity material.

## Dashboard follow-up

After an upstream build containing this contract is available, dashboard ticket #3 must:

- pin accepted CLIProxy version and commit;
- use the dedicated route only;
- bind returned revision to dashboard HMAC credential fingerprint;
- journal before mutation;
- verify returned and re-read revision plus exact priority presence/value;
- treat `409`, storage failure, WebSocket incompatibility, runtime-version drift, or missing revision as hard pause;
- never fall back to credential-file writes or the generic fields route.
