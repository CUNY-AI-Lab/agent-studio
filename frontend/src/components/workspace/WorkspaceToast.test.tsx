import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkspaceToast } from './WorkspaceToast';

describe('WorkspaceToast', () => {
  it('renders nothing when there is no toast', () => {
    const { container } = render(<WorkspaceToast toast={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces the message via a polite status live region', () => {
    render(<WorkspaceToast toast={{ message: 'File is ready', type: 'success' }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('File is ready');
  });

  it('hides the decorative status icon from assistive tech', () => {
    const { container } = render(
      <WorkspaceToast toast={{ message: 'Deleted', type: 'info' }} />
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });
});
