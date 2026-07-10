import { Suspense, lazy } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { getToolName, isTextUIPart, isToolUIPart, type UIMessage } from 'ai';
import { cn } from '../../lib/utils';
import { extractMessageText } from '../../lib/messages';

const LazyMarkdownRenderer = lazy(() => import('../renderers/MarkdownRenderer'));

/**
 * Presentational main chat panel. All state (composer text, chat status,
 * messages, scope) is owned by WorkspaceShell and passed in as props so the
 * panel can be rendered both docked (wide) and in the narrow-viewport drawer
 * without duplicating markup.
 */
export function ChatPanel({
  status,
  messages,
  composer,
  onComposerChange,
  onSubmit,
  onClear,
  onRetry,
  onDumpTrace,
  canRetry,
  errorNotice,
  selectedScopeLabel,
  onClearScope,
}: {
  status: string;
  messages: UIMessage[];
  composer: string;
  onComposerChange: (value: string) => void;
  onSubmit: (text: string) => void;
  onClear: () => void;
  onRetry: () => void;
  onDumpTrace: () => void;
  canRetry: boolean;
  errorNotice?: string | null;
  selectedScopeLabel: string | null;
  onClearScope: () => void;
}) {
  const submitComposer = () => {
    const next = composer.trim();
    if (!next) return;
    onSubmit(next);
    onComposerChange('');
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
            aria-label={`Chat status: ${status}`}
            className={cn(
              'text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded',
              status === 'ready'
                ? 'text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400'
                : status === 'error'
                  ? 'text-destructive bg-destructive/10'
                  : 'text-accent bg-accent/10'
            )}
          >{status}</span>
          <button className="text-xs text-muted-foreground hover:text-foreground transition-colors" onClick={onClear}>Clear</button>
        </div>
      </div>
      {selectedScopeLabel ? (
        <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-accent/20 text-xs">
          <span className="text-accent font-medium">{selectedScopeLabel}</span>
          <button className="text-muted-foreground hover:text-foreground transition-colors" onClick={onClearScope}>Clear Scope</button>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="border-b border-destructive/20 bg-destructive/8 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">
                {errorNotice ?? 'The last response failed before it finished.'}
              </p>
              <p className="text-xs text-muted-foreground">
                Retry the last turn or clear the thread and continue.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={onDumpTrace}
              >
                Dump Trace
              </button>
              <button
                className="rounded-md border border-destructive/30 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onRetry}
                disabled={!canRetry}
              >
                Retry
              </button>
              <button
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={onClear}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <article key={message.id} className="max-w-[85%] bg-primary text-primary-foreground rounded-2xl rounded-br-sm p-3 self-end">
                <pre className="whitespace-pre-wrap font-sans text-sm">{extractMessageText(message)}</pre>
              </article>
            );
          }
          const textParts: string[] = [];
          const toolParts = Array.isArray(message.parts)
            ? message.parts
              .filter(isToolUIPart)
              .map((part) => ({
                name: getToolName(part),
                state: part.state,
              }))
            : [];
          if (Array.isArray(message.parts)) {
            for (const part of message.parts) {
              if (isTextUIPart(part) && part.text) {
                textParts.push(part.text);
              }
            }
          }
          return (
            <article key={message.id} className="max-w-[90%] self-start space-y-2">
              {toolParts.length > 0 && (
                <div className="rounded-2xl border border-border/60 bg-card/80 px-3 py-2">
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Tool Activity
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                  {toolParts.map((tool, index) => (
                    <span
                      key={`${message.id}-${tool.name}-${index}`}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono border',
                        tool.state === 'output-error' || tool.state === 'output-denied'
                          ? 'bg-destructive/10 text-destructive border border-destructive/20'
                          : tool.state === 'output-available'
                            ? 'bg-accent/10 text-accent border-accent/20'
                            : 'bg-secondary text-secondary-foreground border-border'
                      )}
                    >
                      {tool.name.replace(/^(ui_|tool_)/, '')}
                      <span className="opacity-60">{tool.state}</span>
                    </span>
                  ))}
                  </div>
                </div>
              )}
              {textParts.length > 0 && (
                <div className="bg-secondary text-secondary-foreground rounded-2xl rounded-bl-sm p-3">
                  <Suspense fallback={<div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">{textParts.join('\n')}</div>}>
                    <LazyMarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      content={textParts.join('\n')}
                    />
                  </Suspense>
                </div>
              )}
            </article>
          );
        })}
      </div>
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
          placeholder={selectedScopeLabel ? 'Ask about the selected tile scope.' : 'Ask the agent to create files and panels.'}
          aria-label="Message the agent"
          rows={2}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submitComposer();
            }
          }}
        />
        <button className="bg-primary text-primary-foreground rounded-xl px-3 py-2 hover:opacity-90 transition-opacity self-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="submit" aria-label="Send message">
          <Send size={16} aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
