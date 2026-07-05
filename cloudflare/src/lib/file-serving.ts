// Shared security headers for the routes that hand tool-served user/agent bytes
// to the browser: the two raw file-serving routes
// (GET /api/workspaces/:id/files/* and GET /api/gallery/:id/files/*) and the two
// preview routes (GET /api/{workspaces,gallery}/:id/panels/:panelId/preview).
//
// §3¾ invariant: tool-served user/agent bytes must NEVER be interpretable as an
// active SAME-ORIGIN document. An attacker-authored .html/.svg — or an inline
// `type:'preview'` panel whose `content` is attacker/agent-authored HTML — that
// reaches a workspace (or the public gallery) and is opened top-level would
// otherwise run script on the app origin and read the non-HttpOnly CSRF cookie
// (cross-tenant account takeover).
//
// Two neutralizations, chosen per route by whether the bytes are MEANT to run:
//
//   * File routes (fileServingHeaders) DISABLE scripts + FORCE download. Files
//     are never meant to execute, so the bare `sandbox` CSP directive (no
//     allow-* tokens) forces an OPAQUE origin with scripting DISABLED, and
//     active document types additionally get `Content-Disposition: attachment`
//     so a top-level open downloads instead of navigating to a live document.
//
//   * Preview routes (previewServingHeaders) KEEP scripts but FORCE an opaque
//     origin. A preview panel's whole purpose is to render active HTML, so we
//     cannot kill scripting. Instead the `sandbox allow-scripts` CSP directive
//     (note: NO `allow-same-origin`) forces an opaque origin EVEN ON TOP-LEVEL
//     NAVIGATION: scripts still execute (the feature works) but `document.cookie`
//     and the same-origin session are unreachable, so the takeover is dead. This
//     mirrors the in-app iframe posture (`sandbox="allow-scripts"` without
//     allow-same-origin) but enforced at the RESPONSE, so a direct top-level
//     open is equally opaque-origin. Content-Disposition is intentionally NOT
//     set — previews must render, not download.
//
// `nosniff` on the file routes prevents MIME confusion. Both helpers live here
// so a third route can't drift from the invariant.

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

// The source lists preview HTML is allowed to load WITHIN its sandbox. Inline +
// the CDN hosts must keep working (that's the live-preview feature); the
// `sandbox allow-scripts` directive (appended below) is what forces the opaque
// origin regardless of these sources.
const PREVIEW_CSP_SOURCE_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://esm.sh",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com https://unpkg.com https://cdn.jsdelivr.net",
  "img-src 'self' data: blob: https: http:",
  "connect-src 'self' https: http:",
  // Keep frame-ancestors 'self' so the in-app iframe can still embed the preview.
  "frame-ancestors 'self'",
  // The load-bearing containment: `sandbox allow-scripts` (NO allow-same-origin)
  // forces an opaque origin even on top-level navigation. Scripts execute; the
  // document cannot reach same-origin state (document.cookie / session).
  'sandbox allow-scripts',
];

/**
 * Security headers applied to preview responses that serve an inline
 * `type:'preview'` panel's `content` as active HTML. Unlike file serving, these
 * bytes are MEANT to run — so we keep scripting and instead force an opaque
 * origin via `sandbox allow-scripts` (no allow-same-origin). See the §3¾ note.
 */
export function previewServingHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Embedder-Policy': 'unsafe-none',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'Content-Security-Policy': PREVIEW_CSP_SOURCE_DIRECTIVES.join('; '),
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
