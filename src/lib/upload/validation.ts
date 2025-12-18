// Upload validation helpers factored from the API route for unit testing

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per file (kept here for centralization if needed)

// Allowed file types (MIME types and extensions)
export const ALLOWED_TYPES = new Set([
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

export const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.txt', '.csv', '.md', '.json',
  '.xlsx', '.xls',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.xml',
]);

export function sanitizeFilename(filename: string): string {
  // Get extension
  const lastDot = filename.lastIndexOf('.');
  const ext = lastDot > 0 ? filename.slice(lastDot).toLowerCase() : '';
  const name = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  // Sanitize name: only allow alphanumeric, dash, underscore
  const safeName = name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100); // Limit length

  return safeName + ext;
}

export type UploadFileLike = { name: string; type?: string; size: number };

export function isAllowedFile(file: UploadFileLike): { allowed: boolean; reason?: string } {
  // Check extension
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `File extension '${ext || '(none)'}' not allowed` };
  }

  // Check MIME type (if provided)
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    // Allow if extension is valid but MIME is missing/generic
    if (file.type !== 'application/octet-stream' && file.type !== '') {
      return { allowed: false, reason: `File type '${file.type}' not allowed` };
    }
  }

  return { allowed: true };
}

