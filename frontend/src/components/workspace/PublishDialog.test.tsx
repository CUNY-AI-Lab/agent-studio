import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PublishDialog } from './PublishDialog';

const baseProps = {
  open: true,
  publishing: false,
  title: 'My Space',
  description: 'A description',
  publishablePanelCount: 2,
  fileCount: 1,
  onTitleChange: () => {},
  onDescriptionChange: () => {},
  onClose: () => {},
  onPublish: () => {},
};

describe('PublishDialog', () => {
  it('preserves the chosen title while typing and publishing a description through parent rerenders', async () => {
    const onPublish = vi.fn();
    const user = userEvent.setup();
    function EditableDialog() {
      const [open, setOpen] = useState(true);
      const [title, setTitle] = useState('Chosen title');
      const [description, setDescription] = useState('');
      return <PublishDialog {...baseProps} open={open} title={title} description={description}
        onTitleChange={setTitle} onDescriptionChange={setDescription}
        onClose={() => setOpen(false)} onPublish={() => onPublish({ title, description })} />;
    }
    render(<EditableDialog />);
    await user.type(screen.getByLabelText('Description'), 'Shared research');
    expect(screen.getByLabelText('Description')).toHaveFocus();
    expect(screen.getByLabelText('Title')).toHaveValue('Chosen title');
    expect(screen.getByLabelText('Description')).toHaveValue('Shared research');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledWith({ title: 'Chosen title', description: 'Shared research' });
  });

  it('renders nothing when closed', () => {
    const { container } = render(<PublishDialog {...baseProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes the shared tile and file counts with correct pluralization', () => {
    render(<PublishDialog {...baseProps} publishablePanelCount={2} fileCount={1} />);
    expect(screen.getByText(/Publishing makes 2 tile views and 1 file available to signed-in CAIL members through the Agent Studio gallery/)).toBeInTheDocument();
    expect(screen.getByText(/Gallery links open only for signed-in CAIL members/)).toBeInTheDocument();
    expect(screen.getByText(/Don’t publish private or sensitive files/)).toBeInTheDocument();
  });

  it('distinguishes workspace storage from model-provider retention', () => {
    render(<PublishDialog {...baseProps} />);
    expect(screen.getByText(/Agent Studio saves this workspace privately/)).toBeInTheDocument();
    expect(screen.getByText(/Model-provider routes are configured not to retain prompts or outputs/)).toBeInTheDocument();
    expect(screen.getByText(/but Agent Studio still stores the workspace/)).toBeInTheDocument();
  });

  it('disables Publish when the title is blank', () => {
    render(<PublishDialog {...baseProps} title="  " />);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('fires onPublish when the enabled button is clicked', async () => {
    const onPublish = vi.fn();
    const user = userEvent.setup();
    render(<PublishDialog {...baseProps} onPublish={onPublish} />);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it('shows a publishing label and disables actions while publishing', () => {
    render(<PublishDialog {...baseProps} publishing />);
    expect(screen.getByRole('button', { name: 'Publishing...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('is a labeled modal dialog with labeled fields', () => {
    render(<PublishDialog {...baseProps} />);
    const dialog = screen.getByRole('dialog', { name: 'Publish to Gallery' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
  });

  it('moves initial focus into the dialog on open', () => {
    render(<PublishDialog {...baseProps} />);
    // First focusable inside the dialog is the Title input.
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));
  });

  it('closes on Escape when not publishing', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PublishDialog {...baseProps} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('retains field focus across updates while Escape uses the current publishing guard and close callback', async () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<PublishDialog {...baseProps} onClose={firstClose} />);
    await user.click(screen.getByLabelText('Description'));
    rerender(<PublishDialog {...baseProps} publishing onClose={latestClose} />);
    expect(screen.getByLabelText('Description')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).not.toHaveBeenCalled();
    rerender(<PublishDialog {...baseProps} publishing={false} onClose={latestClose} />);
    expect(screen.getByLabelText('Description')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(latestClose).toHaveBeenCalledOnce();
    expect(firstClose).not.toHaveBeenCalled();
  });
});
