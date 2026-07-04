import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { KEYBOARD_SHORTCUT_GROUPS } from '../../lib/keyboardMap';
import { createFocusTrap } from '../../lib/focusTrap';

/**
 * Discoverable canvas keyboard reference. A real modal dialog (role="dialog",
 * aria-modal, focus-trapped, Escape to close, focus restored on close) so the
 * keyboard feature is findable by keyboard and screen-reader users. Content is
 * driven by the shared KEYBOARD_SHORTCUT_GROUPS so it never drifts from the docs.
 */
export function KeyboardShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const trap = createFocusTrap(dialogRef.current, { onEscape: onClose });
    return () => trap.release();
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        tabIndex={-1}
        className="mx-4 w-full max-w-lg rounded-2xl bg-card p-6 shadow-xl focus:outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="keyboard-shortcuts-title" className="text-lg font-semibold">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Tab to a tile on the canvas, then use these keys. The canvas region
          itself handles zoom keys when focused.
        </p>
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </h3>
              <dl className="space-y-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys} className="flex items-start justify-between gap-4 text-sm">
                    <dt className="text-foreground/80">{shortcut.description}</dt>
                    <dd className="shrink-0">
                      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                        {shortcut.keys}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
