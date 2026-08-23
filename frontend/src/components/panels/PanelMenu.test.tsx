import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelMenu } from './PanelMenu';
import type { WorkspacePanel } from '../../types';

function makeProps(panel: WorkspacePanel, overrides: Partial<Parameters<typeof PanelMenu>[0]> = {}) {
  return {
    panel,
    workspaceId: 'ws1',
    maximizedPanelId: null,
    onAskAboutTile: vi.fn(),
    onRevealFile: vi.fn(),
    onPanelDownload: vi.fn(),
    onCloseMenu: vi.fn(),
    onMinimize: vi.fn(),
    onMaximize: vi.fn(),
    onSetContextualChatTarget: vi.fn(),
    onClearContextualDraft: vi.fn(),
    onSetMaximizedPanelId: vi.fn(),
    onRemovePanel: vi.fn(),
    ...overrides,
  };
}

const tablePanel: Extract<WorkspacePanel, { type: 'table' }> = { id: 'p1', type: 'table', columns: [], rows: [] };
const filePanel: Extract<WorkspacePanel, { type: 'editor' }> = { id: 'p2', type: 'editor', filePath: 'doc.md' };
const cardsPanel: Extract<WorkspacePanel, { type: 'cards' }> = {
  id: 'p3',
  type: 'cards',
  title: 'Cards',
  items: [{ id: 'card-1', title: 'Finding', badge: 'New', metadata: { Source: 'Paper' } }],
};

describe('PanelMenu', () => {
  it('always offers ask/minimize/maximize/remove', () => {
    render(<PanelMenu {...makeProps(tablePanel)} />);
    expect(screen.getByRole('menuitem', { name: 'Ask about this tile' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Minimize' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument();
  });

  it('offers CSV and JSON export for tables', () => {
    render(<PanelMenu {...makeProps(tablePanel)} />);
    expect(screen.getByRole('menuitem', { name: 'Export as CSV' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Export as JSON' })).toBeInTheDocument();
  });

  it('offers file actions only for file-backed panels', () => {
    render(<PanelMenu {...makeProps(filePanel)} />);
    expect(screen.getByRole('menuitem', { name: 'Show in workspace files' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open in a new tab' })).toBeInTheDocument();
  });

  it('does not show file actions for a non-file panel', () => {
    render(<PanelMenu {...makeProps(tablePanel)} />);
    expect(screen.queryByRole('menuitem', { name: 'Show in workspace files' })).toBeNull();
  });

  it('offers PNG capture and JSON export for cards with metadata', async () => {
    const onPanelDownload = vi.fn();
    const user = userEvent.setup();
    render(<PanelMenu {...makeProps(cardsPanel, { onPanelDownload })} />);

    await user.click(screen.getByRole('menuitem', { name: 'Save as image (PNG)' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export as JSON' }));

    expect(onPanelDownload).toHaveBeenNthCalledWith(1, cardsPanel, 'png');
    expect(onPanelDownload).toHaveBeenNthCalledWith(2, cardsPanel, 'json');
  });

  it('closes the menu after asking about the tile', async () => {
    const onAskAboutTile = vi.fn();
    const onCloseMenu = vi.fn();
    const user = userEvent.setup();
    render(<PanelMenu {...makeProps(tablePanel, { onAskAboutTile, onCloseMenu })} />);
    await user.click(screen.getByRole('menuitem', { name: 'Ask about this tile' }));
    expect(onAskAboutTile).toHaveBeenCalledWith('p1');
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('minimizes and clears contextual draft together', async () => {
    const onMinimize = vi.fn();
    const onClearContextualDraft = vi.fn();
    const user = userEvent.setup();
    render(<PanelMenu {...makeProps(tablePanel, { onMinimize, onClearContextualDraft })} />);
    await user.click(screen.getByRole('menuitem', { name: 'Minimize' }));
    expect(onMinimize).toHaveBeenCalledWith('p1');
    expect(onClearContextualDraft).toHaveBeenCalledOnce();
  });
});
