import { describe, expect, it } from 'vitest';
import { buildChartStyleText } from './chart';

describe('chart style generation', () => {
  it('emits bounded chart variables and rejects CSS/HTML injection keys and colors', () => {
    const css = buildChartStyleText('chart-safe', {
      series: { color: '#6366f1' },
      ['x};</style><script>alert(1)</script>']: { color: 'red' },
      poisoned: { color: '#fff; background:url(https://evil.example)' },
    });
    expect(css).toContain('--color-series: #6366f1');
    expect(css).not.toContain('script');
    expect(css).not.toContain('evil.example');
  });
});
