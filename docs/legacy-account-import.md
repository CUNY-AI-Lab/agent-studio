# Temporary legacy-account import

This runbook covers the bounded compatibility path that moves an anonymous
pre-SSO namespace into the verified CAIL subject namespace. The same deadline
controls legacy R2 file hydration and the old `downloads.json` reader.

## Configuration

Set these in the same authorized release that changes
`CAIL_REQUIRE_IDENTITY` to `true`:

```text
CAIL_SSO_SWITCHED_AT=<complete ISO instant>
CAIL_ACCOUNT_IMPORT_UNTIL=<exclusive complete ISO instant>
```

Both require `Z` or an explicit UTC offset. The deadline cannot precede the
switch or exceed it by more than 30 days. Missing, blank, date-only, or invalid
values fail configuration. Before enforcement, leaving both absent preserves
anonymous local behavior; configuring only one is invalid.

## State machine and invariants

One `MigrationRegistry` object is keyed by the anonymous session id. The first
verified subject to claim it wins permanently. The same subject may retry a
failed claim or an in-progress claim older than ten minutes; a different
subject can never take it over.

For each workspace:

1. An existing subject-side workspace id is never overwritten.
2. The anonymous agent hydrates compatibility files, then refuses the freeze
   if any fenced mutation is active.
3. Freeze becomes durable before the snapshot. Runtime file writes, code
   execution, and host tools are fenced; synchronous canvas mutations cannot
   interleave across an await.
4. State, messages, files, and eligible downloads copy into a clean target.
5. The subject workspace record is written last as that workspace's completion
   marker.
6. A failed copy destroys the partial target agent and target R2 prefix, then
   unfreezes every source so the same subject can retry.

After every workspace is committed, private gallery ownership is reassigned
across all R2 pages. Source agents and anonymous R2 prefixes are then destroyed.
The registry is marked done only after the copy-and-cleanup workflow returns.

The process is idempotent, not a cross-store transaction. A failure during
source cleanup can occur after target completion markers exist. On retry,
those targets are skipped and cleanup resumes. Do not delete or edit the claim
record manually.

## Deadline behavior

During the open window, a request carrying both a verified identity and a valid
legacy cookie can run the claim. While another request owns a fresh in-progress
claim, the request continues in the subject namespace and retains the legacy
cookie for a later retry.

At and after the exclusive deadline:

- no new anonymous namespace is claimed;
- the legacy browser cookie is removed;
- legacy workspace-file prefixes and `downloads.json` are ignored;
- current subject workspaces, runtime files, and per-object downloads continue;
- compatibility refusal events contain no session id, workspace id, filename,
  or user content.

Expiry does not itself delete unclaimed server-side data. That cleanup depends
on the approved retention and deletion procedure.

## Recovery

For a failed or stale claim:

1. Confirm the claimant subject matches the durable claim. Never reassign it.
2. Inspect fixed-code migration telemetry; do not log user ids, paths, or
   content.
3. For each workspace, use the subject workspace record as the commit marker.
   If absent, the partial target should have been destroyed and the source is
   retryable. If present, preserve the target and let the retry skip the copy.
4. Confirm source agents are unfrozen after a copy failure. A source that was
   already committed may be partially cleaned; recover from the committed
   target, not by rolling it back into the anonymous namespace.
5. Retry through the normal authenticated request path. Do not invoke internal
   migration RPCs from a browser or edit R2 prefixes by hand.

There is no automatic rollback from a committed subject workspace to its
anonymous source. Backup/restore and operator access remain external
activation requirements.

## Removal at cutoff

Create the removal ticket before the switch, due at
`CAIL_ACCOUNT_IMPORT_UNTIL`. After telemetry and claims are reconciled, remove
the cookie-triggered import path, `MigrationRegistry` binding/class and class
migration only when no rollback needs it, legacy R2 hydration, the
`downloads.json` reader, both window variables, and their tests and docs.

Preserve the class and compatibility readers through any rollback window.
Cloudflare class migrations register Durable Object classes; they do not
delete data or migrate application records. Deleting anonymous data requires
the retention-approved purge and backup procedure.
