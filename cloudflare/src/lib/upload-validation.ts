// Upload type validation, ported from the legacy app's upload allowlist.
// Extension is the primary gate; the browser-supplied MIME type is checked
// when present but a missing/generic type doesn't reject a valid extension.

const ALLOWED_UPLOAD_TYPES = new Set([
  // Documents
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  // Spreadsheets
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Data
  'application/xml',
  'text/xml',
]);

const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.txt', '.csv', '.md', '.json',
  '.xlsx', '.xls',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.xml',
]);

export type UploadFileLike = { name: string; type?: string };

export function isAllowedUpload(file: UploadFileLike): { allowed: boolean; reason?: string } {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `File extension '${ext || '(none)'}' not allowed` };
  }

  if (file.type && !ALLOWED_UPLOAD_TYPES.has(file.type)) {
    if (file.type !== 'application/octet-stream') {
      return { allowed: false, reason: `File type '${file.type}' not allowed` };
    }
  }

  return { allowed: true };
}
