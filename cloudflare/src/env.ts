import type { WorkspaceAgent } from './agent/workspace-agent';
import type { MigrationRegistry } from './migration-registry';

export interface Env {
  ASSETS: Fetcher;
  LOADER: WorkerLoader;
  WorkspaceAgent: DurableObjectNamespace<WorkspaceAgent>;
  MIGRATION_REGISTRY: DurableObjectNamespace<MigrationRegistry>;
  WORKSPACE_FILES: R2Bucket;
  SESSION_SECRET: string;
  // CAIL backbone: model calls go through the CAIL model proxy, never a
  // provider key. See src/lib/cail-model.ts and src/lib/cail-identity.ts.
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
  CAIL_IDENTITY_JWT_SECRET?: string;
  CAIL_REQUIRE_IDENTITY?: string;
  GIT_AUTH_TOKEN?: string;
  // CUNY Primo (Ex Libris) search API. When configured, web_fetch attaches
  // apikey/vid/scope server-side for the Primo host — the key never enters
  // model context. All optional; Primo search is simply unavailable without.
  PRIMO_API_BASE?: string;
  PRIMO_API_KEY?: string;
  PRIMO_VID?: string;
  PRIMO_SCOPE?: string;
}
