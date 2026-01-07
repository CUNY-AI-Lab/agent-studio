'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { CanvasPanelLayout } from '@/lib/storage';
import { SafeMarkdown } from '@/components/SafeMarkdown';

interface ContextualChatPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  anchorLayout: CanvasPanelLayout;
  panelTitle: string;
  panelType: string;
  scale: number;
  viewportOffset: { x: number; y: number };
  viewportSize?: { width: number; height: number };
  onSendMessage: (message: string) => void;
  isLoading?: boolean;
  messages?: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
  statusLabel?: string | null;
}

type Placement = 'right' | 'left' | 'bottom';

export function ContextualChatPopover({
  isOpen,
  onClose,
  anchorLayout,
  panelTitle,
  panelType,
  scale,
  viewportOffset,
  viewportSize,
  onSendMessage,
  isLoading,
  messages = [],
  statusLabel,
}: ContextualChatPopoverProps) {
  const [inputValue, setInputValue] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const POPOVER_WIDTH = 280;
  const POPOVER_HEIGHT = 300;
  const GAP = 12;

  // Memoized position calculation based on anchor panel
  const position = useMemo(() => {
    // Get viewport dimensions
    const viewportWidth = viewportSize?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const viewportHeight = viewportSize?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

    // Convert anchor to screen coordinates
    const screenRight = (anchorLayout.x + anchorLayout.width) * scale + viewportOffset.x;
    const screenLeft = anchorLayout.x * scale + viewportOffset.x;
    const screenTop = anchorLayout.y * scale + viewportOffset.y;
    const screenBottom = (anchorLayout.y + anchorLayout.height) * scale + viewportOffset.y;

    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    const maxX = Math.max(GAP, viewportWidth - POPOVER_WIDTH - GAP);
    const maxY = Math.max(GAP, viewportHeight - POPOVER_HEIGHT - GAP);

    // Try right side first
    if (screenRight + GAP + POPOVER_WIDTH < viewportWidth) {
      const screenX = screenRight + GAP;
      const screenY = clamp(screenTop, GAP, maxY);
      return {
        x: (screenX - viewportOffset.x) / scale,
        y: (screenY - viewportOffset.y) / scale,
        placement: 'right' as Placement,
      };
    }

    // Try left side
    if (screenLeft - GAP - POPOVER_WIDTH > 0) {
      const screenX = screenLeft - GAP - POPOVER_WIDTH;
      const screenY = clamp(screenTop, GAP, maxY);
      return {
        x: (screenX - viewportOffset.x) / scale,
        y: (screenY - viewportOffset.y) / scale,
        placement: 'left' as Placement,
      };
    }

    // Fall back to bottom
    const screenX = clamp(screenLeft, GAP, maxX);
    const screenY = clamp(screenBottom + GAP, GAP, maxY);
    return {
      x: (screenX - viewportOffset.x) / scale,
      y: (screenY - viewportOffset.y) / scale,
      placement: 'bottom' as Placement,
    };
  }, [anchorLayout, scale, viewportOffset, viewportSize]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const behavior = isLoading ? 'auto' : 'smooth';
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, [messages, isLoading, isOpen]);

  // Handle click outside to close
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    onSendMessage(inputValue.trim());
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      ref={popoverRef}
      className={cn(
        "contextual-chat-popover absolute flex flex-col no-zoom-scroll",
        position.placement === 'right' && "origin-left",
        position.placement === 'left' && "origin-right",
        position.placement === 'bottom' && "origin-top"
      )}
      style={{
        left: position.x,
        top: position.y,
        width: POPOVER_WIDTH,
        maxHeight: POPOVER_HEIGHT,
        transform: `scale(${1 / scale})`,
        transformOrigin: position.placement === 'right' ? 'left top' : position.placement === 'left' ? 'right top' : 'top left',
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="contextual-chat-header">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="contextual-chat-icon">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="contextual-chat-label">Ask about</span>
            <span className="contextual-chat-title truncate block">{panelTitle}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="contextual-chat-close"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="contextual-chat-messages flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="contextual-chat-empty">
            <p>Ask a question about this {panelType}.</p>
            <p className="text-xs opacity-60 mt-1">New panels created will be connected to this one.</p>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === 'assistant' && !msg.content) return null;
            return (
              <div
                key={msg.id}
                className={cn(
                  "contextual-chat-message",
                  msg.role === 'user' ? "contextual-chat-message-user" : "contextual-chat-message-assistant"
                )}
              >
                {msg.role === 'user' ? (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                ) : (
                  <SafeMarkdown className="prose prose-sm max-w-none text-[13px] leading-relaxed prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-li:my-0 dark:prose-invert">
                    {msg.content}
                  </SafeMarkdown>
                )}
              </div>
            );
          })
        )}
        {isLoading && (
          <div className="contextual-chat-loading">
            <div className="contextual-chat-loading-dots">
              <span className="contextual-chat-loading-dot" />
              <span className="contextual-chat-loading-dot" />
              <span className="contextual-chat-loading-dot" />
            </div>
            {statusLabel && <span className="contextual-chat-loading-label">{statusLabel}</span>}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="contextual-chat-input-container">
        <textarea
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Ask about this ${panelType}...`}
          className="contextual-chat-input"
          rows={1}
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || isLoading}
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
