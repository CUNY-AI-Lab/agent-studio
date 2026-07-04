import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs vitest with jsdom', () => {
    const el = document.createElement('div');
    el.textContent = 'ready';
    document.body.append(el);
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('ready');
    el.remove();
  });
});
