import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { ChatPanel } from './ChatPanel';

function userMessage(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

const baseProps = {
  status: 'ready',
  isBusy: false,
  messages: [],
  composer: '',
  onComposerChange: () => {},
  onSubmit: () => {},
  onStop: () => {},
  onClear: () => {},
  onRetry: () => {},
  canRetry: false,
  selectedScopeLabel: null,
  onClearScope: () => {},
};

describe('ChatPanel', () => {
  it('shows the current chat status in plain words', () => {
    render(<ChatPanel {...baseProps} status="ready" />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
  });

  it('maps working states and unknown states to plain words', () => {
    const { rerender } = render(<ChatPanel {...baseProps} status="streaming" />);
    expect(screen.getByText('Working…')).toBeInTheDocument();
    rerender(<ChatPanel {...baseProps} status="some-new-state" />);
    expect(screen.getByText('Working…')).toBeInTheDocument();
    expect(screen.queryByText('some-new-state')).not.toBeInTheDocument();
  });

  it('renders a user message', () => {
    render(<ChatPanel {...baseProps} messages={[userMessage('hello there')]} />);
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('shows tool progress in plain words instead of raw SDK states', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'tool-write_file', toolCallId: 't1', state: 'output-available', input: {}, output: {} }],
    };
    render(<ChatPanel {...baseProps} messages={[message]} />);
    expect(screen.getByText('Write file')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('output-available')).not.toBeInTheDocument();
    expect(screen.queryByText('write_file')).not.toBeInTheDocument();
  });

  it('shows the error recovery banner and retry gating', () => {
    render(<ChatPanel {...baseProps} status="error" canRetry={false} />);
    expect(screen.getByText('The last response failed before it finished.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('confirms before clearing a conversation with messages', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<ChatPanel {...baseProps} messages={[userMessage('keep this')]} onClear={onClear} />);

    await user.click(screen.getByRole('button', { name: 'Clear conversation' }));
    expect(window.confirm).toHaveBeenCalledWith('Clear this conversation? This permanently deletes its messages.');
    expect(onClear).not.toHaveBeenCalled();
  });

  it('shows a quota-specific error notice instead of the generic sentence', () => {
    render(
      <ChatPanel
        {...baseProps}
        status="error"
        errorNotice="You have reached your usage quota. Try again later."
      />
    );
    expect(screen.getByText('You have reached your usage quota. Try again later.')).toBeInTheDocument();
    expect(screen.queryByText('The last response failed before it finished.')).not.toBeInTheDocument();
  });

  it('submits the trimmed composer and clears it on Enter', async () => {
    const onSubmit = vi.fn();
    const onComposerChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatPanel {...baseProps} composer="do a thing" onSubmit={onSubmit} onComposerChange={onComposerChange} />
    );
    const textarea = screen.getByPlaceholderText('Ask the agent to create files and tiles.');
    textarea.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('do a thing');
    expect(onComposerChange).toHaveBeenCalledWith('');
  });

  it('prevents duplicate turns and offers server-side cancellation while working', async () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatPanel
        {...baseProps}
		status="ready"
		isBusy
        composer="another request"
        onSubmit={onSubmit}
        onStop={onStop}
      />
    );

    expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Clear conversation' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop response' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders the scope banner and clears scope', async () => {
    const onClearScope = vi.fn();
    const user = userEvent.setup();
    render(<ChatPanel {...baseProps} selectedScopeLabel="Asking about 2 tiles" onClearScope={onClearScope} />);
    expect(screen.getByText('Asking about 2 tiles')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onClearScope).toHaveBeenCalledOnce();
  });
});
