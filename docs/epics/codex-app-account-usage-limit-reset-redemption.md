# Epic: Redeem Codex App Account Usage Limit Reset Credits

## Status

Design validated on 2026-07-16 by independent security, UX/domain, and implementation/test reviews. Ready for specification and ticketing.

Research: [Codex Quota Reset Feasibility](../research/codex-quota-reset-feasibility.md)

Decisions:

- [ADR 0005: Bind reset redemption to the local Codex app account](../adr/0005-bound-reset-redemption-to-the-local-codex-app-account.md)
- [ADR 0006: Journal idempotent reset redemptions across crashes](../adr/0006-journal-idempotent-reset-redemptions-across-crashes.md)

## Destination

Give a loopback-local operator a safe way to inspect the current Codex App Account and redeem one provider-issued Usage Limit Reset Credit, without implying that the action targets a Proxy Account, rewriting retained Proxy Account quota evidence, or risking duplicate consumption after an ambiguous failure.

## User story

As the local operator, I want to see usage and earned resets for the Codex App Account and explicitly redeem one reset, so that I can use a provider-supported reset without switching tools or confusing it with CLIProxy routing recovery.

## Product boundary

- V1 targets the current Codex App Account only.
- V1 never targets, selects, mutates, or refreshes a Proxy Account.
- The Codex App Account panel remains visually and semantically separate from Proxy Accounts.
- Redemption is available only when both the dashboard listener and request socket are loopback-local.
- The existing operator token remains CSRF protection, not remote-user authentication.
- Remote/LAN redemption is out of scope until real authentication and transport security exist.
- Shared cross-user `CODEX_HOME` is unsupported. Redemption requires Codex state to resolve inside a private current-user-owned location; otherwise it fails closed because coordination is per OS user.
- The operator must attest that the current Codex App Account has one relevant provider workspace and is the intended target.
- Email and plan are display/account-check evidence only. They are not described as stable provider workspace identity proof.
- Direct calls to `/wham/*`, `/api/codex/*`, or other provider backend paths are forbidden. Codex app-server owns auth, endpoint selection, and response mapping.

## Non-goals

- Arbitrary provider quota reset.
- Resetting a selected Proxy Account.
- Clearing CLIProxy cooldown or quota-exceeded routing state.
- Rewriting a Retained Quota Snapshot to `0%`.
- Redeeming credits automatically or in the background.
- Quota-spending probes.
- Remote dashboard authentication.
- Long-term Codex App Account usage or redemption history.

## Capability qualification

The feature must fail closed unless the resolved Codex binary proves the required stable app-server contract.

At first feature use per dashboard process:

1. Resolve the exact Codex binary from `--codex-bin`, `CODEX_BIN`, the Node-adjacent binary, or `PATH`.
2. Read and expose `codex --version` for diagnostics.
3. Generate the stable app-server JSON schema into a private temporary directory using the same binary, with a 15-second process deadline.
4. Accept only regular non-symlink output inside that directory, with at most 4,096 entries, at most 16 MiB total, and at most 2 MiB for any inspected file.
5. Inspect the exact generated files `ClientRequest.json`, `v2/GetAccountResponse.json`, `v2/GetAccountRateLimitsResponse.json`, `v2/ConsumeAccountRateLimitResetCreditParams.json`, and `v2/ConsumeAccountRateLimitResetCreditResponse.json` for:
   - `account/read`;
   - `account/rateLimits/read`;
   - `account/rateLimitResetCredit/consume`;
   - account email and plan;
   - reset-credit count/details;
   - required `idempotencyKey` and optional `creditId`;
   - outcomes `reset`, `nothingToReset`, `noCredit`, and `alreadyRedeemed`.
6. Hash the inspected schema files and define the runtime identity as canonical binary path, version, file identity, and schema hash.
7. Delete temporary schema output in `finally`; cleanup failure disables the feature for that attempt and is retried during process shutdown.
8. Cache the verdict in memory for this dashboard process only.

The schema generator is experimental even though the three RPC methods are stable in Codex 0.144.4. Its availability is an explicit product dependency for V1 and must be proved again on the target Windows host. Schema generation is capability evidence, not authentication or runtime-health evidence. The live read flow must still validate initialization, account state, and rate-limit responses. Schema failure, size-limit failure, missing fields, method-not-found, unknown consume outcomes, cleanup failure, or binary changes disable redemption. There is no direct-backend fallback.

The client must not enable `experimentalApi` for these stable methods.

## Permanent Codex app account panel

The dashboard always renders a separate **Codex app account** panel. It must not disappear when no reset exists or when an error occurs.

Supporting copy:

> Account signed into the local Codex app. Actions here do not affect or select Proxy Accounts.

Panel states:

- `loading`;
- `signed-out`;
- `runtime-unavailable`;
- `runtime-incompatible`;
- `identity-incomplete`;
- `usage-ready-no-resets`;
- `usage-ready-resets-available`;
- `read-failed`;
- `proposal-prepared`;
- `redemption-in-flight`;
- `ambiguous-redemption`;
- `redemption-recovery-required`;
- `redemption-completed`;
- `redemption-unreconciled`;
- `availability-changed-unreconciled`.

Primary state copy:

- `signed-out`: **Sign in to Codex with ChatGPT, then refresh.**
- `runtime-unavailable`: **Codex runtime unavailable. Check the configured Codex path.**
- `runtime-incompatible`: **Installed Codex does not expose the required usage-reset methods.**
- `identity-incomplete`: **Codex did not provide an email and known plan. Redemption is unavailable.**
- `read-failed`: **Couldn’t load Codex app usage.** Action: **Try again**.
- `usage-ready-no-resets`: **No earned usage limit resets available.**
- `ambiguous-redemption`: **Redemption outcome unknown.**
- `redemption-recovery-required`: **Redemption recovery requires manual operator action. New redemptions remain blocked.**

When available, display:

- email;
- plan;
- primary and secondary usage windows with provider durations and reset times;
- observation time;
- available reset count;
- available credit titles, descriptions, and expiry times.

Provider strings must be rendered as escaped plain text. Unknown credit type/status rows are visible only as non-selectable diagnostics; only recognized available credits are selectable.

## Account check and single-workspace attestation

Redemption remains unavailable unless `account/read` returns:

- account type `chatgpt`;
- non-empty email;
- plan other than `unknown`.

Before proposal creation, the operator checks:

> I confirm this Codex app account uses one ChatGPT workspace for Codex, and this is the workspace whose earned reset I intend to use.

Warning:

> If this email can switch between Personal, Business, Enterprise, or another workspace, do not continue. This dashboard cannot verify which workspace owns the reset.

The attestation is proposal-scoped and is not persisted as a claim of technical identity proof.

## Credit selection

- Sort recognized available credit details by earliest expiry, with non-expiring credits last.
- When usable detail rows exist, the operator selects one explicit credit.
- Show provider title, description, and local expiry.
- Render selectable credits as one `<fieldset>`/`<legend>` radiogroup with programmatically associated title, description, and expiry; support arrow-key navigation.
- The earliest-expiring recognized credit may be preselected, but redemption still requires the explicit confirmation button.
- A credit with invalid expiry data is non-selectable and labelled **Unavailable**.
- Non-expiring credits say **Does not expire**.
- When `availableCount > 0` but no usable detail row exists, offer **Use a reset** and omit `creditId`; the provider selects the credit.
- Generic **Use a reset** uses the same accessible option pattern.
- Generic redemption is unavailable when `availableCount <= 0`.

## Redemption proposal

Proposal creation starts one dedicated Codex app-server process and keeps it alive through confirmation, final check, consume, and reconciliation.

A proposal contains server-side only:

- 256-bit opaque proposal identifier;
- server-generated UUID idempotency key;
- normalized checked email and plan;
- domain-separated keyed digest of the normalized account check;
- selected credit ID or generic-selection marker;
- credit display context;
- rate-limit/reset-credit observation used for confirmation;
- Codex binary identity and version;
- creation and expiry time;
- state.

Browser-visible proposal data contains no digest, idempotency key, raw auth data, or server file path.

Rules:

- One proposal may exist per OS user.
- Proposal TTL is 120 seconds before consume dispatch.
- Proposal expiry closes its app-server session and releases its prepared lease.
- The confirmation shows **Confirmation expires in 2:00** with an accessible timer that announces only useful thresholds.
- At expiry, close the dialog, terminate the session, restore focus, clear the attestation, refresh the panel, and show **Confirmation expired. Account details and reset availability were refreshed. Review them and try again.**
- Global dashboard refresh must not replace or silently invalidate an open confirmation dialog.
- App-server exit, account-change notification, changed email/plan, changed selected credit availability, or binary mismatch invalidates a prepared proposal.
- Cancel explicitly calls the prepared-proposal cancellation route; it does not wait for TTL.

## Confirmation UX

Use a native `<dialog>` or equivalent accessible modal.

Requirements:

- title: **Redeem usage limit reset?**;
- show email, plan, current usage, available count, and selected/generic reset context;
- state that OpenAI decides which eligible usage limits reset;
- Cancel is first and receives initial focus;
- Escape cancels before submission;
- focus returns to the opener;
- confirmation button says **Redeem reset**;
- `aria-labelledby` and `aria-describedby` are present;
- local progress uses `role="status"` and `aria-live="polite"`;
- errors use `role="alert"`;
- once consume is dispatched, dialog cannot close until a terminal response or the 20-second client deadline;
- duplicate activation is disabled while in flight.
- browser disconnect or local fetch cancellation never cancels the server workflow, releases the lease, or changes server state;
- after the 20-second browser wait, make the dialog closable and poll `GET /api/codex/reset-redemptions/:proposalId` every second until terminal, ambiguous, recovery-required, expired/not-found, or authorization failure.

Before confirmation, warn:

> If the dashboard or Codex process stops after redemption is sent, recovery may require restoring this same Codex app account. Account email is not retained in recovery state.

Specific confirmation copy for an expiring credit:

> This will use “{title}” for `{email}` on the {plan} plan. It expires {date}. OpenAI decides which eligible usage limits reset.

Specific confirmation copy for a non-expiring credit:

> This will use “{title}” for `{email}` on the {plan} plan. It does not expire. OpenAI decides which eligible usage limits reset.

Generic confirmation copy:

> This will use 1 of {count} earned resets for `{email}` on the {plan} plan. OpenAI will select the reset and decide which eligible usage limits reset.

## Fresh dispatch and ambiguous retry checks

For a fresh `prepared` proposal, immediately before first dispatch through the same Redemption Session:

1. Re-read `account/read`.
2. Require the same normalized email and exact plan.
3. Re-read `account/rateLimits/read`.
4. Require the selected credit to remain recognized and available, or require positive count for generic redemption.
5. Reconfirm Codex runtime identity and capability verdict.
6. Atomically persist `dispatch-intent` before writing the consume request.

For an `ambiguous` retry after transport loss or restart:

1. Open a new dedicated Redemption Session using the same qualified Codex binary identity.
2. Re-read `account/read` and require its domain-separated digest to match the retained digest.
3. Reuse the exact retained idempotency key and exact retained credit ID or generic marker.
4. Do not require the credit to remain listed or `availableCount` to remain positive; a successful hidden first redemption may already have removed it.
5. Resend the same consume request so the provider can return `alreadyRedeemed` or another terminal result.

Prepared-proposal invalidation returns without mutation using distinct public codes and messages:

- `codex_account_changed`: **Codex app account changed before redemption. Nothing was redeemed. Review the current account and try again.**
- `codex_reset_availability_changed`: **Reset availability changed before redemption. Nothing was redeemed. Refresh and review the available resets.**
- `codex_session_changed`: **Codex session changed before redemption. Nothing was redeemed. Refresh the Codex app account panel and try again.**
- `codex_proposal_expired`: **Confirmation expired. Account details and reset availability were refreshed. Review them and try again.**

Residual boundary: the supported Codex contract does not expose a stable provider workspace identifier. Same-session checks reduce but cannot eliminate same-email multi-workspace risk; V1 relies on Single-Workspace Redemption Attestation.

## Redemption crash journal, digest key, and lease

Recovery state uses one fixed per-OS-user root independent of CLIProxy `auth-dir`:

- macOS: `~/Library/Application Support/cliproxy-dashboard/codex-reset-redemption`;
- Linux: `$XDG_STATE_HOME/cliproxy-dashboard/codex-reset-redemption`, falling back to `~/.local/state/cliproxy-dashboard/codex-reset-redemption`;
- Windows: `%LOCALAPPDATA%\cliproxy-dashboard\codex-reset-redemption`.

The path has no config, environment, CLI, or API override. This conservative root ensures dashboards using different CLIProxy auth directories still share one lease for the same OS user.

Private-state requirements:

- POSIX directory mode `0700` and file mode `0600`, verified after creation;
- Windows DACL applied and verified through an argument-array `icacls.exe` adapter using the current user SID; broad principals such as Everyone, Users, or Authenticated Users are forbidden, while the current user, SYSTEM, and Administrators may remain;
- failure to apply or verify privacy disables redemption;
- regular-file, realpath, traversal, symlink, and same-root checks;
- allowlisted versioned schemas;
- same-directory atomic replace with file and parent-directory sync where supported;
- no API-selected path.

The root contains an independent 256-bit random digest secret, created atomically before the first proposal. Account-check digests use `HMAC(secret, domain || proposalId || normalizedAccountCheck)`. The secret is never reused for Proxy Account keys and never rotates while active recovery state exists. If the secret is missing or corrupt while a non-terminal journal exists, redemption enters `redemption-recovery-required`; the dashboard must not create a replacement key or offer a new redemption.

One `active-redemption.json` file serves as both Redemption Crash Journal and per-OS-user Redemption Lease. It is created with exclusive-create semantics; a second dashboard process for that OS user cannot prepare another proposal while it exists.

Allowed fields:

- schema version;
- proposal ID;
- random owner nonce, PID, and platform process-start identity;
- domain-separated account-check digest;
- idempotency key;
- optional credit ID or generic marker;
- Codex runtime identity;
- phase: `prepared`, `dispatch-intent`, `dispatched`, `ambiguous`, or `terminal`;
- creation, dispatch, and update timestamps;
- terminal outcome, reconciliation state, and stable audit event ID during terminal handling.

Forbidden fields:

- email;
- plan;
- access/refresh/ID tokens;
- credential files or paths;
- quota percentages or reset times;
- provider response bodies;
- raw errors.

Acquisition and recovery protocol:

1. Create the digest key if and only if no active journal exists.
2. Build a complete candidate journal in the private root and sync it.
3. Publish it with a same-directory atomic hard-link operation to `active-redemption.json`; linking fails when the active path already exists. Remove the candidate link after successful publication. Filesystems without verified no-overwrite hard-link semantics disable redemption.
4. Start the proposal app-server session. If startup fails, atomically remove the still-`prepared` journal.
5. Every update verifies proposal ID and owner nonce, writes a complete replacement, and atomically replaces the active journal.
6. A crashed `prepared` journal may be reclaimed only after expiry and after PID plus process-start identity prove the owner process is gone. A reclaimer re-reads the journal, then atomically renames the active journal to a unique cleanup path; only one reclaimer can rename the single source path successfully. No second recovery guard exists.
7. A startup `dispatch-intent` journal is conservatively promoted to `ambiguous`, because the process may have written consume bytes before crashing.
8. `dispatched` and `ambiguous` journals never auto-expire, auto-delete, or auto-steal.
9. Missing/corrupt journal fields, missing digest key, privacy failure, owner ambiguity, or impossible transition enters `redemption-recovery-required` and hard-blocks mutation.

Required crash cases include: active journal creation before app-server start, owner death during prepared expiry, two simultaneous reclaimers, corrupt active journal, active journal without digest key, digest key without active journal, crash before and after every atomic state transition, and PID reuse.

Startup recovery matrix:

| Observed state | Required action |
|---|---|
| Digest key exists; no active journal | Idle; allow proposal creation |
| No digest key; no active journal | Create key atomically on first proposal |
| Valid unexpired `prepared`; owner alive | Keep blocked for other processes; owner continues |
| Expired `prepared`; owner process-start identity absent | Atomically rename active journal to cleanup path; only the successful renamer closes recoverable state and deletes it |
| `dispatch-intent` after restart | Promote to `ambiguous`; retry same attempt only |
| `dispatched` or `ambiguous` | Keep lease; retry same attempt only |
| `terminal` without tombstone | Never call consume; complete pending read-only reconciliation when possible, publish tombstone, emit audit, remove active journal |
| Matching valid tombstone plus same-proposal active journal | Treat provider mutation as terminal, reconcile from retained state when needed, complete audit/cleanup without consume |
| Conflicting tombstone and active journal | `redemption-recovery-required`; no normal mutation action |
| `terminal` plus tombstone | Complete at-least-once audit/cleanup, release lease, retain tombstone |
| Tombstone only | Return cached public result until tombstone expiry |
| Active journal missing key, corrupt, privacy-unverified, or impossible | `redemption-recovery-required`; no normal mutation action |
| Stale candidate/cleanup files with no active journal | Verify they contain no active non-terminal state, then remove conservatively |

## Transport and timeout semantics

Replace the one-shot mutation path with a multi-request Codex app-server client that owns one child process and sequential JSON-RPC request IDs.

The client distinguishes:

- failure before consume bytes are written: definite non-mutation; proposal may return to prepared state;
- failure after consume bytes are written: outcome ambiguous;
- valid provider terminal outcome.

Consume client deadline: 20 seconds. Codex 0.144.4 permits 10 seconds internally; the dashboard adds process and transport margin.

The client continuously drains stdout and stderr while a proposal waits for confirmation, including notifications. It enforces bounded line and diagnostic buffers, continues independently of browser connection lifetime, uses `windowsHide` on Windows, and closes the child on prepared cancellation, expiry, invalidation, or terminal cleanup.

Before first write, persist `dispatch-intent`. After confirmed write, persist `dispatched`. An in-process write failure proven to have written no bytes may restore `prepared`; restart from `dispatch-intent` is always ambiguous.

After dispatch, timeout, early process exit, malformed terminal response, or lost transport sets `ambiguous`, retains the same idempotency key, keeps the per-OS-user lease, and blocks every new redemption for that OS user.

An Ambiguous Redemption never auto-expires. The only mutating recovery action is **Retry same redemption**, which re-checks the same account digest and credit choice, then sends the same idempotency key. Terminal replay returns the cached terminal result without another provider call.

Recovery panel copy:

> A reset request was sent, but its outcome was not confirmed. New redemptions are blocked until this same attempt is resolved.

The panel exposes only proposal ID, generic/specific mode, dispatch time, public phase, and allowed action. It never exposes account digest, idempotency key, or credit ID. The only mutating action is **Retry same redemption**; there is no dismiss, abandon, journal-delete, or new-redemption action.

Account mismatch copy:

> Current Codex app account does not match this redemption attempt. Restore the account used for the attempt, then retry. New redemptions remain blocked.

## Provider outcomes

- `reset`: completed; start reconciliation.
- `alreadyRedeemed`: completed; start reconciliation.
- `nothingToReset`: completed informationally; no reset applied.
- `noCredit`: completed without reset; reconcile account usage and reset availability.
- unknown outcome: incompatible/ambiguous; fail closed and retain recovery state when dispatch occurred.

Public messages:

- `reset`: **Usage limits reset. Checking current usage…**
- `alreadyRedeemed`: **This redemption was already completed. Checking current usage…**
- `nothingToReset`: **No eligible usage limit needs a reset right now. No reset was applied.**
- specific `noCredit`: **That reset is no longer available. Refreshing account usage…**
- generic `noCredit`: **No usage limit resets are available. Refreshing account usage…**
- ambiguous: **Couldn’t confirm whether redemption completed. Retry uses the same attempt and cannot repeat a completed redemption.**

## Reconciliation

After `reset` or `alreadyRedeemed`, use the same app-server session to call `account/rateLimits/read`.

On success:

- replace transient Codex App Account usage and credit display;
- run the terminal cleanup protocol below.

On failure:

- mark `redemption-unreconciled`;
- show **Reset completed; current usage unavailable.**;
- label prior values **Last read before redemption — no longer current**;
- never change Proxy Account snapshots;
- offer read-only Refresh;
- never automatically redeem again;
- run the terminal cleanup protocol because provider completion is already known.

After `noCredit`, run the same read-only reconciliation. On success, show **Account usage refreshed.** On failure, mark `availability-changed-unreconciled`, label prior usage as no longer current, and show **Reset availability changed; current usage could not be refreshed.** No reset-completed wording is used. Then run terminal cleanup.

After `nothingToReset`, retain the immediately preceding fresh read, show the informational result, and run terminal cleanup without another read.

Terminal cleanup protocol:

1. Immediately after a valid provider terminal response, atomically replace the active journal with `phase: terminal`, provider outcome, `reconciliation: pending` or `not-required`, and a stable audit event ID. This happens before reconciliation, tombstone publication, audit, or HTTP success response.
2. Perform required read-only reconciliation. Atomically update the terminal journal with `reconciled`, `unreconciled`, or `availability-changed-unreconciled`.
3. Write a matching non-secret Terminal Redemption Tombstone with proposal ID, public outcome, reconciliation state, stable audit event ID, and ten-minute expiry.
4. Emit the Redemption Audit Event with at-least-once semantics using that event ID. Duplicate emission after a crash is allowed and deduplicable; stdout sink durability beyond successful process write is an external host responsibility.
5. Atomically remove the active journal, releasing the lease.
6. Retain the tombstone for ten minutes so a lost HTTP response or repeated consume call returns the cached result without another provider request.
7. Delete expired tombstones conservatively. Tombstones contain no email, plan, digest, credit ID, quota data, idempotency key, or raw error.

A crash after step 1 never causes another fresh consume. Startup continues reconciliation and terminal cleanup from the terminal journal. A crash after step 3 uses the matching tombstone as proof that terminal handling started. A conflicting tombstone hard-blocks recovery.

## Persistence and audit

Codex App Account email, plan, usage, credit details, and credit counts remain transient.

The crash journal is recovery state, not history. It may temporarily retain idempotency key, account-check digest, and optional credit ID only while the attempt is non-terminal or terminal cleanup is incomplete. Terminal tombstones are non-secret and expire after ten minutes.

Emit one structured JSON audit line through the server's normal logging sink with:

- stable non-sensitive event ID;
- event name;
- timestamp;
- provider outcome or public failure class;
- Codex version;
- generic versus specific redemption;
- reconciled versus unreconciled.

Never log email, plan, quota values, proposal ID, credit ID, idempotency key, tokens, provider bodies, or raw stderr.

Audit delivery is at-least-once emission, not exactly-once durable storage. Duplicate event IDs are valid after crash recovery; downstream log handling may deduplicate them.

## HTTP contract

All routes require same-origin checks and a valid operator token. Mutation routes additionally require loopback listener and loopback caller checks.

### `GET /api/codex/account-usage`

Returns capability status, Codex version, public account check, usage, reset-credit summary, observation time, and public active-redemption state.

Public active-redemption state includes only:

- opaque proposal ID when recoverable;
- public phase;
- generic or specific mode;
- creation, expiry, and dispatch times when relevant;
- allowed action: `cancel`, `consume`, `retry-same-redemption`, `poll`, or `none`;
- terminal tombstone result while retained.

Corrupt journal, missing digest key, privacy failure, or impossible state returns `redemption-recovery-required` with no mutation action. Normal UI offers no discard or force-unlock operation. Restoring private recovery material or accepting destructive state abandonment requires a separate explicit Human-approved host recovery procedure outside this epic.

### `GET /api/codex/reset-redemptions/:proposalId`

Returns only public proposal, active-journal, or terminal-tombstone state for polling and reconnection. It performs no schema generation, Codex process spawn, provider call, account read, usage refresh, TTL extension, or state mutation.

After the browser's 20-second wait, poll once per second. Stop on terminal, `ambiguous`, `redemption-recovery-required`, expired/not-found, or authorization failure. A reconnecting browser resumes from the opaque proposal ID.

Stable failure codes:

- `codex_auth_required`;
- `codex_runtime_unavailable`;
- `codex_runtime_incompatible`;
- `codex_identity_incomplete`;
- `codex_read_failed`.

### `POST /api/codex/reset-redemptions/proposals`

Body:

```json
{
  "creditId": "optional-opaque-credit-id",
  "singleWorkspaceAttested": true
}
```

Returns public proposal context and expiry. Server generates proposal and idempotency identifiers.

### `POST /api/codex/reset-redemptions/proposals/:proposalId/consume`

Empty body. From `prepared`, performs final check and dispatch. From `ambiguous`, retries the same logical attempt with the retained key. From terminal state, returns cached terminal result without another provider request.

For `ambiguous`, the service validates account digest, retained credit/generic marker, and qualified runtime identity, but intentionally does not require current credit availability or positive reset count.

### `DELETE /api/codex/reset-redemptions/proposals/:proposalId`

Valid only in `prepared`. It closes the proposal app-server session, atomically removes the prepared journal, releases the lease, clears the attestation, and returns focus to the panel. It cannot cancel `dispatch-intent`, `dispatched`, `ambiguous`, or terminal handling.

Request bodies must be size-bounded. Client-provided email, plan, digest, account ID, idempotency key, outcome, file path, or quota values are rejected or ignored by allowlisted parsing.

## Public error handling

- Map internal failures to stable public codes and fixed messages.
- Do not return raw `err.message`, app-server stderr, backend bodies, paths, or auth details.
- Keep bounded redacted diagnostics behind explicit local debug configuration only.
- Unknown protocol fields may be ignored where forward-compatible; unknown required types, statuses, or consume outcomes fail closed.

## Module boundaries

`server/api.ts` is already near the 600-line intervention threshold. New behavior must be extracted.

Suggested modules:

- `server/codex-app-server-client.ts`: child lifecycle, initialization, JSON-RPC framing, sequential requests, notifications, failure classification, per-method timeouts.
- `server/codex-account-gateway.ts`: typed `readAccount`, `readUsage`, and `consumeResetCredit` normalization.
- `server/codex-redemption-service.ts`: proposals, clock, lease, crash journal, idempotency, state machine, reconciliation, audit.
- `server/codex-redemption-private-state.ts`: fixed per-user root, digest key, active journal-as-lease, terminal tombstones, POSIX modes, Windows DACL verification, process-start checks, and crash recovery.
- `server/codex-api.ts`: thin HTTP adapter dispatched from `handleApi`.
- `shared/codex-account-types.ts`: browser-safe contracts and stable error/state codes.
- `frontend/src/codex-account.ts`: panel, modal, accessibility, and pure state rendering.

The redemption modules must not import Proxy Account snapshot persistence, rotation controllers, or priority mutation code.

Add `--codex-bin` CLI support and document precedence with `CODEX_BIN`.

Add Playwright browser tests for native dialog focus, keyboard behavior, focus restoration, live regions, expiry, and browser-disconnect polling. Keep pure state rendering/reducer tests in Vitest.

## Test requirements

### App-server transport

- initialize and initialized lifecycle;
- multiple sequential requests through one process;
- partial and multiple JSONL messages;
- notifications interleaved with responses;
- malformed JSON and unknown messages;
- stderr redaction;
- early exit before request write;
- timeout or exit after consume write becomes ambiguous;
- consume deadline exceeds 10-second Codex timeout;
- Windows paths containing spaces and `windowsHide`;
- process cleanup on expiry and terminal completion.
- continuous notification draining during the 120-second prepared window;
- bounded stdout line and stderr diagnostic buffers;
- browser disconnect does not cancel server workflow;
- browser timeout switches to public-state polling.

### Capability and normalization

- exact binary resolution and `--codex-bin` precedence;
- default/current-user-private `CODEX_HOME` accepted; shared or privacy-unverified cross-user Codex state fails closed;
- schema generation success, cleanup, cache, and failure;
- schema entry/file/total-size caps, exact-file inspection, timeout, hash, and runtime-identity invalidation;
- missing method/field/outcome disables redemption;
- stable methods work without `experimentalApi`;
- ChatGPT account only;
- missing email and unknown plan block redemption;
- reset credits absent, `null`, empty, detailed, capped, and malformed;
- recognized credit filtering and earliest-expiry sort;
- positive count with no usable details permits generic redemption;
- exact four consume outcomes;
- unknown outcome fails closed.

### Proposal, journal, and lease

- 120-second TTL with fake clock;
- proposal ID unpredictability;
- server-only idempotency key;
- proposal tampering and client-field rejection;
- account, plan, credit, binary, and capability mismatch invalidation;
- journal atomicity, permissions, path confinement, corruption, and schema allowlist;
- independent digest-key create, permission, missing, corruption, and no-rotation behavior;
- fixed per-OS-user root remains shared across different CLIProxy auth directories;
- active journal exclusive publication and atomic replacement;
- prepared lease reclaim after owner death and expiry using PID plus process-start identity;
- simultaneous reclaimer race and PID reuse;
- `dispatch-intent` restart becomes ambiguous;
- dispatched/ambiguous lease never auto-reclaimed;
- second dashboard process cannot prepare or consume;
- same key, credit choice, and account digest on ambiguous retry;
- terminal replay never calls consume twice;
- terminal tombstone survives lost HTTP response and expires after ten minutes;
- terminal journal is persisted before reconciliation, tombstone, audit, and HTTP response;
- restart from terminal-without-tombstone completes reconciliation/cleanup without consume;
- matching tombstone plus active journal completes cleanup; conflicting tombstone hard-blocks;
- crash injection after terminal journal write, reconciliation update, tombstone write, audit write, active-journal removal, and before HTTP response;
- successful-but-lost specific and generic redemptions retry despite zero current availability;
- audit cleanup ordering;
- at-least-once audit duplicate event IDs;
- audit redaction.

### API and UI

- loopback listener and caller enforcement;
- same-origin and operator-token enforcement;
- permanent panel for every state;
- explicit separation from Proxy Accounts;
- account check display and attestation;
- detailed credit selection and generic fallback;
- modal focus trap, Cancel initial focus, Escape behavior, focus restoration;
- accessible credit radiogroup, expiry variants, and non-selectable invalid credits;
- visible/accessibly announced proposal expiry and attestation reset;
- duplicate activation blocking and `aria-busy`;
- prepared cancellation route cleanup;
- restart recovery panel and account-digest mismatch flow;
- exact outcome, ambiguity, mismatch, expiry, incompatibility, and reconciliation messages;
- distinct account-changed, availability-changed, session-changed, and proposal-expired codes/messages;
- dedicated proposal-state polling performs zero schema generations, Codex spawns, provider calls, TTL changes, or state mutations;
- one-second polling stops on every terminal/blocking/not-found/auth condition and resumes after reconnect;
- global refresh does not replace an active proposal/dialog;
- no Proxy Account snapshot mutation.

## Validation gates

Local implementation validation requires Node `>=22.13`, then:

```text
pnpm run typecheck
pnpm run test
pnpm run test:browser
pnpm run build
```

Target-host qualification on the Windows workstation or Windows MT5 laptop, whichever runs the dashboard:

1. Record resolved Codex binary path and `codex --version`.
2. Generate and archive stable app-server schema evidence.
3. Run read-only `account/read` and `account/rateLimits/read` checks.
4. Verify loopback enforcement, generated-schema caps/cleanup, journal publication/replace behavior, process-start checks, and Windows process cleanup.
5. Verify effective Windows DACL using the current-user SID; fail qualification if broad principals can read recovery state.
6. Do not perform live redemption without separate explicit Human approval and an expendable available reset credit.

## Implementation slices

1. **Transport extraction**: multi-request app-server client, typed gateway, capability proof, read-only account/usage API; preserve current read behavior.
2. **Permanent panel**: explicit account states, usage and credit rendering, no mutation.
3. **Proposal service**: fake gateway, 120-second proposals, account check, attestation, credit selection, accessible confirmation.
4. **Crash safety**: fixed per-user private root, digest key, active journal-as-lease, dispatch intent, ambiguous hard block, tombstone replay, restart recovery, redacted audit.
5. **Real consume**: same-session final check, 20-second deadline, four outcomes, same-key retry, reconciliation.
6. **Integration hardening**: public error codes, body limits, multi-process tests, Windows DACL verification, Playwright accessibility, CLI flag, README.
7. **Host qualification**: macOS read-only evidence and authoritative Windows read-only validation.
8. **Optional live proof**: one separately approved redemption with full evidence capture and no expansion to Proxy Account targeting.

## Completion criteria

- Every product, security, recovery, accessibility, and validation requirement above has automated coverage where practical.
- No touched source/test file crosses the 600-line intervention threshold without an extraction plan; `server/api.ts` receives only thin dispatch changes.
- Existing rotation and Retained Quota Snapshot behavior remains unchanged.
- Research, ADRs, glossary, tests, implementation, and target-host evidence agree on terminology and boundaries.
- Parallel post-implementation reviews find no unresolved P0/P1 issue.
- Live provider mutation remains gated by separate explicit Human approval.
