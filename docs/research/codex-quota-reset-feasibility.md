# Codex Quota Reset Feasibility

Research date: 2026-07-16
Dashboard base revision: `0158ec2e1b27` plus the current working-tree quota/rotation work
CLIProxyAPI fork revision: `75df9810620eae13f04f906c4ec7aad3355a844e`
Locally inspected Codex version: `codex-cli 0.144.4`

## Executive answer

Do not ship a generic **Reset Codex quota** action.

The first-party Codex protocol supports redeeming an **earned usage-limit reset credit** for the currently authenticated Codex App Account. It does not expose an arbitrary command that forces any account's provider-enforced quota window back to zero. The backend can return `reset`, `nothingToReset`, `noCredit`, or `alreadyRedeemed`; therefore eligibility and the affected windows remain provider-controlled.

Recommended product shape:

1. Add a read-only **Refresh Codex usage** action for the current Codex App Account.
2. Add **Redeem usage limit reset** only when the same read reports an available reset credit.
3. Show and confirm the Codex App Account identity before redemption.
4. Do not claim the action applies to a selected Proxy Account unless identity binding is proven.
5. Keep CLIProxy's local cooldown clear and dashboard snapshot maintenance as separately named operations.

Account-scoped reset-credit redemption for arbitrary Proxy Accounts is not supported by current evidence. It requires separate identity-binding discovery.

## Terminology correction

| Term | Meaning | Does it reset provider quota? |
|---|---|---:|
| Provider quota-window reset | Server-side change to an eligible Codex usage window | Only through provider-controlled reset-credit redemption found here |
| Usage-limit reset credit redemption | Consume an earned credit through `account/rateLimitResetCredit/consume` | Yes, if the backend returns `reset` |
| Quota Refresh | Read current usage through `account/rateLimits/read` | No |
| Session reauthentication | Refresh or replace OAuth credentials | No |
| CLIProxy `reset-quota` | Clear local quota/cooldown routing state and resume models | No |
| Retained Quota Snapshot clear/rewrite | Delete or alter dashboard evidence | No; it only hides or changes local history |
| Local request counters/cache | CLIProxy in-memory request statistics or cached state | No |

Use **Redeem usage limit reset**, matching Codex's own UI. Avoid **Reset quota**, which conflates provider redemption, local routing recovery, authentication, and snapshot state.

## Current dashboard and CLIProxy behavior

### Dashboard

- `GET /api/codex/rate-limits` starts the local Codex app-server and calls `account/rateLimits/read`, but returns only `availableCount`. This reads the current Codex App Account, not a selected Proxy Account: [server/api.ts:190-208](../../server/api.ts#L190-L208), [server/commands.ts:27-166](../../server/commands.ts#L27-L166).
- `POST /api/codex/consume-reset` deliberately fails closed with HTTP 403: [server/api.ts:211-217](../../server/api.ts#L211-L217).
- The frontend only displays the reset-credit count when it is positive. No redemption UI exists: [frontend/src/render.ts:301-314](../../frontend/src/render.ts#L301-L314).
- Proxy Account session verification calls `GET https://api.openai.com/v1/models`; if invalid, it may exchange the stored refresh token. This verifies or renews authentication only: [server/api.ts:420-517](../../server/api.ts#L420-L517).
- Retained quota evidence comes from identity-labeled CLIProxy response logs and `X-Codex-Primary-*` / `X-Codex-Secondary-*` response headers: [server/quota-log-updates.ts:114-206](../../server/quota-log-updates.ts#L114-L206).
- Passing a snapshot reset time marks evidence refresh-needed; it must not synthesize `0%`. Quota reads or redemptions must not update a Proxy Account snapshot without identity proof: [quota-snapshot-retention.md:13-25](../epics/quota-snapshot-retention.md#L13-L25), [quota-snapshot-retention.md:110-136](../epics/quota-snapshot-retention.md#L110-L136).

### CLIProxyAPI fork

- Management `POST /reset-quota` calls `Manager.ResetQuota`: [quota.go:26-68](https://github.com/tuanpham21/CLIProxyAPI/blob/75df9810620eae13f04f906c4ec7aad3355a844e/internal/api/handlers/management/quota.go#L26-L68).
- `Manager.ResetQuota` clears per-model local state, cooldown records, registry quota-exceeded flags, and resumes routing. It makes no provider redemption request: [conductor.go:713-791](https://github.com/tuanpham21/CLIProxyAPI/blob/75df9810620eae13f04f906c4ec7aad3355a844e/sdk/cliproxy/auth/conductor.go#L713-L791).
- CLIProxy also exposes in-memory success/failure and recent-request buckets. These are request statistics, not provider quota: [api_key_usage.go:56-116](https://github.com/tuanpham21/CLIProxyAPI/blob/75df9810620eae13f04f906c4ec7aad3355a844e/internal/api/handlers/management/api_key_usage.go#L56-L116).
- No inspected CLIProxy endpoint clears provider quota. No inspected endpoint clears general usage counters or caches as part of `reset-quota`.

## Evidence table

| Question | Primary evidence | Finding |
|---|---|---|
| Is there a provider-supported reset operation? | Codex protocol defines `ConsumeAccountRateLimitResetCreditParams` and four outcomes: [account.rs:358-390](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L358-L390) | Yes, but only redemption of an earned reset credit; not arbitrary reset |
| Can availability be read first? | `GetAccountRateLimitsResponse` includes usage buckets and reset-credit summary/details: [account.rs:294-336](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L294-L336) | Yes; use `account/rateLimits/read` before mutation |
| Who owns the operation? | App-server processor reads its active auth and requires Codex backend plus ChatGPT authentication: [rate_limit_resets.rs:45-114](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs#L45-L114) | The current Codex App Account, not automatically a dashboard Proxy Account |
| Is double-submit handled? | Request requires an idempotency key; Codex recommends one UUID per logical attempt and reuse on retry: [account.rs:358-369](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L358-L369) | Dashboard must preserve the key across retries |
| What UX does first-party Codex use? | Codex labels the action “Redeem usage limit reset,” checks availability, selects Cancel by default, confirms, and refreshes after success: [usage.rs:29-72](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/tui/src/chatwidget/usage.rs#L29-L72), [usage.rs:120-200](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/tui/src/chatwidget/usage.rs#L120-L200), [usage.rs:242-365](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/tui/src/chatwidget/usage.rs#L242-L365) | Copy these semantics instead of inventing a one-click reset |
| Should the dashboard call backend HTTP paths directly? | Official backend client varies paths between `/api/codex/...` and `/wham/...`: [rate_limit_resets.rs:21-110](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/backend-client/src/client/rate_limit_resets.rs#L21-L110) | No; call app-server RPC and let Codex own auth, paths, and mapping |
| Is app-server intended for integrations? | Official Codex App Server documentation describes deep product integrations and version-generated schemas: [Codex App Server](https://developers.openai.com/codex/app-server/) | Yes, but bind to the installed schema/version and fail closed on incompatibility |
| Is there a general arbitrary-reset API? | The inspected protocol and processor expose only reset-credit consumption with `nothingToReset` and `noCredit` outcomes | No supported arbitrary-reset API was found |

The installed `codex-cli 0.144.4` schema includes `account/rateLimitResetCredit/consume` without requiring the experimental schema-generation flag. Do not label this method experimental for that version. Still treat app-server integration as version-coupled and generate/validate schemas against the runtime used on the deployment host.

## Supported design options, ranked

### 1. Read-only current-account refresh — recommended first

Call `account/read`, then `account/rateLimits/read`. Display:

- Codex App Account email and plan when available;
- usage windows and reset times;
- available reset-credit count/details;
- freshness and errors.

Keep this data in a separate Codex App Account panel. Do not merge it into Proxy Account snapshots without a proven identity match.

### 2. Current-account reset-credit redemption — recommended second

Enable only when the read reports an available credit. Use:

- explicit **Redeem usage limit reset** wording;
- displayed Codex App Account identity;
- credit/scope description supplied by the backend;
- Cancel as the default selection;
- explicit confirmation;
- one UUID idempotency key per logical attempt, reused for retry;
- disabled duplicate submission while pending;
- exact outcome handling for `reset`, `nothingToReset`, `noCredit`, and `alreadyRedeemed`;
- a post-success `account/rateLimits/read` reconciliation.

This is provider-supported for the current Codex App Account. It is not yet a selected-Proxy-Account feature.

### 3. Account-scoped Proxy Account flow — discovery required

Only implement after proving all of the following:

- which identity app-server is authenticated as;
- how that identity maps to one Proxy Account without persisting secrets or linkable identifiers;
- how the operator switches/authenticates the intended identity;
- mismatch, expired-session, disabled-account, and concurrent-use behavior;
- whether the operation works for every configured Proxy Account or only the current Codex App Account.

Until then, fail closed rather than resetting whichever app account happens to be active.

### 4. CLIProxy local cooldown recovery — supported, separate name

If useful, expose the fork's existing action as **Clear proxy cooldown/routing block**. Explain that it only retries local routing and cannot restore provider capacity.

### 5. Snapshot maintenance — not a quota reset

Allowing an operator to discard or mark a Retained Quota Snapshot refresh-needed may be useful for diagnostics. It must not write usage to `0%`, claim capacity returned, or be placed beside provider redemption under the same label.

## Security and identity risks

- **Wrong-account mutation:** app-server uses its active Codex App Account. The dashboard's domain explicitly treats that identity as separate from a Proxy Account unless proven: [CONTEXT.md:15-55](../../CONTEXT.md#L15-L55).
- **Irreversible provider action:** a reset credit is consumed. Require same-origin, operator token, and explicit confirmation. Current API enforcement already requires same origin and an operator token for non-bootstrap API calls: [server/api.ts:125-175](../../server/api.ts#L125-L175).
- **Replay or duplicate click:** create one idempotency key per user-approved attempt and reuse it only for retrying that attempt.
- **Stale availability:** read immediately before confirmation and reconcile after outcome. Handle `noCredit` and `nothingToReset` without optimistic local changes.
- **Snapshot corruption:** never overwrite a Proxy Account snapshot from the Codex App Account response unless identity binding succeeds.
- **Credential leakage:** do not send Proxy Account credential files to browser code, log access/refresh tokens, or call private backend HTTP paths directly.
- **Version skew:** detect Codex runtime version and method/schema support. A missing or changed method must fail closed, not fall back to undocumented backend endpoints.
- **External account use:** even identity-bound evidence may become stale if the same account is used outside this CLIProxy instance.

## Open questions

1. What Codex version is installed on the Windows deployment host, and does its generated schema match `0.144.4`?
2. Can `account/read` reliably return enough non-secret identity data to confirm the operator's intended Codex App Account?
3. Is there an approved way to authenticate or switch app-server to each Proxy Account identity, or are CLIProxy credential files incompatible with that lifecycle?
4. Which eligible windows a credit resets is backend-controlled. What exact title/description/scope does the target account receive?
5. Should reset-credit availability remain transient, or be stored separately from Retained Quota Snapshots with a short freshness policy?
6. How should the dashboard behave if reset succeeds but the follow-up read fails?
7. Does the product need the separate CLIProxy cooldown-clear action, or would exposing it increase terminology confusion?

## Recommended next discovery and implementation path

1. On the actual Windows host, record `codex --version` and generate the app-server JSON schema. Verify `account/read`, `account/rateLimits/read`, and `account/rateLimitResetCredit/consume` before enabling UI.
2. Implement a read-only Codex App Account panel first. Return full normalized rate-limit and reset-credit information, not only `availableCount`.
3. Add identity display and mismatch warnings. Keep Proxy Account snapshots untouched.
4. Specify the redemption state machine and tests using the four official outcomes and idempotent retry behavior.
5. Replace the current 403 endpoint only after confirmation, operator-token, pending-state, audit-safe logging, and post-consume reconciliation tests pass.
6. Run a separate discovery story for account-scoped Proxy Account authentication/binding. Do not make current-account redemption wait on that story, but label its scope honestly.
7. Keep CLIProxy cooldown recovery and snapshot maintenance in separate APIs, UI sections, and terminology.

## Source list

### OpenAI first-party

- [Codex App Server documentation](https://developers.openai.com/codex/app-server/)
- [Codex 0.144.4 account protocol](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs)
- [Codex 0.144.4 reset-credit processor](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs)
- [Codex 0.144.4 first-party usage/reset UX](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/tui/src/chatwidget/usage.rs)
- [Codex 0.144.4 backend reset-credit client](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/backend-client/src/client/rate_limit_resets.rs)

### Project first-party

- [Dashboard API](../../server/api.ts)
- [Dashboard app-server client](../../server/commands.ts)
- [Dashboard quota-log evidence parser](../../server/quota-log-updates.ts)
- [Dashboard domain language](../../CONTEXT.md)
- [Existing quota snapshot retention epic](../epics/quota-snapshot-retention.md)
- [CLIProxyAPI fork management reset](https://github.com/tuanpham21/CLIProxyAPI/blob/75df9810620eae13f04f906c4ec7aad3355a844e/internal/api/handlers/management/quota.go)
- [CLIProxyAPI fork local reset implementation](https://github.com/tuanpham21/CLIProxyAPI/blob/75df9810620eae13f04f906c4ec7aad3355a844e/sdk/cliproxy/auth/conductor.go)
