import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DraggablePanel } from './DraggablePanel';

const baseLayout = { x: 100, y: 100, width: 300, height: 200 };

function makeProps(overrides: Partial<Parameters<typeof DraggablePanel>[0]> = {}) {
  return {
    id: 'p1',
    layout: baseLayout,
    title: 'Sales Report',
    type: 'Table',
    scale: 1,
    onLayoutChange: vi.fn(),
    onDragEnd: vi.fn(),
    children: <div>body</div>,
    ...overrides,
  };
}

function getTile() {
  return screen.getByRole('group', { name: 'Sales Report (Table tile)' });
}

describe('DraggablePanel keyboard interaction', () => {
  it('exposes the tile as a labeled, focusable group', () => {
    render(<DraggablePanel {...makeProps()} />);
    const tile = getTile();
    expect(tile).toHaveAttribute('tabindex', '0');
  });

  it('is removed from the tab order when it is not the roving target', () => {
    render(<DraggablePanel {...makeProps({ isFocusTarget: false })} />);
    expect(getTile()).toHaveAttribute('tabindex', '-1');
  });

  it('moves the panel by the default step on ArrowRight', async () => {
    const onLayoutChange = vi.fn();
    const onDragEnd = vi.fn();
    const user = userEvent.setup();
    render(<DraggablePanel {...makeProps({ onLayoutChange, onDragEnd })} />);
    getTile().focus();
    await user.keyboard('{ArrowRight}');
    expect(onLayoutChange).toHaveBeenCalledWith('p1', { x: 116, y: 100 });
    expect(onDragEnd).toHaveBeenCalledWith('p1');
  });

  it('uses the large step when Shift is held', async () => {
    const onLayoutChange = vi.fn();
    const user = userEvent.setup();
    render(<DraggablePanel {...makeProps({ onLayoutChange })} />);
    getTile().focus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(onLayoutChange).toHaveBeenCalledWith('p1', { x: 100, y: 164 });
  });

  it('resizes instead of moving when Alt is held', async () => {
    const onLayoutChange = vi.fn();
    const user = userEvent.setup();
    render(<DraggablePanel {...makeProps({ onLayoutChange })} />);
    getTile().focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(onLayoutChange).toHaveBeenCalledWith('p1', { width: 316, height: 200 });
  });

  it('does not shrink below the minimum size when resizing down with Alt', async () => {
    const onLayoutChange = vi.fn();
    const user = userEvent.setup();
    render(
      <DraggablePanel
        {...makeProps({ onLayoutChange, layout: { x: 0, y: 0, width: 200, height: 150 } })}
      />
    );
    getTile().focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(onLayoutChange).toHaveBeenCalledWith('p1', { width: 200, height: 150 });
  });

  it('toggles selection on Enter', async () => {
    const onKeyboardSelect = vi.fn();
    const user = userEvent.setup();
    render(<DraggablePanel {...makeProps({ onKeyboardSelect })} />);
    getTile().focus();
    await user.keyboard('{Enter}');
    expect(onKeyboardSelect).toHaveBeenCalledWith('p1', false);
  });

  it('does an additive selection with Enter + modifier', async () => {
    const onKeyboardSelect = vi.fn();
    const user = userEvent.setup();
    render(<DraggablePanel {...makeProps({ onKeyboardSelect })} />);
    getTile().focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onKeyboardSelect).toHaveBeenCalledWith('p1', true);
  });

  it('opens the tile menu with the "m" shortcut', async () => {
    const onOpenMenu = vi.fn();
    const user = userEvent.setup();
    render(
      <DraggablePanel
        {...makeProps({ onOpenMenu, menuContent: <div>menu</div>, isMenuOpen: false })}
      />
    );
    getTile().focus();
    await user.keyboard('m');
    expect(onOpenMenu).toHaveBeenCalledWith('p1');
  });

  it('exposes the menu trigger as a real button with popup semantics', () => {
    render(
      <DraggablePanel
        {...makeProps({ onOpenMenu: vi.fn(), menuContent: <div>menu</div>, isMenuOpen: false })}
      />
    );
    const trigger = screen.getByRole('button', { name: 'Open menu for Sales Report' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders the open menu as a menu region', () => {
    render(
      <DraggablePanel
        {...makeProps({ onOpenMenu: vi.fn(), menuContent: <div>items</div>, isMenuOpen: true })}
      />
    );
    expect(screen.getByRole('menu', { name: 'Actions for Sales Report' })).toBeInTheDocument();
  });

  it('reflects selection through aria-pressed', () => {
    const { rerender } = render(<DraggablePanel {...makeProps({ isSelected: false })} />);
    expect(getTile()).toHaveAttribute('aria-pressed', 'false');
    rerender(<DraggablePanel {...makeProps({ isSelected: true })} />);
    expect(getTile()).toHaveAttribute('aria-pressed', 'true');
  });
});
