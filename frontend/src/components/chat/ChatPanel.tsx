import { Suspense, lazy, memo, useEffect, useState } from 'react';
import { LoaderCircle, MessageSquare, Send, Square } from 'lucide-react';
import { getToolName, isTextUIPart, isToolUIPart, type UIMessage } from 'ai';
import { z } from 'zod';
import { cn } from '../../lib/utils';
import { extractMessageText, getToolNotices } from '../../lib/messages';
import type { ChatActivityState } from '../../lib/chatActivity';

const LazyMarkdownRenderer = lazy(() => import('../renderers/MarkdownRenderer'));

type ToolCallPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;
const codeInputSchema = z.object({ code: z.string() });
const stringPayloadSchema = z.string();

function ToolPayload({ part, field }: { part: ToolCallPart; field: 'input' | 'output' }) {
  const input = part.state === 'output-error' && part.input === undefined && 'rawInput' in part
    ? part.rawInput
    : part.input;
  const value = field === 'input' ? input : part.state === 'output-available' ? part.output : undefined;
  const code = field === 'input' && getToolName(part) === 'codemode'
    ? codeInputSchema.safeParse(value).data?.code
    : undefined;
  const text = code ?? stringPayloadSchema.safeParse(value).data ?? JSON.stringify(value, null, 2);
  if (text === undefined) return <p className="text-xs text-muted-foreground">Not available yet.</p>;
  return (
    <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 text-xs text-foreground">
      {text}
    </pre>
  );
}

function ToolCall({ part }: { part: ToolCallPart }) {
  const [expanded, setExpanded] = useState(false);
  const status = {
    'input-streaming': 'Preparing',
    'input-available': 'Running',
    'output-available': 'Done',
    'output-error': 'Failed',
    'output-denied': 'Not allowed',
    'approval-requested': 'Needs approval',
    'approval-responded': 'Approval received',
  }[part.state];
  return (
    <details className="rounded-lg border border-border bg-secondary/50 text-foreground" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer px-3 py-2 text-xs" aria-label={`${getToolName(part)}: ${status}`}>
        <span className="font-mono">{getToolName(part)}</span><span className="ml-2">{status}</span>
      </summary>
      {expanded ? (
        <div className="space-y-2 border-t border-border p-3">
          <h4 className="text-xs font-medium">Input</h4>
          <ToolPayload part={part} field="input" />
          {part.state === 'output-available' ? <><h4 className="text-xs font-medium">Output</h4><ToolPayload part={part} field="output" /></> : null}
          {part.state === 'output-error' ? <p className="text-xs">This tool attempt failed. Review the subsequent activity and response.</p> : null}
        </div>
      ) : null}
    </details>
  );
}

const MessageRow = memo(function MessageRow({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    return (
      <article className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm p-3 self-end">
        <pre className="whitespace-pre-wrap font-sans text-sm">{extractMessageText(message)}</pre>
      </article>
    );
  }
  const visibleParts = Array.isArray(message.parts)
    ? message.parts.filter((part) => isToolUIPart(part) || (isTextUIPart(part) && part.text))
    : [];
  const toolNotices = getToolNotices(message);
  if (visibleParts.length === 0 && toolNotices.length === 0) return null;
  return (
    <article className="max-w-[90%] self-start space-y-2">
      {toolNotices.map((notice) => (
        <p
          key={`${message.id}-${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'rounded-2xl border px-3 py-2 text-sm',
            notice.kind === 'error'
              ? 'border-destructive/20 bg-destructive/8 text-destructive'
              : notice.kind === 'approval'
                ? 'border-accent/20 bg-accent/5 text-accent'
                : 'border-border bg-secondary text-secondary-foreground'
          )}
        >
          {notice.message}
        </p>
      ))}
      {visibleParts.map((part, index) => isToolUIPart(part) ? (
        <ToolCall key={part.toolCallId} part={part} />
      ) : isTextUIPart(part) ? (
        <div key={index} className="bg-secondary text-secondary-foreground rounded-2xl rounded-bl-sm p-3">
          <Suspense fallback={<div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">{part.text}</div>}>
            <LazyMarkdownRenderer
              className="prose prose-sm dark:prose-invert max-w-none"
              content={part.text}
            />
          </Suspense>
        </div>
      ) : null)}
    </article>
  );
});

function WorkingProgress({ detail }: { detail: string }) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <div className="flex items-center gap-3 border-t border-border bg-secondary px-4 py-3">
      <LoaderCircle size={18} className="shrink-0 animate-spin motion-reduce:animate-none text-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p role="status" className="text-sm font-medium text-foreground">{detail}</p>
        <p className="text-xs text-muted-foreground">You can stop this response at any time.</p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={`Elapsed time: ${elapsed} seconds`}>
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
      </span>
    </div>
  );
}

/**
 * Presentational main chat panel. All state (composer text, chat status,
 * messages, scope) is owned by WorkspaceShell and passed in as props so the
 * panel can be rendered both docked (wide) and in the narrow-viewport drawer
 * without duplicating markup.
 */
export function ChatPanel({
  activity,
  messages,
  composer,
  onComposerChange,
  onSubmit,
  onStop,
  onClear,
  onRetry,
  onReload,
  errorNotice,
  selectedScopeLabel,
  onClearScope,
}: {
  activity: ChatActivityState;
  messages: UIMessage[];
  composer: string;
  onComposerChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
  onRetry: () => void;
  onReload: () => void;
  errorNotice?: string | null;
  selectedScopeLabel: string | null;
  onClearScope: () => void;
}) {
  const submitComposer = () => {
    if (!activity.canSubmit) return;
    const next = composer.trim();
    if (!next) return;
    onSubmit(next);
    onComposerChange('');
  };

  const clearConversation = () => {
    if (messages.length > 0 && !window.confirm('Clear this conversation? This permanently deletes its messages.')) {
      return;
    }
    onClear();
  };

  return (
    <section className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h3 className="font-serif text-sm font-medium flex items-center gap-2">
          <MessageSquare size={14} className="text-accent" aria-hidden="true" />Chat
        </h3>
        <div className="flex items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            aria-label={`Chat status: ${activity.label}`}
            className={cn(
              'text-[10px] tracking-wide px-1.5 py-0.5 rounded',
              activity.tone === 'ready'
                ? 'text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400'
                : activity.tone === 'error'
                  ? 'text-destructive bg-destructive/10'
                  : 'text-accent bg-accent/10'
            )}
          >{activity.label}</span>
          {activity.canStop ? (
            <button
              className="inline-flex items-center gap-1.5 text-xs text-destructive hover:opacity-80 transition-opacity"
              onClick={onStop}
              aria-label="Stop response"
            >
              <Square size={11} aria-hidden="true" />
              Stop response
            </button>
          ) : (
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={clearConversation}
              aria-label="Clear conversation"
            >
              Clear conversation
            </button>
          )}
        </div>
      </div>
      {selectedScopeLabel ? (
        <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-accent/20 text-xs">
          <span className="text-accent font-medium">{selectedScopeLabel}</span>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClearScope}>Clear selection</button>
        </div>
      ) : null}
      {activity.phase === 'error' ? (
        <div className="border-b border-destructive/20 bg-destructive/8 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">
                {errorNotice ?? 'The last response failed before it finished.'}
              </p>
              <p className="text-xs text-muted-foreground">
                {activity.label === 'Connection lost'
                  ? 'Reload the page to reconnect.'
                  : 'Retry the last turn or send another message. Your conversation is kept.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {activity.label === 'Connection lost' ? (
                <button
                  className="rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  onClick={onReload}
                >
                  Reload page
                </button>
              ) : (
                <button
                  className="rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={onRetry}
                  disabled={!activity.canRetry}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.map((message) => <MessageRow key={message.id} message={message} />)}
      </div>
      {activity.phase === 'working' ? <WorkingProgress detail={activity.detail} /> : null}
      <form
        className="flex gap-2 p-3 border-t border-border"
        onSubmit={(event) => {
          event.preventDefault();
          submitComposer();
        }}
      >
        <textarea
          className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm resize-none focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all placeholder:text-muted-foreground"
          value={composer}
          onChange={(event) => onComposerChange(event.target.value)}
          placeholder={selectedScopeLabel ? 'Ask about the selected tiles.' : 'Ask the agent to create files and tiles.'}
          aria-label="Message the agent"
          disabled={!activity.canSubmit}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submitComposer();
            }
          }}
        />
        <button
          className="bg-primary text-primary-foreground rounded-xl px-3 py-2 hover:opacity-90 transition-opacity self-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          aria-label="Send message"
          disabled={!activity.canSubmit || !composer.trim()}
        >
          <Send size={16} aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
