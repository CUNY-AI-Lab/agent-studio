import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';

function BrokenChild(): never {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  it('keeps a render failure recoverable instead of leaving an empty root', () => {
    render(
      <AppErrorBoundary>
        <BrokenChild />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Agent Studio couldn’t render this workspace.');
    expect(screen.getByRole('button', { name: 'Reload Agent Studio' })).toBeInTheDocument();
  });
});
