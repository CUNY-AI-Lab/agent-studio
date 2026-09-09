import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { ChatPanel } from './ChatPanel';
import { getChatActivity } from '../../lib/chatActivity';
import { noticeFromChatError } from '../../lib/chatError';

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
  it.each([
    ['upstream_error', 'The model provider could not finish this response. You can try again.'],
    ['upstream_rate_limited', 'The model provider is busy. Wait a moment before trying again.'],
    ['outcome_unknown', 'The model connection ended before the result could be confirmed. Check the conversation and workspace files before retrying; the request may already have produced a result.'],
    ['response_interrupted', 'The response was interrupted before it finished. Your saved conversation and workspace files are kept. Check them before retrying.'],
    ['provider_configuration_error', 'The model is unavailable because of a service configuration problem. Choose another model or try again later.'],
  ])('shows bounded recovery for %s and retains the conversation', async (code, expectedNotice) => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ChatPanel {...baseProps}
      messages={[userMessage('Keep the task instructions')]}
      activity={getChatActivity({
        status: 'error', isStreaming: false, isServerStreaming: false,
        isRecovering: false, isToolContinuation: false, contextualTurnActive: false,
        connectionError: null, canRetry: true,
      })}
      errorNotice={noticeFromChatError(new Error(JSON.stringify({
        error: { code, message: 'private provider detail', cail: { retryable: false } },
      })))}
      onRetry={onRetry}
    />);
    expect(screen.getByText(expectedNotice)).toBeInTheDocument();
    expect(screen.queryByText('private provider detail')).not.toBeInTheDocument();
    expect(screen.getByText('Keep the task instructions')).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

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

  it('shows completed tool calls alongside the assistant text', () => {
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
    expect(screen.getByLabelText('write_file: Done')).toBeInTheDocument();
    expect(screen.queryByText('output-available')).not.toBeInTheDocument();
    expect(screen.getByText('write_file')).toBeInTheDocument();
  });

  it('lets users expand each streamed tool call and inspect its code and result', async () => {
    const user = userEvent.setup();
    const message: UIMessage = { id: 'inspect', role: 'assistant', parts: [
      { type: 'tool-codemode', toolCallId: 'run', state: 'input-streaming', input: { code: 'async () => {' } },
    ] };
    const { rerender, unmount } = render(<ChatPanel {...baseProps} messages={[message]} />);
    expect(screen.queryByText('async () => {')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('codemode: Preparing'));
    expect(await screen.findByText('async () => {')).toBeVisible();
    const completed: UIMessage = { ...message, parts: [
      { type: 'tool-codemode', toolCallId: 'run', state: 'output-available', input: { code: 'async () => {\n  return rows.length;\n}' }, output: { rows: 12 } },
      { type: 'tool-ui_show_file', toolCallId: 'display', state: 'output-available', input: { filePath: 'chart.html' }, output: { shown: true } },
    ] };
    rerender(<ChatPanel {...baseProps} messages={[completed]} />);
    expect(screen.getByText(/return rows.length;/)).toBeVisible();
    expect(screen.getByText(/"rows": 12/)).toBeVisible();
    await user.click(screen.getByLabelText('ui_show_file: Done'));
    expect(await screen.findByText(/"filePath": "chart.html"/)).toBeVisible();
    expect(screen.getByText(/"shown": true/)).toBeVisible();
    unmount();
    render(<ChatPanel {...baseProps} messages={[completed]} />);
    expect(screen.getByLabelText('codemode: Done')).toBeInTheDocument();
    expect(screen.getByLabelText('ui_show_file: Done')).toBeInTheDocument();
    await user.click(screen.getByLabelText('codemode: Done'));
    expect(await screen.findByText(/return rows.length;/)).toBeVisible();
  });

  it('makes the full expanded result inspectable and never displays raw tool exceptions', async () => {
    const user = userEvent.setup();
    render(<ChatPanel {...baseProps} messages={[{ id: 'large', role: 'assistant', parts: [
      { type: 'tool-read_file', toolCallId: 'read', state: 'output-available', input: {}, output: 'a'.repeat(12000) + 'omitted tail' },
      { type: 'tool-codemode', toolCallId: 'failed', state: 'output-error', input: { code: 'async () => {}' }, errorText: 'private provider exception' },
    ] }]} />);
    await user.click(screen.getByLabelText('read_file: Done'));
    expect(await screen.findByText(/omitted tail/)).toBeVisible();
    await user.click(screen.getByLabelText('codemode: Failed'));
    expect(await screen.findByText('This tool attempt failed. Review the subsequent activity and response.')).toBeVisible();
    expect(screen.queryByText('private provider exception')).not.toBeInTheDocument();
  });

  it('shows rejected raw arguments when a failed tool input could not be parsed', async () => {
    const user = userEvent.setup();
    render(<ChatPanel {...baseProps} messages={[{ id: 'malformed', role: 'assistant', parts: [
      { type: 'tool-codemode', toolCallId: 'invalid', state: 'output-error', input: undefined,
        rawInput: '{"code": "async () => {', errorText: 'private validation exception' },
    ] }]} />);
    await user.click(screen.getByLabelText('codemode: Failed'));
    expect(await screen.findByText('{"code": "async () => {')).toBeVisible();
    expect(screen.queryByText('Not available yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('private validation exception')).not.toBeInTheDocument();
  });

  it('keeps a failed attempt visible without a retry alert after later tool work', () => {
    render(<ChatPanel {...baseProps} messages={[{ id: 'continued', role: 'assistant', parts: [
      { type: 'tool-codemode', toolCallId: 'failed', state: 'output-error', input: {}, errorText: 'hidden exception' },
      { type: 'tool-ui_show_file', toolCallId: 'shown', state: 'output-available', input: {}, output: {} },
      { type: 'text', text: 'Review the chart.' },
    ] }]} />);
    expect(screen.getByLabelText('codemode: Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('ui_show_file: Done')).toBeInTheDocument();
    expect(screen.getByText('A tool attempt failed. The agent continued with other tools.')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Try again/)).not.toBeInTheDocument();
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
    expect(screen.getByText('A tool attempt failed. Review the response and any files it produced.')).toBeInTheDocument();
    expect(screen.getByText("A tool wasn't allowed to run.")).toBeInTheDocument();
    expect(screen.getByText('Approval is needed before this can continue.')).toBeInTheDocument();
    expect(screen.queryByText('hidden detail')).not.toBeInTheDocument();
  });

  it('shows concise completed tool activity while omitting empty assistant messages', () => {
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
    expect(screen.getByLabelText('write_file: Done')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('streams named code stages and keeps the completed activity visible during the next tool', () => {
    const working = {
      status: 'streaming', isStreaming: true, isServerStreaming: true,
      isRecovering: false, isToolContinuation: false, contextualTurnActive: false,
      connectionError: null, canRetry: false,
    };
    const preparing: UIMessage = { id: 'code', role: 'assistant', parts: [
      { type: 'tool-codemode', toolCallId: 'code', state: 'input-streaming', input: { code: 'private code' } },
    ] };
    const { rerender } = render(<ChatPanel {...baseProps} messages={[preparing]}
      activity={getChatActivity({ ...working, messages: [preparing] })} />);
    expect(screen.getByText('Preparing code…')).toBeInTheDocument();
    const running: UIMessage = { ...preparing, parts: [
      { type: 'tool-codemode', toolCallId: 'code', state: 'input-available', input: { code: 'private code' } },
    ] };
    rerender(<ChatPanel {...baseProps} messages={[running]}
      activity={getChatActivity({ ...working, messages: [running] })} />);
    expect(screen.getByText('Running code…')).toBeInTheDocument();
    const nextTool: UIMessage = { ...preparing, parts: [
      { type: 'tool-codemode', toolCallId: 'code', state: 'output-available', input: {}, output: { private: 'result' } },
      { type: 'tool-ui_show_file', toolCallId: 'display', state: 'input-available', input: {} },
    ] };
    rerender(<ChatPanel {...baseProps} messages={[nextTool]}
      activity={getChatActivity({ ...working, messages: [nextTool] })} />);
    expect(screen.getByLabelText('codemode: Done')).toBeInTheDocument();
    expect(screen.getByText('Displaying a file…')).toBeInTheDocument();
    expect(screen.queryByText('private code')).not.toBeInTheDocument();
    expect(screen.queryByText('result')).not.toBeInTheDocument();
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
    expect(screen.getByText('Retry the last turn or send another message. Your conversation is kept.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Clear conversation' })).toHaveLength(1);
  });

  it('shows elapsed work across stage changes and removes progress after failure', () => {
    vi.useFakeTimers();
    try {
      const activity = getChatActivity({
        status: 'submitted', isStreaming: false, isServerStreaming: false,
        isRecovering: false, isToolContinuation: false, contextualTurnActive: false,
        connectionError: null, canRetry: true,
      });
      const { rerender } = render(<ChatPanel {...baseProps} activity={activity} />);
      expect(screen.getByText('Thinking…')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(65000));
      expect(screen.getByLabelText('Elapsed time: 65 seconds')).toHaveTextContent('1:05');
      if (activity.phase !== 'working') throw new Error('Expected working activity');
      rerender(<ChatPanel {...baseProps} activity={{ ...activity, detail: 'Running tools…' }} />);
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Running tools…');
      expect(screen.getByLabelText('Elapsed time: 65 seconds')).toBeInTheDocument();
      rerender(<ChatPanel {...baseProps} activity={getChatActivity({
        status: 'error', isStreaming: false, isServerStreaming: false,
        isRecovering: false, isToolContinuation: false, contextualTurnActive: false,
        connectionError: null, canRetry: true,
      })} />);
      expect(screen.queryByText('Running tools…')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
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
