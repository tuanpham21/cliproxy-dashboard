# Codex Multi-Profile Reset-Credit Checking

Research date: 2026-07-17
Locally verified runtime: `codex-cli 0.144.4` (`rust-v0.144.4`, commit `8c68d4c87dc54d38861f5114e920c3de2efa5876`)
Scope: read-only checking only; no automatic Usage Limit Reset Redemption

## Executive answer

Multi-profile checking is feasible with one independent `CODEX_HOME` root per Codex App Account.

Each root can hold isolated config, auth, logs, sessions, and SQLite-backed state. `codex login`, `codex login status`, `codex logout`, and `codex app-server` all resolve that root from `CODEX_HOME`. Codex 0.144.4 also namespaces macOS/OS-keyring credentials by a hash of the canonical `CODEX_HOME` path, so keyring-backed profiles do not collide. Forcing plaintext `auth.json` storage is unnecessary and less desirable.

Current supported app-server RPC cannot query an arbitrary account from one active auth session. `account/read` and `account/rateLimits/read` have no account, profile, session, or workspace selector. Therefore V1 should:

1. Create one private, immutable `CODEX_HOME` per dashboard profile.
2. Require one explicit `codex login` browser flow when adding each profile.
3. Run short-lived app-server processes sequentially, each with that profile's `CODEX_HOME`.
4. Call only `account/read` and `account/rateLimits/read`.
5. Keep reset-credit consumption absent from the multi-profile checker interface.

Login is not required for every refresh. Managed ChatGPT auth refreshes tokens during use; browser login is needed again only when auth expires, is revoked, or the operator changes the identity.

## Primary evidence

### `CODEX_HOME` is the isolation boundary

Official docs define `CODEX_HOME` as the root for config, auth, logs, sessions, skills, packages, and other local state. The path must already exist when explicitly set. `CODEX_SQLITE_HOME` can move SQLite state elsewhere and `sqlite_home` config takes precedence, so profile launch code must pin or sanitize both values: [Environment variables](https://developers.openai.com/codex/config-reference/#environment-variables), [Config and state locations](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

Tagged source resolves `CODEX_HOME`, requires an existing directory, canonicalizes it, and otherwise defaults to `~/.codex`: [home-dir/src/lib.rs:5-60](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/utils/home-dir/src/lib.rs#L5-L60).

CLI login loads normal config, then passes `config.codex_home` and the resolved credential-store mode into the login implementation: [cli/src/login.rs:167-185](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/cli/src/login.rs#L167-L185). Status and logout use the same resolved root: [cli/src/login.rs:424-503](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/cli/src/login.rs#L424-L503).

App-server independently resolves `CODEX_HOME`, loads config from it, creates an `AuthManager` from that resolved config, and initializes SQLite state: [app-server/src/lib.rs:469-507](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server/src/lib.rs#L469-L507), [app-server/src/lib.rs:519-575](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server/src/lib.rs#L519-L575).

### Keyring credentials are isolated by `CODEX_HOME`

Direct keyring storage computes its account key by SHA-256 hashing the canonical `CODEX_HOME` path, then uses that key for load, save, and delete: [login/src/auth/storage.rs:226-245](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/storage.rs#L226-L245), [login/src/auth/storage.rs:291-317](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/storage.rs#L291-L317).

The encrypted-secrets keyring backend also hashes canonical `CODEX_HOME` into a distinct keyring account: [secrets/src/lib.rs:182-195](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/secrets/src/lib.rs#L182-L195). `auto` prefers keyring and falls back to the root-local file only on absence/error: [login/src/auth/storage.rs:404-452](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/storage.rs#L404-L452).

Conclusion: separate canonical roots isolate both keyring and file credentials. Root paths must be immutable; renaming/moving a root changes its keyring lookup key.

If file storage is used, Codex writes `$CODEX_HOME/auth.json` with Unix creation mode `0600`: [login/src/auth/storage.rs:150-152](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/storage.rs#L150-L152), [login/src/auth/storage.rs:202-218](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/storage.rs#L202-L218). Existing-file mode is not repaired by that creation flag, so dashboard qualification should metadata-check ownership and mode without reading token contents.

### `--profile` is not an auth profile

Official config profiles only overlay `$CODEX_HOME/<name>.config.toml` on the base user config. They change model/policy/settings, not auth storage or account selection: [Profiles](https://developers.openai.com/codex/config-advanced/#profiles).

Therefore one `CODEX_HOME` plus several `--profile` values still shares one auth identity. Do not use `--profile` for multi-account design.

### Current RPC is current-auth only

The registered 0.144.4 account methods include login, cancel-login, logout, rate-limit read, reset-credit consume, usage read, workspace messages, and account read. None accepts an account/session selector: [app-server-protocol/src/protocol/common.rs:1001-1047](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/common.rs#L1001-L1047).

`account/read` accepts only `refreshToken`; response contains optional account plus `requiresOpenaiAuth`: [app-server-protocol/src/protocol/v2/account.rs:476-495](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L476-L495).

Its implementation builds the configured model provider and reads that provider's account state. This explains why the dashboard must keep its existing `model_provider="openai"` CLI override: [app-server/src/request_processors/account_processor.rs:897-918](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server/src/request_processors/account_processor.rs#L897-L918).

`account/rateLimits/read` loads the current `AuthManager` auth, requires ChatGPT backend auth, then reads rate limits and reset-credit details. It has no target-account parameter: [app-server/src/request_processors/account_processor.rs:921-988](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server/src/request_processors/account_processor.rs#L921-L988).

Generated stable schema from installed 0.144.4 confirmed this exact surface:

```text
codex app-server generate-json-schema --out <temporary-directory>
```

`ClientRequest.json` contained `account/read`, `account/rateLimits/read`, and `account/rateLimitResetCredit/consume`, but no `account/sessions/*` method. `GetAccountParams.json` contained only `refreshToken`. Generated schemas are runtime-version-specific per official docs: [App-server message schema](https://developers.openai.com/codex/app-server/#message-schema).

Source contains unused account-session data structs, but they are not registered RPC methods and are absent from generated schema. They are not a usable API: [app-server-protocol/src/protocol/v2/account.rs:176-246](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L176-L246).

### Login/logout capabilities and limits

Supported CLI operations in installed 0.144.4:

- `codex login`: browser ChatGPT OAuth.
- `codex login --device-auth`: device-code flow when supported.
- `codex login --with-api-key`: API-key auth; not suitable for ChatGPT reset credits.
- `codex login --with-access-token`: trusted/enterprise automation; not a general personal-account profile mechanism.
- `codex login status`: reports auth method, not safe stable account identity.
- `codex logout`: revokes when possible and removes credentials for that `CODEX_HOME`.

Official auth docs state login details are cached, reused, and refreshed automatically before expiry; file-backed auth contains access tokens and must be treated like a password: [Login caching and credential storage](https://developers.openai.com/codex/auth/#login-caching).

Starting `codex login` clears existing auth in the selected root before beginning the new login: [cli/src/login.rs:119-165](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/cli/src/login.rs#L119-L165). Wrong browser-session selection therefore replaces only that profile's credential, not other roots.

App-server also exposes login/logout RPC, but external `chatgptAuthTokens` login is explicitly unstable/internal and makes the client manage token refresh and workspace identifiers: [app-server-protocol/src/protocol/v2/account.rs:64-107](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L64-L107), [app-server-protocol/src/protocol/v2/account.rs:253-284](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L253-L284). Do not use it.

## Recommended architecture

### 1. Managed profile roots

Use one fixed owner-private manager directory, then one opaque child directory per profile:

```text
<private-dashboard-root>/codex-profiles/<random-profile-key>/
```

- Manager and profile directories: owner-only (`0700` on Unix; verified private DACL on Windows).
- Reject symlinks, path escapes, duplicate canonical roots, non-owner roots, and mutable arbitrary external paths in V1.
- Derive path from random local profile key; do not expose path to browser/API.
- Persist only local key, operator label, enabled flag, and ordering in private server-owned metadata.
- Do not persist email, account/workspace ID, auth claims, token values, reset-credit IDs, or raw RPC payloads.
- Prefer `cli_auth_credentials_store = "keyring"` on Mac. `auto` is acceptable only if fallback `auth.json` mode/owner checks pass.

### 2. Explicit one-time onboarding

For each new profile:

1. Create/verify private root.
2. Run `CODEX_HOME=<profile-root> codex login` only after explicit operator action.
3. Run `CODEX_HOME=<profile-root> codex login status`.
4. Perform one read-only account/rate-limit check.
5. Show returned email/plan transiently and ask operator to confirm/rename local label.

Email and plan are recognition hints, not stable workspace proof. Never deduplicate profiles by email; one user may have multiple ChatGPT workspaces.

### 3. Sequential refresh-all worker

Use bounded concurrency `1` initially:

1. Acquire per-profile in-process lock.
2. Re-verify root privacy and immutable runtime identity.
3. Spawn app-server with sanitized environment:
   - `CODEX_HOME=<profile-root>`;
   - `CODEX_SQLITE_HOME=<profile-root>` or remove inherited override;
   - existing `-c model_provider="openai"`;
   - stdio transport only.
4. Initialize app-server.
5. Call `account/read` with `refreshToken: false`.
6. If ChatGPT account present, call `account/rateLimits/read`.
7. Normalize only account display, usage windows, reset-credit count/details, observed time, and error class.
8. Close process before advancing.

One profile failure must not abort remaining profiles. Use per-profile timeout, process kill/cleanup, and status such as signed-out, identity-incomplete, read-failed, or ready.

### 4. Enforce read-only by construction

Create a dedicated `CodexMultiProfileReadGateway` exposing only:

```text
readAccount()
readRateLimits()
close()
```

Do not expose/import `consumeResetCredit`, proposal creation, redemption journals, or redemption routes. UI offers `Refresh profile` and `Refresh all`, never a reset action in multi-profile view.

Existing redemption remains a separate manual workflow with explicit account check, attestation, proposal, confirmation, and consume. Seeing an available reset in the multi-profile list must never trigger or prepare redemption.

## Concurrency and failure analysis

| Risk | Consequence | Required control |
|---|---|---|
| Same root used by two dashboard reads | Duplicate refresh/network work; possible credential-write race | Per-profile lock; concurrency one |
| Same root used by another Codex client | Cross-process token refresh race; cached auth divergence | Dedicated dashboard roots; document no general CLI/app use except login/status/logout |
| Root renamed/moved | Keyring entry appears missing | Immutable derived paths |
| Inherited `CODEX_SQLITE_HOME` or `sqlite_home` | Profiles share state outside auth roots | Sanitize env; minimal managed config; verify effective state root |
| `auto` keyring fallback | Plaintext token file exists | Verify root `0700`, auth file owner/mode `0600`, no symlink; otherwise block |
| Browser reuses wrong ChatGPT session | Wrong identity stored in one profile | Post-login account check plus operator confirmation |
| Same email in multiple workspaces | False identity merge; wrong redemption target | Never dedupe by email; show workspace-unverified warning |
| Notification arrives after/for another read | Cross-profile UI attribution | One process/session per profile; tag by local profile key; explicit RPC result is authority |
| Token expires | Profile read fails or refreshes auth state | Let managed auth refresh; classify permanent auth failure as re-login-required |
| Read response contains reset credits | Accidental mutation path | No consume method in checker; no automatic proposal/redemption |

`AuthManager` caches auth per process, uses an in-memory semaphore for refresh, guarded-reloads storage, and persists refreshed tokens. That protects concurrent refreshes inside one process, not across unrelated processes: [login/src/auth/manager.rs:1759-1781](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/manager.rs#L1759-L1781), [login/src/auth/manager.rs:2362-2400](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/manager.rs#L2362-L2400), [login/src/auth/manager.rs:2593-2611](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/login/src/auth/manager.rs#L2593-L2611).

Account notifications do not solve profile selection. `account/updated` contains auth mode and plan only; `account/rateLimits/updated` is a sparse rolling update that clients must merge/refetch: [app-server-protocol/src/protocol/v2/account.rs:497-515](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L497-L515).

## Rejected alternatives

| Alternative | Rejection |
|---|---|
| One root plus `--profile` | Config-only; auth still shared |
| Repeated logout/login in one root | Interactive, destructive to active credential, wrong-account risk |
| Copy/swap `auth.json` files | Handles live secrets directly; races token refresh; unsafe rollback |
| External `chatgptAuthTokens` RPC | Unstable/internal, raw-token exposure, client-managed refresh/workspace ID |
| Multiple accounts through current account-session structs | No registered method; absent from generated 0.144.4 schema |
| CLIProxy Proxy Account credentials | Not proven compatible or identity-bound to Codex App Account reset credits |
| Automatic reset when count is positive | Irreversible provider mutation; violates existing redemption ADR and operator-confirmation contract |

## Product recommendation

Build two separate surfaces:

1. **Codex profiles**: read-only list, add/login, refresh-one, refresh-all, transient account recognition, usage/reset-credit availability.
2. **Manual redemption**: existing single-profile confirmation workflow, entered only by explicit operator action.

First implementation slice should stop after managed-root creation, login instructions/action, sequential reads, sanitized UI, and tests proving zero calls to `account/rateLimitResetCredit/consume`.

This preserves existing domain boundary: a Codex App Account Check is recognition evidence, not stable account/workspace proof; Usage Limit Reset Redemption remains manual, local, and separately authorized: [CONTEXT.md](../../CONTEXT.md), [ADR 0005](../adr/0005-bound-reset-redemption-to-the-local-codex-app-account.md).
