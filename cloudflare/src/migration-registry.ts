/**
 * MigrationRegistry: one Durable Object instance per ANONYMOUS session id,
 * serializing first-login migration claims for that namespace. Durable
 * Objects process requests for a given name one at a time, which is what
 * makes claim-once and no-double-migrate actually atomic — R2 alone has no
 * compare-and-swap for this. The claim record is sticky: the first verified
 * subject to claim an anonymous namespace owns it forever (see
 * lib/migration.ts decideClaim).
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { decideClaim, type ClaimAction, type MigrationClaim } from './lib/migration';

const CLAIM_KEY = 'claim';
const ACTIVE_REQUESTS_KEY = 'active-anonymous-requests:v1';
const REQUEST_LEASE_STALE_MS = 10 * 60 * 1000;

type ActiveAnonymousRequests = Record<string, number>;

export class MigrationRegistry extends DurableObject<Env> {
  private async activeRequests(now = Date.now()): Promise<ActiveAnonymousRequests> {
    const stored = await this.ctx.storage.get<ActiveAnonymousRequests>(ACTIVE_REQUESTS_KEY) ?? {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, startedAt]) =>
        Number.isFinite(startedAt) && now - startedAt < REQUEST_LEASE_STALE_MS)
    );
  }

  /**
   * Atomically admit an anonymous request only while the namespace is
   * unclaimed. The durable lease closes the create/import-vs-migration race:
   * claim() cannot begin until every admitted request has released.
   */
  async beginAnonymousRequest(requestId: string): Promise<boolean> {
    if (await this.ctx.storage.get<MigrationClaim>(CLAIM_KEY)) return false;
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

  async claim(subjectSessionId: string): Promise<ClaimAction> {
    const active = await this.activeRequests();
    if (Object.keys(active).length > 0) {
      await this.ctx.storage.put(ACTIVE_REQUESTS_KEY, active);
      return 'anonymous-active';
    }
    await this.ctx.storage.delete(ACTIVE_REQUESTS_KEY);
    const existing = await this.ctx.storage.get<MigrationClaim>(CLAIM_KEY);
    const decision = decideClaim(existing, subjectSessionId, Date.now());
    if (decision.record) {
      await this.ctx.storage.put(CLAIM_KEY, decision.record);
    }
    return decision.action;
  }

  async markDone(subjectSessionId: string): Promise<void> {
    const existing = await this.ctx.storage.get<MigrationClaim>(CLAIM_KEY);
    if (!existing || existing.subjectSessionId !== subjectSessionId) return;
    await this.ctx.storage.put(CLAIM_KEY, {
      ...existing,
      status: 'done',
      completedAt: Date.now(),
    } satisfies MigrationClaim);
  }

  async markFailed(subjectSessionId: string): Promise<void> {
    const existing = await this.ctx.storage.get<MigrationClaim>(CLAIM_KEY);
    if (!existing || existing.subjectSessionId !== subjectSessionId) return;
    if (existing.status === 'done') return;
    await this.ctx.storage.put(CLAIM_KEY, {
      ...existing,
      status: 'failed',
    } satisfies MigrationClaim);
  }

  async getClaim(): Promise<MigrationClaim | undefined> {
    return this.ctx.storage.get<MigrationClaim>(CLAIM_KEY);
  }
}
