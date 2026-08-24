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

  it('exposes an explicit association action for a two-tile selection', async () => {
    const onToggleConnection = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectionToolbar
        {...makeProps({
          selectedPanelId: null,
          selectedPanelIds: new Set(['p1', 'p2']),
          onToggleConnection,
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Associate selected tiles' }));
    expect(onToggleConnection).toHaveBeenCalledOnce();
  });

  it('turns the association action into a disconnect action when linked', () => {
    render(
      <SelectionToolbar
        {...makeProps({
          selectedPanelId: null,
          selectedPanelIds: new Set(['p1', 'p2']),
          onToggleConnection: vi.fn(),
          isConnected: true,
        })}
      />
    );

    expect(screen.getByRole('button', { name: 'Disconnect selected tiles' })).toBeInTheDocument();
  });

  it.each([
    { canvasScale: 0.35, left: 127.5, top: 56 },
    { canvasScale: 1, left: 290, top: 186 },
    { canvasScale: 2.5, left: 665, top: 486 },
  ])('keeps its screen position and transform fixed at zoom $canvasScale', ({ canvasScale, left, top }) => {
    render(
      <SelectionToolbar
        {...makeProps({
          canvasScale,
          selectionBounds: { x: 100, y: 200, width: 300, height: 200 },
          viewportOffset: { x: 40, y: 30 },
        })}
      />,
    );

    const toolbar = screen.getByRole('toolbar');
    expect(Number.parseFloat(toolbar.style.left)).toBeCloseTo(left);
    expect(Number.parseFloat(toolbar.style.top)).toBeCloseTo(top);
    expect(toolbar).toHaveStyle({
      transform: 'translateX(-50%)',
      transformOrigin: 'top center',
    });
  });

  it('uses the toolbar’s intrinsic size when clamping its screen position', () => {
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 380 });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 48 });

    try {
      render(
        <SelectionToolbar
          {...makeProps({
            selectionBounds: { x: 1000, y: 100, width: 300, height: 200 },
            viewportSize: { width: 1200, height: 800 },
          })}
        />,
      );

      const toolbar = screen.getByRole('toolbar');
      expect(Number.parseFloat(toolbar.style.left)).toBeCloseTo(1002);
      expect(Number.parseFloat(toolbar.style.top)).toBeCloseTo(44);
    } finally {
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
      if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDescriptor);
    }
  });
});
