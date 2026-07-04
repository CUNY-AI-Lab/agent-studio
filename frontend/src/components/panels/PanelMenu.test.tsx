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

const tablePanel = { id: 'p1', type: 'table', columns: [], rows: [] } as WorkspacePanel;
const filePanel = { id: 'p2', type: 'editor', filePath: 'doc.md' } as WorkspacePanel;

describe('PanelMenu', () => {
  it('always offers ask/minimize/maximize/remove', () => {
    render(<PanelMenu {...makeProps(tablePanel)} />);
    expect(screen.getByRole('button', { name: 'Ask About This Tile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('offers CSV and JSON export for tables', () => {
    render(<PanelMenu {...makeProps(tablePanel)} />);
    expect(screen.getByRole('button', { name: 'Export Data as CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Data as JSON' })).toBeInTheDocument();
  });

  it('offers file actions only for file-backed panels', () => {
    render(<PanelMenu {...makeProps(filePanel)} />);
    expect(screen.getByRole('button', { name: 'Show in Workspace Files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in New Tab' })).toBeInTheDocument();
  });

  it('does not show file actions for a non-file panel', () => {
    render(<PanelMenu {...makeProps(tablePanel)} />);
    expect(screen.queryByRole('button', { name: 'Show in Workspace Files' })).toBeNull();
  });

  it('closes the menu after asking about the tile', async () => {
    const onAskAboutTile = vi.fn();
    const onCloseMenu = vi.fn();
    const user = userEvent.setup();
    render(<PanelMenu {...makeProps(tablePanel, { onAskAboutTile, onCloseMenu })} />);
    await user.click(screen.getByRole('button', { name: 'Ask About This Tile' }));
    expect(onAskAboutTile).toHaveBeenCalledWith('p1');
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('minimizes and clears contextual draft together', async () => {
    const onMinimize = vi.fn();
    const onClearContextualDraft = vi.fn();
    const user = userEvent.setup();
    render(<PanelMenu {...makeProps(tablePanel, { onMinimize, onClearContextualDraft })} />);
    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(onMinimize).toHaveBeenCalledWith('p1');
    expect(onClearContextualDraft).toHaveBeenCalledOnce();
  });
});
