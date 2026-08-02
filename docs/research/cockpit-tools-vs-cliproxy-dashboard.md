# Cockpit Tools vs CLIProxy Dashboard

Research date: 2026-07-17
CLIProxy Dashboard revision: `83879ee9e8266ab381b1cb3798667b8394dfb7b7`
Cockpit Tools revision: [`b3a597c3db1d039121f1bf3305b54853d2d96c26`](https://github.com/jlcodes99/cockpit-tools/tree/b3a597c3db1d039121f1bf3305b54853d2d96c26)
Cockpit Tools release inspected: [`v1.3.8`](https://github.com/jlcodes99/cockpit-tools/releases/tag/v1.3.8)

## Executive answer

Cockpit Tools is substantially better as a **general local AI-account workbench**. It combines multi-platform account management, Codex quota reads, account switching, isolated Codex instances, an OpenAI-compatible local gateway, per-key routing policy, request statistics, and limited cross-machine projection in one desktop app. Those capabilities are either absent from CLIProxy Dashboard or currently require the dashboard, an external CLIProxy binary, Codex itself, and host-specific setup to work together.

It is not yet a safe drop-in replacement for this project.

CLIProxy Dashboard is narrower but owns several high-assurance behaviors Cockpit does not demonstrate: duration-bound and identity-bound quota evidence, observation-continuity rules, revision-checked priority mutation against a pinned CLIProxy contract, a server-owned quota-balancing state machine, and crash-safe/idempotent reset-credit redemption through the supported Codex app-server protocol. Cockpit instead bundles and owns its own CLIProxyAPI-derived sidecar, reads Codex quotas and consumes reset credits through direct ChatGPT backend URLs, and uses richer but different routing semantics.

**Recommendation: coexist first.** Use Cockpit on the MacBook for account inventory, ordinary switching, isolated instances, and experimentation with its local API service. Keep CLIProxy Dashboard authoritative for the current Windows CLIProxy routing pool, identity-bound quota evidence, automatic rotation, and reset-credit recovery until Cockpit passes a bounded migration pilot or those safety contracts are deliberately ported.

## Product boundary

| Area | Cockpit Tools | CLIProxy Dashboard | Decision impact |
| --- | --- | --- | --- |
| Primary purpose | Universal desktop account manager for 16 AI tools, with switching, quota views, wake-up tasks, and parallel instances. This is a repository claim, supported by platform modules and pages: [README](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L10-L20), [feature overview](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L51-L102). | Codex-specific operator control plane over Proxy Accounts routed through an external CLIProxy runtime: [CONTEXT.md](../../CONTEXT.md#L1-L14), [README](../../README.md#L1-L45). | Cockpit gives more day-to-day breadth. Dashboard remains the specialized Codex routing-safety component. |
| Runtime ownership | Desktop app writes sidecar config, manifest, credentials, and quota-reserve state, then launches the bundled `cockpit-cliproxy`; it also backs up and rewrites selected Codex profiles: [handoff](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L43-L58). | Independent Node server controls files and a separately installed, pinned CLIProxy fork. Production priority mutation goes through its authenticated loopback management API: [README](../../README.md#L71-L89), [management client](../../server/cli-proxy-management.ts#L31-L39), [ADR 0004](../adr/0004-cliproxy-owned-priority-mutation.md). | Replacing the dashboard also changes the gateway runtime owner; this is not merely a UI swap. |
| API service | Source-verified local authenticated gateway with `/v1/models`, chat completions, Responses, compact Responses, Codex backend paths/WebSocket, and image routes. Default bind is loopback; LAN scope is optional: [handoff](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L60-L74). | Dashboard is not the client API gateway. It configures and observes the external CLIProxy service and exposes only its own operator API: [server](../../server/server.ts#L41-L77), [routing/test endpoints](../../server/api.ts#L185-L239). | Cockpit can collapse two local components into one application, but requires protocol and load validation against the current CLIProxy workload. |
| Account management | Codex account storage, switching, quotas, API-key accounts, encrypted detail files, and isolated profiles are source-verified. README also claims one-click switching and hourly/weekly display: [README](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L85-L100), [Codex storage](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_account.rs#L2872-L2990). | OAuth launch, JSON credential import, priority/disable/note edits, primary/backup promotion, deletion backup, verification, and refresh-token renewal: [account API](../../server/api.ts#L241-L331), [mutations](../../server/api.ts#L334-L413), [verification](../../server/api.ts#L414-L525). | Cockpit wins on operator UX and profile lifecycle. Dashboard account operations are closer to raw CLIProxy credential files. |
| Multi-instance | Codex instances have separate managed user-data roots and account injection; README claims parallel isolated Codex instances: [README](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L94-L102), [instance module](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_instance.rs#L831-L938). | No equivalent user-facing Codex application instance manager. Rotation is singleton server automation over one CLIProxy account pool: [ADR 0003](../adr/0003-server-owned-quota-rotation-controller.md). | Clear Cockpit advantage on MacBook developer workflows. |
| Multi-machine | Source-verified SSH action copies the currently projected `~/.codex/auth.json` and, best effort, `config.toml` to one configured remote host, then attempts app-server reload: [SSH sync](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_ssh.rs#L237-L343). WebDAV upload/download exists, but this review did not verify exactly which sensitive account payloads every backup format includes. | Designed as a local dashboard over local paths and loopback management. Reset redemption explicitly does not support shared cross-user Codex state: [ADR 0005](../adr/0005-bound-reset-redemption-to-the-local-codex-app-account.md), [ADR 0006](../adr/0006-journal-idempotent-reset-redemptions-across-crashes.md). | Cockpit helps project credentials to another host; it is not a verified central multi-host control plane. Keep authoritative runtime ownership per host. |

## Quota and reset behavior

### Cockpit Tools

Cockpit directly requests `https://chatgpt.com/backend-api/wham/usage`, sending the stored bearer token and optional `ChatGPT-Account-Id`: [quota request](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_quota.rs#L870-L956). This gives an immediate per-managed-account quota view without waiting for routed traffic.

Its parser currently assigns semantic meaning by position: primary window becomes five-hour usage and secondary becomes weekly usage. Missing windows default to 100% remaining: [quota parser](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_quota.rs#L959-L1008). This is convenient but weaker than the dashboard's duration-bound classification if the provider changes window ordering or omits a window.

Cockpit also calls direct ChatGPT reset-credit list and consume URLs. It generates one UUID per invocation and reuses it for a 401-refresh retry: [reset-credit URLs](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_quota.rs#L10-L17), [consume flow](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_quota.rs#L1290-L1371). The inspected function does not persist that UUID before dispatch, journal ambiguous outcomes, or reconcile the provider's structured result after a process crash.

### CLIProxy Dashboard

The dashboard deliberately distinguishes authentication verification, Codex App Account usage, and identity-bound Proxy Account quota. Its retained Proxy Account evidence comes from routed response logs and quota headers, remains latest-known when stale, and cannot drive rotation after identity or observation continuity breaks: [README](../../README.md#L126-L146), [quota log parser](../../server/quota-log-updates.ts#L172-L206), [ADR 0002](../adr/0002-duration-bound-quota-evidence.md).

Automatic rotation requires explicit pool membership and exclusivity attestation, `fill-first`, disabled affinity, fresh weekly evidence, healthy observation, and verified priority mutation. It journals intent before mutation and pauses instead of guessing after conflicts: [ADR 0001](../adr/0001-proxy-exclusive-quota-rotation.md), [ADR 0003](../adr/0003-server-owned-quota-rotation-controller.md), [rotation transaction](../../server/rotation-controller.ts#L210-L286).

Reset redemption goes through the installed Codex app-server, remains bound to a visible local Codex App Account, and uses a durable lease/journal/tombstone design to avoid double consumption after timeout or crash: [ADR 0005](../adr/0005-bound-reset-redemption-to-the-local-codex-app-account.md), [ADR 0006](../adr/0006-journal-idempotent-reset-redemptions-across-crashes.md), [feasibility research](codex-quota-reset-feasibility.md#supported-design-options-ranked).

### Decision

Cockpit is better for **immediate per-account visibility**. CLIProxy Dashboard is better for **using quota evidence as authority for unattended routing** and for safely handling irreversible reset-credit consumption. Do not treat Cockpit's prettier quota panel as evidence that its automatic routing has the same trust model.

## Routing, reliability, and observability

Cockpit has the broader operational surface:

- Account pools support auto, random, single-account, quota/plan/expiry ordering, custom priority/weight/backup, session affinity, cooldown, bounded retries, and per-key account/model policies: [routing rules](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L76-L104).
- It persists summarized counters, queryable SQLite request/usage logs, takeover backups, and generated sidecar state: [artifacts](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L106-L123).
- Its frontend exposes health, cooldown, API-key, account, model, instance, gateway-mode, error, and request-log views. These fields are defined in the Rust contract: [state and health models](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/models/codex_local_access.rs#L513-L752).

CLIProxy Dashboard has the narrower but deeper control loop:

- It pins expected CLIProxy runtime version `7.2.75` and commit `3bbf6da7...`, requires authenticated loopback, validates revisions, and verifies mutation results: [management contract](../../server/cli-proxy-management.ts#L7-L8), [loopback rule](../../server/cli-proxy-management.ts#L31-L39), [mutation verification](../../server/cli-proxy-management.ts#L178-L232).
- The rotation controller owns one journaled priority overlay, verifies identity and unrelated priority stability, and pauses on unsafe state: [rotation controller](../../server/rotation-controller.ts#L183-L286).
- Quota persistence is owner-only and atomic, using HMAC-derived non-linkable account keys: [quota store](../../server/quota-store.ts#L286-L335).

Cockpit likely gives a better operator dashboard. The existing dashboard gives stronger evidence provenance and deterministic recovery for the exact custom rotation contract.

## Security and credential handling

### Cockpit strengths

- Per-account detail JSON is encrypted with AES-256-GCM. Legacy plaintext details are migrated on rewrite: [secure storage](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/secure_account_storage.rs#L1-L5), [encryption](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/secure_account_storage.rs#L68-L119).
- The local account detail key is randomly generated and set to mode `0600` on Unix: [key storage](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/secure_account_storage.rs#L30-L60).
- Codex API service defaults to loopback and requires a generated API key: [HTTP surface](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L60-L74).

### Cockpit risks

- The encryption key lives in the same local application data boundary as the ciphertext. It reduces exposure from copying only account-detail files; it does not protect against compromise of the same OS account.
- Sidecar manifests and generated auth files contain credentials; project docs explicitly warn not to paste them: [persistent artifacts](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L106-L123).
- Users can bind the gateway to `0.0.0.0`; API keys remain required, but network exposure expands: [HTTP surface](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L71-L74).
- Tauri CSP is disabled: [Tauri config](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/tauri.conf.json#L45-L47).
- macOS releases are not Developer ID signed/notarized; README recommends quarantine bypass when Gatekeeper blocks the app: [installation warning](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L365-L396).
- `SECURITY.md` is still the GitHub template and lists unrelated versions, so it does not provide a usable vulnerability-reporting contract: [security policy](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/SECURITY.md#L1-L21).

### CLIProxy Dashboard strengths and gaps

- Dashboard APIs require a same-origin request and an operator token, while the production management client requires authenticated HTTP loopback: [API boundary](../../server/api.ts#L128-L183), [management boundary](../../server/cli-proxy-management.ts#L31-L39).
- Quota and reset private state has explicit owner-only and secret-minimizing contracts: [quota store](../../server/quota-store.ts#L286-L307), [ADR 0006](../adr/0006-journal-idempotent-reset-redemptions-across-crashes.md).
- Proxy credential JSON and deletion/mutation backups remain ordinary credential-bearing files. The general atomic writer does not itself request `0600`; effective protection depends on parent-directory permissions and process umask: [file writer](../../server/files.ts#L17-L31), [credential import](../../server/api.ts#L277-L330).

Neither tool should be exposed broadly on the Windows MT5 laptop. Keep service binds on loopback unless a separately reviewed remote-access design is required.

## Licensing and maintenance

Cockpit is active and popular: the inspected release `v1.3.8` was published 2026-07-16, and the inspected `main` commit followed the same day. GitHub reported about 13.7k stars and 414 open issues during this research. Release packages cover macOS, Windows, and Linux: [release](https://github.com/jlcodes99/cockpit-tools/releases/tag/v1.3.8), [installation targets](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L346-L354).

Licensing is a blocker for treating Cockpit as a base for private product development or business use. README declares CC BY-NC-SA 4.0, prohibits internal commercial operations without separate permission, and the repository has no root license file recognized by GitHub: [license statement](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md#L464-L470). Obtain written clarification before redistributing, embedding, or materially modifying it for commercial use.

CLIProxy Dashboard README says MIT, but the checkout has no `LICENSE` file. The intended license is permissive, but the repository should add the actual license text before publication or reuse: [README license](../../README.md#L241-L245).

The local dashboard is actively maintained for this environment—the inspected revision was committed 2026-07-17—but it has a higher owner-maintenance burden because it depends on a pinned custom CLIProxy build and bespoke safety contracts. Cockpit has more contributors, releases, packaging, and surface coverage, but also a much larger attack and regression surface.

## Replacement and coexistence decision

### Replace now: no

An immediate replacement would silently trade away or leave unverified:

1. Revision-checked priority mutation against the pinned CLIProxy fork.
2. Duration-bound weekly-window classification.
3. Identity-bound routed evidence and Observation Continuity.
4. Exclusivity attestation and fail-closed automatic rotation.
5. Codex app-server-owned reset redemption with durable crash recovery.
6. Existing Windows host paths, service ownership, logs, and validation evidence.

Cockpit may implement comparable user outcomes, but the inspected source proves different mechanisms, not equivalent contracts.

### Augment now: yes, with boundaries

Best near-term use:

- **MacBook:** Cockpit for ordinary account browsing, quota checks, account switching, and isolated Codex instances.
- **Strong Windows workstation:** keep CLIProxy Dashboard plus the pinned CLIProxy runtime for the authoritative routing pool and heavy API workload. Test Cockpit's sidecar only on a different port and an isolated account subset.
- **Windows MT5 laptop:** do not install initially. It adds credential storage, child-process launching, profile rewriting, update handling, and optional network services to a machine whose primary role is live MT5 operation.

Do not let both tools mutate the same active `~/.codex/auth.json`, refresh the same rotating OAuth token chain concurrently, or own the same API port. Cockpit's source itself warns that reused rotating refresh tokens across clients or instances can require reauthentication: [Codex account refresh handling](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_account.rs#L1752-L1795).

### Candidate future replacement

Cockpit can replace the generic account UI and external CLIProxy packaging if a pilot proves all of these on the target Windows host:

1. Same client Base URL/API-key behavior and all required OpenAI Responses, WebSocket, tool-call, streaming, and image paths.
2. Stable operation under the actual concurrent request load.
3. Correct account selection, cooldown, retries, session affinity, and restart recovery.
4. Export/import and rollback for every credential and Codex profile it rewrites.
5. No cross-tool OAuth refresh-token conflicts.
6. An explicit decision to port, retire, or keep the dashboard's quota-balanced rotation and reset-redemption safety modules.
7. Acceptable license terms for the intended use.

If those pass, the clean architecture is likely **Cockpit as the local account/instance/gateway product, with a small separate safety service only if the bespoke rotation/redemption contracts remain necessary**. Trying to keep the current dashboard directly mutating Cockpit's generated sidecar files would recreate competing ownership and should be avoided.

## Migration cost

Expected migration is medium-to-high, not one-click:

- Install and trust a new Tauri desktop application plus bundled Go sidecar.
- Import or reauthenticate Codex accounts into Cockpit's encrypted store.
- Recreate API keys, pool membership, model filters/aliases, routing rules, reserve thresholds, session-affinity settings, port, and bind scope.
- Stop the current CLIProxy process before Cockpit takes the same port.
- Activate profile takeover only after backing up and diffing `auth.json` and `config.toml`; Cockpit does maintain takeover backups: [runtime flow](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md#L43-L58).
- Rebuild host service/startup behavior; Cockpit normally owns lifecycle through its desktop process rather than the current Node/CLIProxy service arrangement.
- Revalidate all downstream clients and then keep a rollback path to the previous exact dashboard and CLIProxy revisions.

## Evidence limits

- Cockpit release binaries were not installed or executed.
- No live account, quota, gateway, WebSocket, SSH, WebDAV, or migration test was run.
- Source review was targeted to the user decision, not a full security audit of the large repository or bundled CLIProxyAPI fork.
- Cockpit README statements are labeled as claims where runtime behavior was not independently exercised.
- WebDAV transport and remote backup operations were found in source, but this review did not prove the complete sensitive-data contents and encryption properties of every generated backup type.
- CLIProxy Dashboard tests were not run for this research; local behavior is based on the current source, ADRs, and existing project research.

## Primary sources

### CLIProxy Dashboard

- [README](../../README.md)
- [Domain language](../../CONTEXT.md)
- [ADRs](../adr/)
- [Server API](../../server/api.ts)
- [CLIProxy management client](../../server/cli-proxy-management.ts)
- [Quota evidence parser](../../server/quota-log-updates.ts)
- [Rotation controller](../../server/rotation-controller.ts)
- [Quota reset feasibility](codex-quota-reset-feasibility.md)

### Cockpit Tools

- [README at inspected revision](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/README.en.md)
- [Codex API Service handoff](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/docs/CODEX_API_SERVICE_HANDOFF.md)
- [Codex account module](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_account.rs)
- [Codex quota/reset module](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_quota.rs)
- [Codex instance module](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_instance.rs)
- [Secure account storage](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/secure_account_storage.rs)
- [Codex SSH sync](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/src/modules/codex_ssh.rs)
- [Tauri configuration](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/src-tauri/tauri.conf.json)
- [Security policy](https://github.com/jlcodes99/cockpit-tools/blob/b3a597c3db1d039121f1bf3305b54853d2d96c26/SECURITY.md)
- [Release v1.3.8](https://github.com/jlcodes99/cockpit-tools/releases/tag/v1.3.8)
