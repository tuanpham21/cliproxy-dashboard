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

**Account-Scoped Quota Refresh**:
A Quota Refresh attempted for one Proxy Account at a time. It may require the operator to authenticate that same identity before the dashboard can prove the read is identity-bound.
_Avoid_: bulk refresh, current app refresh, global quota refresh
