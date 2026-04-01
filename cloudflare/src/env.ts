import type { WorkspaceAgent } from './agent/workspace-agent';

export interface Env {
  ASSETS: Fetcher;
  LOADER: WorkerLoader;
  WorkspaceAgent: DurableObjectNamespace<WorkspaceAgent>;
  WORKSPACE_FILES: R2Bucket;
  SESSION_SECRET: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL?: string;
  GIT_AUTH_TOKEN?: string;
  R2_PUBLIC_DOMAIN?: string;
  WORKER_SUBDOMAIN?: string;
}
