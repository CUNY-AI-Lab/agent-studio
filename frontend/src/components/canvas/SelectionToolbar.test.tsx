import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectionToolbar } from './SelectionToolbar';

const bounds = { x: 100, y: 100, width: 300, height: 200 };

function makeProps(overrides: Partial<Parameters<typeof SelectionToolbar>[0]> = {}) {
  return {
    selectedPanelId: 'p1',
    selectedPanelIds: new Set(['p1']),
    panelTitle: 'Revenue',
    selectionBounds: bounds,
    canvasScale: 1,
    viewportOffset: { x: 0, y: 0 },
    viewportSize: { width: 1200, height: 800 },
    ...overrides,
  };
}

describe('SelectionToolbar accessibility', () => {
  it('renders a labeled toolbar landmark', () => {
    render(<SelectionToolbar {...makeProps({ onChat: vi.fn() })} />);
    expect(screen.getByRole('toolbar', { name: 'Actions for Revenue' })).toBeInTheDocument();
  });

  it('gives the chat action an accessible name (not just a title)', () => {
    render(<SelectionToolbar {...makeProps({ onChat: vi.fn() })} />);
    expect(screen.getByRole('button', { name: 'Chat about Revenue' })).toBeInTheDocument();
  });

  it('labels the icon-only remove button', () => {
    render(<SelectionToolbar {...makeProps({ onRemove: vi.fn() })} />);
    expect(screen.getByRole('button', { name: 'Remove tile' })).toBeInTheDocument();
  });

  it('labels the minimize and maximize icon buttons', () => {
    render(<SelectionToolbar {...makeProps({ onMinimize: vi.fn(), onMaximize: vi.fn() })} />);
    expect(screen.getByRole('button', { name: 'Minimize tile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize tile' })).toBeInTheDocument();
  });

  it('marks the download trigger with popup semantics and exposes a menu when open', async () => {
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectionToolbar
        {...makeProps({ canDownload: true, downloadFormats: ['csv', 'json'], onDownload })}
      />
    );
    const trigger = screen.getByRole('button', { name: 'Download or export' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Download formats' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeInTheDocument();
  });
});
