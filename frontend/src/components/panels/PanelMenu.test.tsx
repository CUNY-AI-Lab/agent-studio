import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelMenu } from './PanelMenu';
import type { FilePanel, WorkspacePanel } from '../../types';

function makeProps(panel: WorkspacePanel, overrides: Partial<Parameters<typeof PanelMenu>[0]> = {}) {
  return {
    panel,
    maximizedPanelId: null,
    onAskAboutTile: vi.fn(),
    onRevealFile: vi.fn(),
    onPanelDownload: vi.fn(),
    onCloseMenu: vi.fn(),
    onMinimize: vi.fn(),
    onMaximize: vi.fn(),
    onSetMaximizedPanelId: vi.fn(),
    onRemovePanel: vi.fn(),
    ...overrides,
  };
}

const tablePanel: Extract<WorkspacePanel, { type: 'table' }> = { id: 'p1', type: 'table', columns: [], rows: [] };
const filePanel: FilePanel = { id: 'p2', type: 'editor', filePath: 'doc.md' };
const cardsPanel: Extract<WorkspacePanel, { type: 'cards' }> = {
  id: 'p3',
  type: 'cards',
  title: 'Cards',
  items: [{ id: 'card-1', title: 'Finding', badge: 'New', metadata: { Source: 'Paper' } }],
};

describe('PanelMenu', () => {
  it('reveals and downloads the selected workspace file', async () => {
    const props = makeProps(filePanel);
    const user = userEvent.setup();
    render(<PanelMenu {...props} />);
    await user.click(screen.getByRole('menuitem', { name: 'Show in workspace files' }));
    expect(props.onRevealFile).toHaveBeenCalledWith('doc.md');
    await user.click(screen.getByRole('menuitem', { name: /^Download$/ }));
    expect(props.onPanelDownload).toHaveBeenCalledWith(filePanel, 'file');
    expect(props.onCloseMenu).toHaveBeenCalledTimes(2);
  });

  it('sends the selected table and format to export', async () => {
    const props = makeProps(tablePanel);
    const user = userEvent.setup();
    render(<PanelMenu {...props} />);
    await user.click(screen.getByRole('menuitem', { name: 'Export as CSV' }));
    expect(props.onPanelDownload).toHaveBeenCalledWith(tablePanel, 'csv');
    await user.click(screen.getByRole('menuitem', { name: 'Export as JSON' }));
    expect(props.onPanelDownload).toHaveBeenCalledWith(tablePanel, 'json');
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

  it('minimizes through the shell lifecycle owner', async () => {
    const onMinimize = vi.fn();
    const user = userEvent.setup();
    render(<PanelMenu {...makeProps(tablePanel, { onMinimize })} />);
    await user.click(screen.getByRole('menuitem', { name: 'Minimize' }));
    expect(onMinimize).toHaveBeenCalledWith('p1');
  });
});
