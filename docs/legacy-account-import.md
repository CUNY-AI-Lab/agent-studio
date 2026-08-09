# One-time first-login import

Agent Studio has one narrow bridge for users who created work before CAIL
identity was required. It runs lazily on the first successful login that
contains both:

- a currently verified `X-CAIL-Identity-JWT` for the Agent Studio audience,
- the signed legacy Agent Studio session mapping for that same user.

The import copies the complete legacy content and relationships into the
verified subject's namespace: workspace records, Durable Object state, chat
messages, files, queued downloads, and gallery ownership. The new subject
namespace becomes authoritative only after the copy succeeds.

Each user has one completion marker. It is written after the complete copy and
cleanup succeed, so an interrupted attempt can be retried privately. A failed
attempt is retryable and does not make a partial target authoritative. The
request never serves data from both namespaces, and there is no alias, dual
read, background import job, synchronization loop, or broad compatibility
window.

The bridge is not a general import API. It accepts only the verified current
identity and the signed legacy mapping, keeps all identity and workspace
values server-side, and removes the legacy source after the new namespace is
committed. A user with no valid legacy mapping starts with an empty subject
namespace.

Operators validate this path through the authenticated staging smoke and the
route tests. No secret, token, subject, email, or workspace identifier belongs
in logs or documentation.
