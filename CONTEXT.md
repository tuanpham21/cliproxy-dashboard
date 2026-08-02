# cliproxy-dashboard

cliproxy-dashboard helps a local operator understand and control Codex identities routed through a proxy.

## Language

**Proxy Account**:
A Codex identity that the dashboard can select, prioritise, disable, and observe for routing. Quota shown in the dashboard belongs to a Proxy Account only when the dashboard can prove the quota source is bound to that same identity.
_Avoid_: account, auth file, Codex account

**Proxy Account Key**:
A stable, non-secret, non-linkable local identifier that the dashboard uses to associate a Proxy Account with its Retained Quota Snapshot. It is not a display label, credential value, unsalted hash, or Codex App Account identity.
_Avoid_: filename, email, account ID

**Codex App Account**:
The Codex identity currently authenticated in the Codex app surface. It is distinct from a Proxy Account unless the dashboard proves both refer to the same identity.
_Avoid_: current account, app auth, Codex account

**Codex App Account Check**:
A read-only observation that the authenticated Codex App Account is a ChatGPT identity with a non-empty provider email and known plan. It helps the operator recognise the account but does not prove a stable provider account or workspace identity.
_Avoid_: identity proof, logged in, valid session

**Codex Login Profile**:
A dashboard-managed private, immutable Codex state root that retains one intended Codex App Account login for independent checking. It is not a Codex configuration profile selected with `--profile`, a Proxy Account, or an account identity itself.
_Avoid_: profile, Codex profile, account folder, auth file

**Codex Profile Observation Snapshot**:
The one latest-known sanitized Codex App Account Check, usage-window observation, and reset-credit count retained for a Codex Login Profile. It has an observation time and freshness state, contains no credit details or history, and never authorizes Usage Limit Reset Redemption.
_Avoid_: current quota, reset eligibility, account history, Retained Quota Snapshot

**Usage Limit Reset Credit**:
A provider-issued entitlement that may reset eligible usage windows for the authenticated Codex App Account when redeemed. It is not an arbitrary quota clear or a CLIProxy routing reset.
_Avoid_: quota reset, reset token, free quota

**Usage Limit Reset Redemption**:
Consumption of one Usage Limit Reset Credit for the Codex App Account. The provider decides whether any window is eligible and which windows reset.
_Avoid_: reset Codex quota, clear quota, account reset

**Reset Redemption Confirmation**:
Explicit operator approval shown with Codex App Account identity and available reset-credit context before Usage Limit Reset Redemption. Cancellation is the default action.
_Avoid_: reset prompt, browser confirm, redemption warning

**Generic Reset Redemption**:
Usage Limit Reset Redemption without a specified credit identifier, used when the provider reports availability but supplies no credit details. The provider selects the credit to consume.
_Avoid_: random reset, unspecified reset, automatic reset

**Reset Redemption Attempt**:
One operator-approved logical Usage Limit Reset Redemption that may be retried safely without consuming an additional credit. It ends with a provider-controlled outcome.
_Avoid_: reset click, redemption request, retry request

**Redemption Proposal**:
A short-lived server-owned offer to redeem one specific or provider-selected Usage Limit Reset Credit for the checked Codex App Account. It expires before mutation and cannot be reused for a different account or credit choice.
_Avoid_: confirmation token, reset request, pending reset

**Reset Redemption Reconciliation**:
A read-only observation after a successful or previously completed Reset Redemption Attempt, used to display current usage and remaining reset credits without rewriting Proxy Account evidence.
_Avoid_: reset refresh, snapshot reset, optimistic quota update

**Unreconciled Redemption**:
A Reset Redemption Attempt that the provider accepted or previously completed but whose current usage and remaining credits could not be observed afterward. It is not a failed redemption and must not trigger automatic re-redemption.
_Avoid_: failed reset, pending reset, unknown reset

**Redemption Audit Event**:
A secret-free operational record that a Reset Redemption Attempt occurred, including its time, outcome, Codex version, and whether the provider selected the credit. It excludes account identity, quota values, credit identifiers, and retry identifiers.
_Avoid_: redemption history, account audit, quota log

**Redemption Crash Journal**:
Owner-only recovery state for one non-terminal Reset Redemption Attempt, retaining the minimum identity digest, retry identifier, optional credit identifier, phase, and timing needed to resume safely after process failure. It is deleted after terminal handling and is not redemption history.
_Avoid_: redemption log, quota state, account history

**Terminal Redemption Tombstone**:
A short-lived, non-secret terminal result retained after the Redemption Lease is released so a lost client response can be replayed without another provider call. It is not long-term redemption history.
_Avoid_: redemption history, audit record, completed journal

**Ambiguous Redemption**:
A Reset Redemption Attempt whose consume request may have reached the provider without a confirmed terminal outcome. It blocks all new redemptions until the same attempt is resolved using its retained recovery state.
_Avoid_: timed-out reset, failed reset, expired attempt

**Redemption Lease**:
Per-OS-user exclusive ownership of the current non-terminal Reset Redemption Attempt across dashboard processes. It prevents concurrent attempts and remains bound to an Ambiguous Redemption.
_Avoid_: process lock, reset mutex, proposal lock

**Reset Redemption Capability Proof**:
Evidence that the installed Codex runtime exposes the required account-read, rate-limit-read, and reset-credit-redemption contracts. Redemption remains unavailable without this proof and never falls back to direct provider backend calls.
_Avoid_: supported version, minimum Codex version, app-server available

**Local Redemption Boundary**:
Usage Limit Reset Redemption is available only when both the dashboard listener and requesting client are loopback-local. The dashboard operator token protects against cross-site requests but is not remote-user authentication.
_Avoid_: localhost authentication, operator login, trusted network

**Single-Workspace Redemption Attestation**:
The operator's assertion that the current Codex App Account has one relevant provider workspace and is the intended redemption target. It bounds residual risk where Codex exposes display identity but no stable workspace identifier.
_Avoid_: workspace proof, verified account, identity binding

**Redemption Session**:
One dedicated Codex app-server process used from final account check through Usage Limit Reset Redemption and reconciliation. Losing the session after dispatch may leave the outcome ambiguous.
_Avoid_: Codex command, app-server request, reset connection

**Quota Snapshot**:
The dashboard's latest known quota evidence for a Proxy Account, including usage, reset times, source, and freshness. Expired snapshots remain visible as historical or stale evidence until refreshed, rather than disappearing into an unknown state.
_Avoid_: quota state, usage counts, rate limit info

**Dashboard State Store**:
A small dashboard-owned persistence area for non-secret operator state such as Quota Snapshots. It is separate from Proxy Account credential files and proxy configuration.
_Avoid_: browser storage, account JSON, config cache

**Identity-Bound Quota Read**:
A read-only quota observation that the dashboard can prove belongs to a specific Proxy Account. A quota read from the current Codex App Account is not identity-bound to a Proxy Account unless that relationship is proven.
_Avoid_: live quota, current account quota, app quota

**Refresh-Needed Snapshot**:
A Quota Snapshot whose reset time has passed, or that a revalidation policy marks as needing a new observation. It remains visible as historical evidence, but the dashboard must not treat it as exact current availability.
_Avoid_: reset quota, available again, cleared quota

**Latest Known Quota Evidence**:
The dashboard's honest user-facing promise for Proxy Account quota visibility. It may be fresh, stale, refresh-needed, unknown, or blocked, but it must not imply guaranteed real-time availability without an Identity-Bound Quota Read.
_Avoid_: current quota, available quota, real-time quota

**Retained Quota Snapshot**:
A Quota Snapshot that remains stored and visible until newer evidence for the same Proxy Account replaces it. Revalidation policy changes labels or confidence, but does not delete the last known values.
_Avoid_: temporary quota, recent-only quota, expiring cache

**Quota Probe**:
A quota-spending request made only to produce quota evidence for a Proxy Account. It is not normal dashboard refresh behaviour and requires explicit operator intent.
_Avoid_: refresh, verify, check quota

**Session Verification**:
A check that a Proxy Account's credentials can authenticate. It is separate from quota visibility and must not imply that a Quota Snapshot was refreshed.
_Avoid_: quota check, quota refresh, account health

**Quota Refresh**:
A read-only attempt to update a Proxy Account's Quota Snapshot through an Identity-Bound Quota Read. It must not spend model quota or redeem reset credits.
_Avoid_: verify, test request, quota probe

**Quota Spread**:
The difference between the active Proxy Account's fresh weekly used percentage and the lowest fresh weekly used percentage among eligible Proxy Accounts.
_Avoid_: quota gap, account difference, usage delta

**Quota-Balanced Rotation**:
A routing policy that keeps eligible Proxy Accounts within a configured Quota Spread by making a different Proxy Account active for future requests when the spread reaches its limit.
_Avoid_: round robin, quota failover, automatic primary

**Rotation-Eligible Proxy Account**:
An opted-in Rotation Pool Member that currently satisfies every rotation safety condition: enabled account, unchanged identity, valid session, observable routing, fresh weekly quota evidence, and no exhaustion or cooldown block.
_Avoid_: available account, healthy account, rotation account

**Rotation Pool Member**:
A Proxy Account explicitly opted into Quota-Balanced Rotation by an operator who attests that the identity is dedicated to this CLIProxy instance.
_Avoid_: eligible account, enabled account, automatic member

**Rotation Pool**:
The configured set of Rotation Pool Members. Membership expresses operator intent and proxy exclusivity; runtime eligibility is evaluated separately.
_Avoid_: account pool, proxy accounts, rotation list

**Rotation-Fresh Quota Evidence**:
Identity-bound weekly quota evidence that remains trustworthy until the earliest of its server-provided reset time, a credential identity change, an observation gap, pool removal, an incompatible evidence schema, or a routing-observation failure.
_Avoid_: recent quota, current quota, fresh snapshot

**Rotation Weekly Window**:
The provider-declared quota window whose duration identifies it as weekly. Its meaning comes from duration metadata, not from whether the provider labels it primary or secondary.
_Avoid_: primary quota, secondary quota, weekly field

**Observation Continuity**:
Evidence that every routed request capable of changing a Proxy Account's quota has remained observable since its latest Quota Snapshot. A missing or unusable observation breaks continuity.
_Avoid_: complete logs, fresh logs, request history

**Routing Target**:
The Proxy Account intended to receive future requests under the active routing policy. It may differ temporarily from the Proxy Account serving an already-started request.
_Avoid_: current account, selected account, primary account

**Observed Routed Account**:
The Proxy Account proven by identity-bound response evidence to have served a particular request.
_Avoid_: latest account, active account, log account

**Pending Rotation**:
A decision to change the Routing Target that has been recorded but not yet confirmed by a normal request with identity-bound weekly quota evidence.
_Avoid_: pending switch, next account, queued rotation

**Provisional Reset Candidate**:
A reset-passed Rotation Pool Member allowed one normal work request to confirm its new weekly quota cycle. It is not Rotation-Eligible until that response supplies valid weekly evidence.
_Avoid_: reset account, presumed-zero account, refreshed account

**Rotation Priority Overlay**:
A controller-owned routing priority temporarily applied above an operator's preserved base priority to express the Routing Target.
_Avoid_: primary priority, automatic priority, boosted priority

**Manual Hold**:
A controller state in which an operator-selected Routing Target remains in force while automatic balancing is suspended until explicit resume.
_Avoid_: manual mode, paused primary, pinned account

**Rotation Pause Reason**:
A recorded safety condition that prevents automatic rotation until it self-clears or receives the required operator recovery action.
_Avoid_: rotation error, controller failure, blocked state

**Account-Scoped Quota Refresh**:
A Quota Refresh attempted for one Proxy Account at a time. It may require the operator to authenticate that same identity before the dashboard can prove the read is identity-bound.
_Avoid_: bulk refresh, current app refresh, global quota refresh
