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

export class MigrationRegistry extends DurableObject<Env> {
  async claim(subjectSessionId: string): Promise<ClaimAction> {
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
