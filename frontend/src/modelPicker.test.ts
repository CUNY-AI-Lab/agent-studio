import { describe, expect, it } from 'vitest';
import { buildModelPickerView, type ModelCatalog } from './api';

const catalog: ModelCatalog = {
  default: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  models: [
    {
      id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
      recommended: true,
      tier: 'recommended',
      status: 'active',
      sunset: null,
      capabilities: ['text-generation', 'function-calling', 'reasoning'],
      contextLength: null,
      registryUrl: null,
      name: 'DeepSeek V4 Flash 0731',
      description: null,
    },
  ],
};

describe('buildModelPickerView', () => {
  it('offers the function-capable DeepSeek 0731 model from the server-filtered catalog', () => {
    const view = buildModelPickerView(catalog, undefined);

    expect(view.recommended.map((option) => option.id)).toEqual([
      '@cf/deepseek-ai/deepseek-v4-flash-0731',
    ]);
    expect(view.advanced).toEqual([]);
    expect(view.unsupportedEffectiveModel).toBeNull();
  });

  it('shows a stored override absent from the server catalog as unavailable without falling back', () => {
    const view = buildModelPickerView(catalog, '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');

    expect(view.effectiveModel).toBe('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');
    expect(view.unsupportedEffectiveModel).toBe('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');
    expect(view.recommended.map((option) => option.id)).toEqual([
      '@cf/deepseek-ai/deepseek-v4-flash-0731',
    ]);
  });
});
