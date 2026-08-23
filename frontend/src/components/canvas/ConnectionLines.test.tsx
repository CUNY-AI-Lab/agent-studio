import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionLines } from './ConnectionLines';

const panelLayouts = {
  source: { x: 0, y: 0, width: 240, height: 160 },
  target: { x: 360, y: 80, width: 240, height: 160 },
};
const connection = { id: 'connection-source-target', sourceId: 'source', targetId: 'target' };

describe('ConnectionLines', () => {
  it('exposes a persisted association as an inspectable, keyboard-activatable line', async () => {
    const user = userEvent.setup();
    const onConnectionClick = vi.fn();
    const { container } = render(
      <ConnectionLines
        panelLayouts={panelLayouts}
        connections={[connection]}
        panelTitles={{ source: 'Research cards', target: 'Summary' }}
        onConnectionClick={onConnectionClick}
      />
    );

    const line = screen.getByRole('button', { name: 'Association between Research cards and Summary' });
    expect(line).toHaveAttribute('tabindex', '0');
    expect(container.querySelector('title')?.textContent).toContain('Association: Research cards ↔ Summary');

    await user.click(line);
    expect(onConnectionClick).toHaveBeenCalledWith(connection);
    line.focus();
    expect(line).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onConnectionClick).toHaveBeenCalledTimes(2);
  });

  it('highlights an association when its two tiles are selected', () => {
    const { container } = render(
      <ConnectionLines
        panelLayouts={panelLayouts}
        connections={[connection]}
        selectedConnectionIds={new Set([connection.id])}
      />
    );

    expect(container.querySelector('.connection-line')).toHaveAttribute('stroke-width', '3');
  });
});
