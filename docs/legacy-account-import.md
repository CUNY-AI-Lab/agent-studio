# One-time first-login import

Agent Studio has one narrow bridge for users who created work before CAIL
identity was required. It runs lazily on the first successful login that
contains both:

- a currently verified `X-CAIL-Identity-JWT` for the Agent Studio audience,
- a valid signed legacy Agent Studio session cookie carried by that browser.

The import copies the complete legacy content and relationships into the
verified subject's namespace: workspace records, Durable Object state, chat
messages, files, queued downloads, and gallery ownership. The new subject
namespace becomes authoritative only after the copy succeeds.

Each user has one completion marker. It is written after the complete copy
succeeds, so an interrupted attempt can be retried privately. A failed
attempt is retryable and does not make a partial target authoritative. The
request never serves data from both namespaces, and there is no alias, dual
read, background import job, synchronization loop, or broad compatibility
window.

Each legacy workspace is frozen as soon as its target workspace record
commits. If a later workspace or the final marker fails, retries leave the
committed target untouched and the frozen source cannot diverge. A failure
before a workspace record commits unfreezes that source so the complete copy
can run again. The retry replaces the invisible target's runtime files,
messages, state, and download queue before the workspace record makes them
authoritative, so content removed from the source between attempts cannot
survive as stale target data.

The bridge is not a general import API. It accepts only the verified current
identity and the verified signed cookie, keeps all identity and workspace
values server-side, and clears the browser's legacy cookie after the new
namespace is committed. The old namespace is retained as an inaccessible
backup and is never consulted by normal reads. A user with no valid legacy
cookie starts with an empty subject namespace.

One small `MigrationRegistry` Durable Object instance is addressed by the
legacy cookie namespace. It admits or rejects short-lived anonymous request
leases and makes the first verified subject claim sticky, so workspace and
gallery writes cannot pass the import marker. It is created only on use,
contains no workspace content, and does not run while idle. The R2 subject
marker remains the only per-user signal that the complete copy finished.

The route tests cover first login, repeat login, invalid identity inputs,
partial failure, committed-workspace failure, corrupt stored content, parallel
attempts, and retry. A live verification must use only synthetic content and
must delete it afterward. No secret, token, subject, email, or workspace
identifier belongs in logs or documentation.
