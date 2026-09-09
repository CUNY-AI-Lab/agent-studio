import { Suspense, lazy, useEffect, useState } from 'react';
import { LoaderCircle, MessageSquare, Send, Square } from 'lucide-react';
import { isTextUIPart, type UIMessage } from 'ai';
import { cn } from '../../lib/utils';
import { extractMessageText, getToolNotices } from '../../lib/messages';
import type { ChatActivityState } from '../../lib/chatActivity';
import { lastFinishedToolActivity } from '../../lib/toolActivity';

const LazyMarkdownRenderer = lazy(() => import('../renderers/MarkdownRenderer'));

function WorkingProgress({ detail }: { detail: string }) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <div className="chat-working">
      <LoaderCircle size={18} className="shrink-0 animate-spin motion-reduce:animate-none text-rule" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p role="status" className="chat-working-detail">{detail}</p>
        <p className="chat-working-hint">You can stop this response at any time.</p>
      </div>
      <span className="chat-working-elapsed shrink-0" aria-label={`Elapsed time: ${elapsed} seconds`}>
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
      <div className="chat-header">
        <h3>
          <MessageSquare size={15} aria-hidden="true" />Chat
        </h3>
        <div className="flex items-center gap-3">
          <span
            role="status"
            aria-live="polite"
            aria-label={`Chat status: ${activity.label}`}
            className={cn(
              'ui-status',
              activity.tone === 'ready'
                ? 'ui-status-ready'
                : activity.tone === 'error'
                  ? 'ui-status-error'
                  : 'ui-status-working'
            )}
          >{activity.label}</span>
          {activity.canStop ? (
            <button
              className="ui-link ui-link-danger"
              onClick={onStop}
              aria-label="Stop response"
            >
              <Square size={11} aria-hidden="true" />
              Stop response
            </button>
          ) : (
            <button
              className="ui-link ui-link-muted"
              onClick={clearConversation}
              aria-label="Clear conversation"
            >
              Clear conversation
            </button>
          )}
        </div>
      </div>
      {selectedScopeLabel ? (
        <div className="chat-scope">
          <span className="chat-scope-label">{selectedScopeLabel}</span>
          <button className="ui-link ui-link-muted shrink-0" onClick={onClearScope}>Clear selection</button>
        </div>
      ) : null}
      {activity.phase === 'error' ? (
        <div className="chat-error">
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
                  className="ui-btn ui-btn-sm ui-btn-danger"
                  onClick={onReload}
                >
                  Reload page
                </button>
              ) : (
                <button
                  className="ui-btn ui-btn-sm ui-btn-danger"
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
      <div className="chat-messages">
        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <article key={message.id} className="chat-user-block">
                {extractMessageText(message)}
              </article>
            );
          }
          const textParts: string[] = [];
          if (Array.isArray(message.parts)) {
            for (const part of message.parts) {
              if (isTextUIPart(part) && part.text) {
                textParts.push(part.text);
              }
            }
          }
          const toolNotices = getToolNotices(message);
          const finishedToolActivity = lastFinishedToolActivity(message);
          if (textParts.length === 0 && toolNotices.length === 0 && !finishedToolActivity) return null;
          return (
            <article key={message.id} className="chat-assistant">
              {finishedToolActivity ? <p className="chat-tool-line">{finishedToolActivity}</p> : null}
              {toolNotices.map((notice) => (
                <p
                  key={`${message.id}-${notice.kind}`}
                  role={notice.kind === 'error' ? 'alert' : 'status'}
                  className={cn(
                    'chat-tool-block',
                    notice.kind === 'error'
                      ? 'chat-tool-block-error'
                      : notice.kind === 'approval'
                        ? 'chat-tool-block-approval'
                        : null
                  )}
                >
                  {notice.message}
                </p>
              ))}
              {textParts.length > 0 && (
                <div className="chat-assistant-text">
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
      {activity.phase === 'working' ? <WorkingProgress detail={activity.detail} /> : null}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submitComposer();
        }}
      >
        <div className="composer-frame">
          <textarea
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
            className="ui-btn ui-btn-primary chat-send"
            type="submit"
            aria-label="Send message"
            disabled={!activity.canSubmit || !composer.trim()}
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </section>
  );
}
