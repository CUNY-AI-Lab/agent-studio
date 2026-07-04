import type { WorkspaceAgent } from './agent/workspace-agent';

export interface Env {
  ASSETS: Fetcher;
  LOADER: WorkerLoader;
  WorkspaceAgent: DurableObjectNamespace<WorkspaceAgent>;
  WORKSPACE_FILES: R2Bucket;
  SESSION_SECRET: string;
  // CAIL backbone: model calls go through the CAIL model proxy, never a
  // provider key. See src/lib/cail-model.ts and src/lib/cail-identity.ts.
  CAIL_API_BASE?: string;
  CAIL_MODEL?: string;
  CAIL_IDENTITY_JWT_SECRET?: string;
  CAIL_REQUIRE_IDENTITY?: string;
  GIT_AUTH_TOKEN?: string;
  R2_PUBLIC_DOMAIN?: string;
  WORKER_SUBDOMAIN?: string;
}
