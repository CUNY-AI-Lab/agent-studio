import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';

function ShortcutsHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Show shortcuts</button>
    <KeyboardShortcutsDialog open={open} onClose={() => setOpen(false)} />
    <button type="button">Outside action</button>
  </>;
}

describe('KeyboardShortcutsDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<KeyboardShortcutsDialog open={false} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a labeled modal dialog', () => {
    render(<KeyboardShortcutsDialog open onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('lists the arrow-key move binding so the feature is discoverable', () => {
    render(<KeyboardShortcutsDialog open onClose={() => {}} />);
    expect(screen.getByText('Move the tile by 16px')).toBeInTheDocument();
    expect(screen.getByText('Toggle selection of the focused tile')).toBeInTheDocument();
  });

  it('keeps Tab and Shift+Tab inside, then restores the opener after Escape', async () => {
    const user = userEvent.setup();
    render(<ShortcutsHarness />);
    const opener = screen.getByRole('button', { name: 'Show shortcuts' });
    await user.click(opener);
    const close = screen.getByRole('button', { name: 'Close keyboard shortcuts' });
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Outside action' })).toHaveFocus();
  });

  it('closes when the close button is pressed', async () => {
    const user = userEvent.setup();
    render(<ShortcutsHarness />);
    const opener = screen.getByRole('button', { name: 'Show shortcuts' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
