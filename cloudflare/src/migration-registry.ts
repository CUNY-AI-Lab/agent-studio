import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

const CLAIM_KEY = 'claim';
const ACTIVE_REQUESTS_KEY = 'active-anonymous-requests:v1';
const STALE_LEASE_MS = 10 * 60 * 1000;

export type ImportClaim = {
  subjectSessionId: string;
  status: 'in-progress' | 'done' | 'failed';
  startedAt: number;
};

export type ImportClaimAction =
  | 'run'
  | 'already-done'
  | 'in-progress'
  | 'claimed-by-other'
  | 'anonymous-active';

type ActiveRequests = Record<string, number>;

/**
 * One tiny lock object per legacy cookie namespace. It serializes the cutover
 * with already-admitted anonymous requests and makes the first verified
 * subject claim sticky. User content remains in WorkspaceAgent and R2.
 */
export class MigrationRegistry extends DurableObject<Env> {
  private async activeRequests(now = Date.now()): Promise<ActiveRequests> {
    const stored = await this.ctx.storage.get<ActiveRequests>(ACTIVE_REQUESTS_KEY) ?? {};
    return Object.fromEntries(Object.entries(stored).filter(([, startedAt]) =>
      Number.isFinite(startedAt) && now - startedAt < STALE_LEASE_MS));
  }

  async beginAnonymousRequest(requestId: string): Promise<boolean> {
    if (await this.ctx.storage.get<ImportClaim>(CLAIM_KEY)) return false;
    const active = await this.activeRequests();
    active[requestId] = Date.now();
    await this.ctx.storage.put(ACTIVE_REQUESTS_KEY, active);
    return true;
  }

  async endAnonymousRequest(requestId: string): Promise<void> {
    const active = await this.activeRequests();
    delete active[requestId];
    if (Object.keys(active).length === 0) {
      await this.ctx.storage.delete(ACTIVE_REQUESTS_KEY);
    } else {
      await this.ctx.storage.put(ACTIVE_REQUESTS_KEY, active);
    }
  }

  async claim(subjectSessionId: string): Promise<ImportClaimAction> {
    const active = await this.activeRequests();
    if (Object.keys(active).length > 0) {
      await this.ctx.storage.put(ACTIVE_REQUESTS_KEY, active);
      return 'anonymous-active';
    }
    await this.ctx.storage.delete(ACTIVE_REQUESTS_KEY);

    const now = Date.now();
    const existing = await this.ctx.storage.get<ImportClaim>(CLAIM_KEY);
    if (!existing) {
      await this.ctx.storage.put(CLAIM_KEY, {
        subjectSessionId,
        status: 'in-progress',
        startedAt: now,
      } satisfies ImportClaim);
      return 'run';
    }
    if (existing.subjectSessionId !== subjectSessionId) return 'claimed-by-other';
    if (existing.status === 'done') return 'already-done';
    if (existing.status === 'in-progress' && now - existing.startedAt < STALE_LEASE_MS) {
      return 'in-progress';
    }
    await this.ctx.storage.put(CLAIM_KEY, {
      subjectSessionId,
      status: 'in-progress',
      startedAt: now,
    } satisfies ImportClaim);
    return 'run';
  }

  async markDone(subjectSessionId: string): Promise<void> {
    const existing = await this.ctx.storage.get<ImportClaim>(CLAIM_KEY);
    if (!existing || existing.subjectSessionId !== subjectSessionId) return;
    await this.ctx.storage.put(CLAIM_KEY, { ...existing, status: 'done' });
  }

  async markFailed(subjectSessionId: string): Promise<void> {
    const existing = await this.ctx.storage.get<ImportClaim>(CLAIM_KEY);
    if (!existing || existing.subjectSessionId !== subjectSessionId || existing.status === 'done') {
      return;
    }
    await this.ctx.storage.put(CLAIM_KEY, { ...existing, status: 'failed' });
  }
}
