import { WorkerEntrypoint } from 'cloudflare:workers';
import { validateAgentStudioConfig, type Env } from '../env';

export interface AgentStudioReadinessResult {
  ok: boolean;
  service: 'agent-studio';
  configuration: 'ready' | 'not_ready';
  version_id: string | null;
  tag: string | null;
}

/**
 * Private release-boundary capability. This export has no HTTP route; callers
 * must use a named WorkerEntrypoint service binding. It reports only the
 * deployed version metadata and whether the same production configuration
 * used by /health is valid.
 */
export class AgentStudioReadiness extends WorkerEntrypoint<Env> {
  async getReadiness(): Promise<AgentStudioReadinessResult> {
    const configuration = await validateAgentStudioConfig(this.env);
    const metadata = this.env.CF_VERSION_METADATA;
    const versionId = metadata?.id?.trim() || null;
    const tag = metadata?.tag?.trim() || null;

    return {
      ok: configuration.ok && versionId !== null && tag !== null,
      service: 'agent-studio',
      configuration: configuration.ok ? 'ready' : 'not_ready',
      version_id: versionId,
      tag,
    };
  }
}
