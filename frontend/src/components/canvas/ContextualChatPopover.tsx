'use client';

import { Suspense, lazy, useRef, useEffect, useMemo } from 'react';
import { cn } from '../../lib/utils';

const LazyMarkdownRenderer = lazy(() => import('../renderers/MarkdownRenderer'));

type AnchorLayout = { x: number; y: number; width: number; height: number };
type Viewport = { x: number; y: number; zoom: number };

interface ContextualChatPopoverProps {
  anchor: AnchorLayout;
  viewport: Viewport;
  viewportSize?: { width: number; height: number } | null;
  title: string;
  typeLabel: string;
  messages?: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
  input: string;
  statusLabel?: string | null;
  isLoading?: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

type Placement = 'right' | 'left' | 'bottom';

export function ContextualChatPopover({
  anchor,
  viewport,
  viewportSize,
  title,
  typeLabel,
  messages = [],
  input,
  statusLabel,
  isLoading,
  onInputChange,
  onSubmit,
  onClose,
}: ContextualChatPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const popoverWidth = 280;
  const popoverHeight = 300;
  const gap = 12;

  const position = useMemo(() => {
    const viewportWidth = viewportSize?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const viewportHeight = viewportSize?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);
    const screenRight = (anchor.x + anchor.width) * viewport.zoom + viewport.x;
    const screenLeft = anchor.x * viewport.zoom + viewport.x;
    const screenTop = anchor.y * viewport.zoom + viewport.y;
    const screenBottom = (anchor.y + anchor.height) * viewport.zoom + viewport.y;

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    const maxX = Math.max(gap, viewportWidth - popoverWidth - gap);
    const maxY = Math.max(gap, viewportHeight - popoverHeight - gap);

    if (screenRight + gap + popoverWidth < viewportWidth) {
      const screenX = screenRight + gap;
      const screenY = clamp(screenTop, gap, maxY);
      return {
        x: (screenX - viewport.x) / viewport.zoom,
        y: (screenY - viewport.y) / viewport.zoom,
        placement: 'right' as Placement,
      };
    }

    if (screenLeft - gap - popoverWidth > 0) {
      const screenX = screenLeft - gap - popoverWidth;
      const screenY = clamp(screenTop, gap, maxY);
      return {
        x: (screenX - viewport.x) / viewport.zoom,
        y: (screenY - viewport.y) / viewport.zoom,
        placement: 'left' as Placement,
      };
    }

    const screenX = clamp(screenLeft, gap, maxX);
    const screenY = clamp(screenBottom + gap, gap, maxY);
    return {
      x: (screenX - viewport.x) / viewport.zoom,
      y: (screenY - viewport.y) / viewport.zoom,
      placement: 'bottom' as Placement,
    };
  }, [anchor, viewport, viewportSize]);

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    const behavior: ScrollBehavior = isLoading ? 'auto' : 'smooth';
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, [messages, isLoading]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className={cn(
        'contextual-chat-popover absolute flex flex-col no-zoom-scroll',
        position.placement === 'right' && 'origin-left',
        position.placement === 'left' && 'origin-right',
        position.placement === 'bottom' && 'origin-top'
      )}
      style={{
        left: position.x,
        top: position.y,
        width: popoverWidth,
        maxHeight: popoverHeight,
        transform: `scale(${1 / viewport.zoom})`,
        transformOrigin: position.placement === 'right' ? 'left top' : position.placement === 'left' ? 'right top' : 'top left',
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="contextual-chat-header">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="contextual-chat-icon">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="contextual-chat-label">Ask about</span>
            <span className="contextual-chat-title truncate block">{title}</span>
          </div>
        </div>
        <button onClick={onClose} className="contextual-chat-close" aria-label="Close">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="contextual-chat-messages flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="contextual-chat-empty">
            <p>Ask a question about this {typeLabel.toLowerCase()} tile.</p>
            <p className="text-xs opacity-60 mt-1">New tiles created here will be connected to this one.</p>
          </div>
        ) : (
          messages.map((message) => {
            if (message.role === 'assistant' && !message.content) return null;
            return (
              <div
                key={message.id}
                className={cn(
                  'contextual-chat-message',
                  message.role === 'user' ? 'contextual-chat-message-user' : 'contextual-chat-message-assistant'
                )}
              >
                {message.role === 'user' ? (
                  <div className="whitespace-pre-wrap">{message.content}</div>
                ) : (
                  <Suspense fallback={<div className="prose prose-sm max-w-none text-[13px] leading-relaxed prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-li:my-0 dark:prose-invert whitespace-pre-wrap">{message.content}</div>}>
                    <LazyMarkdownRenderer
                      className="prose prose-sm max-w-none text-[13px] leading-relaxed prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-li:my-0 dark:prose-invert"
                      content={message.content}
                    />
                  </Suspense>
                )}
              </div>
            );
          })
        )}
        {isLoading ? (
          <div className="contextual-chat-loading">
            <div className="contextual-chat-loading-dots">
              <span className="contextual-chat-loading-dot" />
              <span className="contextual-chat-loading-dot" />
              <span className="contextual-chat-loading-dot" />
            </div>
            {statusLabel ? <span className="contextual-chat-loading-label">{statusLabel}</span> : null}
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim() || isLoading) return;
          onSubmit();
        }}
        className="contextual-chat-input-container"
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!input.trim() || isLoading) return;
              onSubmit();
            }
          }}
          placeholder={`Ask about this ${typeLabel.toLowerCase()} tile...`}
          className="contextual-chat-input"
          rows={1}
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="contextual-chat-send"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </form>
    </div>
  );
}
