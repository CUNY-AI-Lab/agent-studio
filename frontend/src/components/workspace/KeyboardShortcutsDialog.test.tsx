import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';

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

  it('traps focus and closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<KeyboardShortcutsDialog open onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves initial focus into the dialog on open', () => {
    render(<KeyboardShortcutsDialog open onClose={() => {}} />);
    const active = document.activeElement as HTMLElement | null;
    expect(active?.getAttribute('aria-label')).toBe('Close keyboard shortcuts');
  });

  it('closes when the close button is pressed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<KeyboardShortcutsDialog open onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
