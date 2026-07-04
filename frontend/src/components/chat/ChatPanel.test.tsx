import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { ChatPanel } from './ChatPanel';

function userMessage(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] } as unknown as UIMessage;
}

const baseProps = {
  status: 'ready',
  messages: [] as UIMessage[],
  composer: '',
  onComposerChange: () => {},
  onSubmit: () => {},
  onClear: () => {},
  onRetry: () => {},
  onDumpTrace: () => {},
  canRetry: false,
  selectedScopeLabel: null,
  onClearScope: () => {},
};

describe('ChatPanel', () => {
  it('shows the current chat status', () => {
    render(<ChatPanel {...baseProps} status="ready" />);
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('renders a user message', () => {
    render(<ChatPanel {...baseProps} messages={[userMessage('hello there')]} />);
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('shows the error recovery banner and retry gating', () => {
    render(<ChatPanel {...baseProps} status="error" canRetry={false} />);
    expect(screen.getByText('The last response failed before it finished.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('submits the trimmed composer and clears it on Enter', async () => {
    const onSubmit = vi.fn();
    const onComposerChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatPanel {...baseProps} composer="do a thing" onSubmit={onSubmit} onComposerChange={onComposerChange} />
    );
    const textarea = screen.getByPlaceholderText('Ask the agent to create files and panels.');
    textarea.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('do a thing');
    expect(onComposerChange).toHaveBeenCalledWith('');
  });

  it('renders the scope banner and clears scope', async () => {
    const onClearScope = vi.fn();
    const user = userEvent.setup();
    render(<ChatPanel {...baseProps} selectedScopeLabel="Scoped to 2 tiles" onClearScope={onClearScope} />);
    expect(screen.getByText('Scoped to 2 tiles')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear Scope' }));
    expect(onClearScope).toHaveBeenCalledOnce();
  });
});
