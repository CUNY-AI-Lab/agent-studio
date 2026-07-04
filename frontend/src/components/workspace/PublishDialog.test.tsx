import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('renders nothing when closed', () => {
    const { container } = render(<PublishDialog {...baseProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes the shared tile and file counts with correct pluralization', () => {
    render(<PublishDialog {...baseProps} publishablePanelCount={2} fileCount={1} />);
    expect(screen.getByText(/share 2 tile views and 1 file to the public gallery/)).toBeInTheDocument();
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
});
