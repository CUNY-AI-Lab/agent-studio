import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

const LOG_DIR = process.env.AUDIT_LOG_DIR || join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'audit.log');

export type AuditAction =
  | 'workspace.create'
  | 'workspace.delete'
  | 'workspace.query'
  | 'workspace.publish'
  | 'workspace.unpublish'
  | 'file.upload'
  | 'file.delete'
  | 'auth.session_created'
  | 'security.csrf_failure'
  | 'security.validation_failure';

interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  sessionId?: string;
  workspaceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

let logDirCreated = false;

async function ensureLogDir(): Promise<void> {
  if (logDirCreated) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    logDirCreated = true;
  } catch {
    // Directory might already exist
    logDirCreated = true;
  }
}

export async function audit(
  action: AuditAction,
  options: {
    sessionId?: string;
    workspaceId?: string;
    details?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  } = {}
): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    action,
    ...options,
  };

  // Always log to console in development
  if (process.env.NODE_ENV !== 'production') {
    console.log('[AUDIT]', JSON.stringify(entry));
  }

  // Write to file
  try {
    await ensureLogDir();
    await appendFile(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (error) {
    console.error('[AUDIT] Failed to write audit log:', error);
  }
}

// Helper to extract request metadata
export function getRequestMeta(request: Request): { ip?: string; userAgent?: string } {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || undefined;
  const userAgent = request.headers.get('user-agent') || undefined;
  return { ip, userAgent };
}
