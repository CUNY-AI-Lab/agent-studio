import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TablePanelView } from './TablePanelView';
import type { WorkspacePanel } from '../../types';

function tablePanel(): Extract<WorkspacePanel, { type: 'table' }> {
  return {
    id: 't',
    type: 'table',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'score', label: 'Score' },
    ],
    rows: [
      { name: 'Charlie', score: 2 },
      { name: 'Alice', score: 10 },
      { name: 'Bob', score: 5 },
    ],
  } as Extract<WorkspacePanel, { type: 'table' }>;
}

function bodyRowOrder() {
  const rows = screen.getAllByRole('row').slice(1); // skip header row
  return rows.map((row) => within(row).getAllByRole('cell')[0].textContent);
}

describe('TablePanelView', () => {
  it('renders an empty state with no rows', () => {
    const panel = { ...tablePanel(), rows: [] };
    render(<TablePanelView panel={panel} />);
    expect(screen.getByText('No table rows yet.')).toBeInTheDocument();
  });

  it('renders rows in source order initially', () => {
    render(<TablePanelView panel={tablePanel()} />);
    expect(bodyRowOrder()).toEqual(['Charlie', 'Alice', 'Bob']);
  });

  it('sorts ascending then descending on repeated header clicks', async () => {
    const user = userEvent.setup();
    render(<TablePanelView panel={tablePanel()} />);

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(bodyRowOrder()).toEqual(['Alice', 'Bob', 'Charlie']);

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(bodyRowOrder()).toEqual(['Charlie', 'Bob', 'Alice']);
  });

  it('sorts numeric columns numerically, not lexically', async () => {
    const user = userEvent.setup();
    render(<TablePanelView panel={tablePanel()} />);

    await user.click(screen.getByRole('button', { name: /Score/ }));
    // Ascending by numeric score: Charlie(2), Bob(5), Alice(10)
    expect(bodyRowOrder()).toEqual(['Charlie', 'Bob', 'Alice']);
  });
});
