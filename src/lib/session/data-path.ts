import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || 'data';

export function getUserDataPath(sessionId: string): string {
  // Validate session ID format to prevent path traversal (32-char hex string)
  if (!/^[a-f0-9]+$/.test(sessionId) || sessionId.length !== 32) {
    throw new Error('Invalid session ID');
  }

  return join(process.cwd(), DATA_DIR, 'users', sessionId);
}
