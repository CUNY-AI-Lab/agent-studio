import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { ChatPanel } from './ChatPanel';
import { getChatActivity } from '../../lib/chatActivity';

function userMessage(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

const baseProps = {
  activity: getChatActivity({
    status: 'ready',
    isStreaming: false,
    isServerStreaming: false,
    isRecovering: false,
    isToolContinuation: false,
    contextualTurnActive: false,
    connectionError: null,
    canRetry: false,
  }),
  messages: [],
  composer: '',
  onComposerChange: () => {},
  onSubmit: () => {},
  onStop: () => {},
  onClear: () => {},
  onRetry: () => {},
  onReload: () => {},
  selectedScopeLabel: null,
  onClearScope: () => {},
};

describe('ChatPanel', () => {
  it('shows the current chat status in plain words', () => {
    render(<ChatPanel {...baseProps} />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
  });

  it('maps working states and unknown states to plain words', () => {
    const { rerender } = render(
      <ChatPanel
        {...baseProps}
        activity={getChatActivity({
          status: 'streaming',
          isStreaming: false,
          isServerStreaming: false,
          isRecovering: false,
          isToolContinuation: false,
          contextualTurnActive: false,
          connectionError: null,
          canRetry: false,
        })}
      />
    );
    expect(screen.getByText('Working…')).toBeInTheDocument();
    rerender(
      <ChatPanel
        {...baseProps}
        activity={getChatActivity({
          status: 'some-new-state',
          isStreaming: false,
          isServerStreaming: false,
          isRecovering: false,
          isToolContinuation: true,
          contextualTurnActive: false,
          connectionError: null,
          canRetry: false,
        })}
      />
    );
    expect(screen.getByText('Working…')).toBeInTheDocument();
    expect(screen.queryByText('some-new-state')).not.toBeInTheDocument();
  });

  it('renders a user message', () => {
    render(<ChatPanel {...baseProps} messages={[userMessage('hello there')]} />);
    expect(screen.getByText('hello there')).toBeInTheDocument();
  });

  it('keeps tool protocol details out of the conversation while rendering the assistant text', () => {
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-write_file', toolCallId: 't1', state: 'output-available', input: {}, output: {} },
        { type: 'text', text: 'The file is ready.' },
      ],
    };
    render(<ChatPanel {...baseProps} messages={[message]} />);
    expect(screen.getByText('The file is ready.')).toBeInTheDocument();
    expect(screen.queryByText('Agent activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Write file')).not.toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.queryByText('output-available')).not.toBeInTheDocument();
    expect(screen.queryByText('write_file')).not.toBeInTheDocument();
  });

  it('keeps exceptional tool outcomes visible without showing tool protocol', () => {
    const message: UIMessage = {
      id: 'a2',
      role: 'assistant',
      parts: [
        { type: 'tool-write_file', toolCallId: 't1', state: 'output-error', input: {}, errorText: 'hidden detail' },
        { type: 'tool-read_file', toolCallId: 't2', state: 'output-denied', input: {}, approval: { id: 'approval-2', approved: false } },
        { type: 'tool-ask_user', toolCallId: 't3', state: 'approval-requested', input: {}, approval: { id: 'approval-3' } },
      ],
    };
    render(<ChatPanel {...baseProps} messages={[message]} />);
    expect(screen.getByText("A tool couldn't complete this request. Try again.")).toBeInTheDocument();
    expect(screen.getByText("A tool wasn't allowed to run.")).toBeInTheDocument();
    expect(screen.getByText('Approval is needed before this can continue.')).toBeInTheDocument();
    expect(screen.queryByText('hidden detail')).not.toBeInTheDocument();
  });

  it('omits successful tool-only messages and empty assistant articles', () => {
    const messages: UIMessage[] = [
      {
        id: 'a3',
        role: 'assistant',
        parts: [{ type: 'tool-write_file', toolCallId: 't1', state: 'output-available', input: {}, output: {} }],
      },
      { id: 'a4', role: 'assistant', parts: [] },
    ];
    render(<ChatPanel {...baseProps} messages={messages} />);
    expect(screen.queryByText('A tool')).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('shows the error recovery banner and retry gating', () => {
    render(
      <ChatPanel
        {...baseProps}
        activity={getChatActivity({
          status: 'error',
          isStreaming: false,
          isServerStreaming: false,
          isRecovering: false,
          isToolContinuation: false,
          contextualTurnActive: false,
          connectionError: null,
          canRetry: false,
        })}
      />
    );
    expect(screen.getByText('The last response failed before it finished.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('shows a terminal connection failure and offers a full-page reload without exposing the socket error', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    render(
      <ChatPanel
        {...baseProps}
        activity={getChatActivity({
          status: 'ready',
          isStreaming: false,
          isServerStreaming: false,
          isRecovering: false,
          isToolContinuation: false,
          contextualTurnActive: false,
          connectionError: new Error('private socket detail'),
          canRetry: true,
        })}
        onReload={onReload}
        errorNotice="The connection to the agent was lost. Reload the page to reconnect."
      />
    );
    expect(screen.getByText('Connection lost')).toBeInTheDocument();
    expect(screen.getByText('The connection to the agent was lost. Reload the page to reconnect.')).toBeInTheDocument();
    expect(screen.getByText('Reload the page to reconnect.')).toBeInTheDocument();
    expect(screen.queryByText('private socket detail')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(onReload).toHaveBeenCalledOnce();
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
        activity={getChatActivity({
          status: 'error',
          isStreaming: false,
          isServerStreaming: false,
          isRecovering: false,
          isToolContinuation: false,
          contextualTurnActive: false,
          connectionError: null,
          canRetry: false,
        })}
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
        activity={getChatActivity({
          status: 'ready',
          isStreaming: false,
          isServerStreaming: false,
          isRecovering: false,
          isToolContinuation: true,
          contextualTurnActive: false,
          connectionError: null,
          canRetry: false,
        })}
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
