import type { Env } from '../env';
import { updateWorkspaceWithRetry } from './workspaces';

// One-time stored-selection migration, verified against Gateway's native inventory
// and canonical catalog on 2026-09-09. Preserve every suffix: variants are distinct.
// These IDs are never accepted as new selections or sent to inference.
const legacyModelIds = new Map([
  ['@cf/aisingapore/gemma-sea-lion-v4-27b-it', 'gemma-sea-lion-v4-27b-it'],
  ['@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'deepseek-r1-distill-qwen-32b'],
  ['@cf/deepseek-ai/deepseek-v4-flash-0731', 'deepseek-v4-flash-0731'],
  ['@cf/deepseek-ai/deepseek-v4-pro-0813', 'deepseek-v4-pro-0813'],
  ['@cf/google/gemma-2b-it-lora', 'gemma-2b-it-lora'],
  ['@cf/google/gemma-4-26b-a4b-it', 'gemma-4-26b-a4b-it'],
  ['@cf/google/gemma-7b-it-lora', 'gemma-7b-it-lora'],
  ['@cf/meta-llama/llama-2-7b-chat-hf-lora', 'llama-2-7b-chat-hf-lora'],
  ['@cf/meta/llama-3.1-8b-instruct-fp8', 'llama-3.1-8b-instruct-fp8'],
  ['@cf/meta/llama-3.2-11b-vision-instruct', 'llama-3.2-11b-vision-instruct'],
  ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'llama-3.3-70b-instruct-fp8-fast'],
  ['@cf/meta/llama-4-scout-17b-16e-instruct', 'llama-4-scout-17b-16e-instruct'],
  ['@cf/meta/llama-guard-3-8b', 'llama-guard-3-8b'],
  ['@cf/mistral/mistral-7b-instruct-v0.2-lora', 'mistral-7b-instruct-v0.2-lora'],
  ['@cf/moonshotai/kimi-k2.6', 'kimi-k2.6'],
  ['@cf/moonshotai/kimi-k2.7-code', 'kimi-k2.7-code'],
  ['@cf/nvidia/nemotron-3-120b-a12b', 'nemotron-3-120b-a12b'],
  ['@cf/openai/gpt-oss-120b', 'gpt-oss-120b'],
  ['@cf/openai/gpt-oss-20b', 'gpt-oss-20b'],
  ['@cf/openai/whisper', 'whisper'],
  ['@cf/openai/whisper-large-v3-turbo', 'whisper-large-v3-turbo'],
  ['@cf/openai/whisper-tiny-en', 'whisper-tiny-en'],
  ['@cf/qwen/qwen2.5-coder-32b-instruct', 'qwen2.5-coder-32b-instruct'],
  ['@cf/qwen/qwen3-30b-a3b-fp8', 'qwen3-30b-a3b-fp8'],
  ['@cf/qwen/qwen3.8-27b', 'qwen3.8-27b'],
  ['@cf/qwen/qwq-32b', 'qwq-32b'],
  ['@cf/zai-org/glm-4.7-flash', 'glm-4.7-flash'],
  ['@cf/zai-org/glm-5.2', 'glm-5.2'],
  ['@cf/zai-org/glm-5.3-flash', 'glm-5.3-flash'],
]);

export function migratedModelId(modelId: string): string | undefined {
  return legacyModelIds.get(modelId);
}

export async function migrateWorkspaceModel(
  env: Env,
  sessionId: string,
  workspaceId: string,
) {
  return updateWorkspaceWithRetry(env, sessionId, workspaceId, (current) => {
    const canonical = current.model ? migratedModelId(current.model) : undefined;
    if (!canonical || current.deleting) return null;
    return { ...current, model: canonical };
  });
}
