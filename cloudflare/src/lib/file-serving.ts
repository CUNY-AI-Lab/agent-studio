// Shared security headers for the two routes that serve raw workspace/gallery
// file bytes to the browser (GET /api/workspaces/:id/files/* and
// GET /api/gallery/:id/files/*).
//
// §3¾ invariant: tool-served user/agent bytes must NEVER be interpretable as an
// active same-origin document. An attacker-authored .html/.svg that reaches a
// workspace (or the public gallery) and is opened top-level would otherwise run
// script on the app origin and read the non-HttpOnly CSRF cookie.
//
// The load-bearing mechanism is the bare `sandbox` CSP directive: with no
// allow-* tokens it forces the response into an OPAQUE origin with scripting
// DISABLED, so even genuine text/html bytes cannot execute or touch
// document.cookie. `nosniff` prevents MIME confusion. For active document types
// we additionally force `Content-Disposition: attachment` so a top-level open
// downloads instead of navigating to a live document. Safe inline types
// (images, pdf, text, json, ...) keep rendering inline — the sandbox CSP +
// nosniff already contain them.

// Active document types: bytes a browser could interpret as an executable /
// scriptable same-origin document if navigated to top-level. Matched
// case-insensitively against the resolved content-type, ignoring any
// `; charset=` parameter.
const ACTIVE_DOCUMENT_TYPES = new Set([
  'text/html',
  'image/svg+xml',
  'application/xml',
  'application/xhtml+xml',
]);

function isActiveDocumentType(contentType: string): boolean {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase() || '';
  return ACTIVE_DOCUMENT_TYPES.has(base);
}

/**
 * Security headers applied to raw file-serving responses. Callers must merge
 * these on top of the route's own Content-Type/Content-Length/Cache-Control.
 *
 * @param contentType the resolved content-type the response will carry.
 */
export function fileServingHeaders(contentType: string): Record<string, string> {
  const headers: Record<string, string> = {
    // Never let the browser sniff a different (possibly active) type.
    'X-Content-Type-Options': 'nosniff',
    // Opaque origin + scripting disabled: the primary containment.
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };

  if (isActiveDocumentType(contentType)) {
    // Force download for active types so a top-level open can never navigate to
    // a live document on our origin. Safe inline types are intentionally left
    // to render inline.
    headers['Content-Disposition'] = 'attachment';
  }

  return headers;
}
