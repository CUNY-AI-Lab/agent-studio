import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextualChatPopover } from './ContextualChatPopover';

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

function renderPopover(zoom: number) {
  return render(
    <ContextualChatPopover
      anchor={{ x: 100, y: 200, width: 300, height: 200 }}
      viewport={{ x: 40, y: 30, zoom }}
      viewportSize={{ width: 1200, height: 800 }}
      title="Revenue"
      typeLabel="Markdown"
      input=""
      onInputChange={vi.fn()}
      onSubmit={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe('ContextualChatPopover viewport positioning', () => {
  it.each([
    { zoom: 0.35, left: 192, top: 100, placement: 'right' },
    { zoom: 1, left: 452, top: 230, placement: 'right' },
    { zoom: 2.5, left: 290, top: 488, placement: 'bottom' },
  ])('keeps a fixed-size screen overlay at zoom $zoom', ({ zoom, left, top, placement }) => {
    renderPopover(zoom);

    const popover = screen.getByRole('dialog', { name: 'Ask about Revenue' });
    expect(Number.parseFloat(popover.style.left)).toBeCloseTo(left);
    expect(Number.parseFloat(popover.style.top)).toBeCloseTo(top);
    expect(popover).toHaveStyle({
      width: '280px',
      transform: 'none',
    });
    expect(popover.className).toContain(`origin-${placement === 'right' ? 'left' : placement === 'left' ? 'right' : 'top'}`);
  });
});
