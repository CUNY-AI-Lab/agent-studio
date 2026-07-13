# Temporary legacy-account import

Agent Studio temporarily copies an authenticated user's anonymous pre-SSO
namespace into the stable CAIL subject namespace. The same deadline controls
the related old R2-file hydration and `downloads.json` backward-read paths.
Current subject-keyed workspaces, runtime files, and per-object downloads do not
depend on this compatibility code.

## Configuration contract

Set these values in the same release that changes `CAIL_REQUIRE_IDENTITY` to
`true`:

```text
CAIL_SSO_SWITCHED_AT=2026-07-15T14:00:00Z
CAIL_ACCOUNT_IMPORT_UNTIL=2026-07-29T14:00:00Z
```

Both values must be complete ISO instants with `Z` or an explicit UTC offset.
`CAIL_ACCOUNT_IMPORT_UNTIL` is exclusive, cannot precede the switch, and cannot
be more than 30 days after it. Enforced identity with missing or invalid values
returns `503 configuration_invalid` from health and application traffic.

Before enforcement, leaving both values unset preserves anonymous local and
pre-rollout behavior. Supplying only one value, blank values, date-only values,
or an invalid pair fails configuration validation even before enforcement.

## Deadline behavior

During the window, a valid legacy cookie may claim and copy its anonymous
namespace once. Old workspace-file prefixes may hydrate into the runtime, and
old `downloads.json` blobs are included with current per-object downloads.

After the deadline:

- authenticated requests do not claim or copy anonymous namespaces;
- the legacy browser session cookie is deleted;
- old workspace-file prefixes are ignored and left intact for controlled cleanup;
- old `downloads.json` blobs are ignored while current per-object downloads remain available;
- refusal and ignored-hydration events are emitted without session ids, workspace ids, filenames, or content.

## Required deletion follow-up

Create the removal ticket before the SSO switch. Its due date must be
`CAIL_ACCOUNT_IMPORT_UNTIL`, which validation guarantees is no later than 30
days after `CAIL_SSO_SWITCHED_AT`.

The ticket must remove the temporary cookie-triggered import path,
`MigrationRegistry` binding/class and its Cloudflare migration entry, legacy R2
hydration, the `downloads.json` backward read, the two window variables, and
their tests and documentation. Review migration telemetry first, then delete or
archive remaining anonymous-session and old-format R2 data under the approved
retention procedure; expiry deliberately does not destroy server-side user data
inside a normal request.
