import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupBoundary } from './GroupBoundary';

const layouts = {
  a: { x: 0, y: 0, width: 200, height: 150 },
  b: { x: 300, y: 0, width: 200, height: 150 },
};

function makeProps(overrides: Partial<Parameters<typeof GroupBoundary>[0]> = {}) {
  return {
    group: { id: 'g1', name: 'Reports', panelIds: ['a', 'b'] },
    panelLayouts: layouts,
    existingPanelIds: new Set(['a', 'b']),
    visiblePanelIds: new Set(['a', 'b']),
    scale: 1,
    ...overrides,
  };
}

function getGroup() {
  return screen.getByRole('group', { name: 'Reports group' });
}

describe('GroupBoundary keyboard interaction', () => {
  it('renders as a labeled, focusable group', () => {
    render(<GroupBoundary {...makeProps()} />);
    expect(getGroup()).toHaveAttribute('tabindex', '0');
  });

  it('selects the group on Enter', async () => {
    const onGroupClick = vi.fn();
    const user = userEvent.setup();
    render(<GroupBoundary {...makeProps({ onGroupClick })} />);
    getGroup().focus();
    await user.keyboard('{Enter}');
    expect(onGroupClick).toHaveBeenCalledWith('g1');
  });

  it('drags the group by a step on arrow keys and commits', async () => {
    const onGroupDrag = vi.fn();
    const onGroupDragEnd = vi.fn();
    const user = userEvent.setup();
    render(<GroupBoundary {...makeProps({ onGroupDrag, onGroupDragEnd })} />);
    getGroup().focus();
    await user.keyboard('{ArrowRight}');
    expect(onGroupDrag).toHaveBeenCalledWith('g1', 16, 0);
    expect(onGroupDragEnd).toHaveBeenCalledWith('g1');
  });

  it('starts rename on F2', async () => {
    const onEditStart = vi.fn();
    const user = userEvent.setup();
    render(<GroupBoundary {...makeProps({ onEditStart })} />);
    getGroup().focus();
    await user.keyboard('{F2}');
    expect(onEditStart).toHaveBeenCalledWith('g1');
  });

  it('labels the rename input', () => {
    render(<GroupBoundary {...makeProps({ isEditing: true, editValue: 'Reports' })} />);
    expect(screen.getByRole('textbox', { name: 'Group name' })).toBeInTheDocument();
  });
});
