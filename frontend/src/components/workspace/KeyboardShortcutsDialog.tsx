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
      className="ui-backdrop"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        tabIndex={-1}
        className="ui-surface ui-surface-lg ui-dialog rule-lead max-w-lg focus:outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="keyboard-shortcuts-title">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
            className="ui-icon-btn"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="mb-5 text-[13px] leading-relaxed text-muted-foreground">
          Tab to a tile on the canvas, then use these keys. The canvas region
          itself handles zoom keys when focused.
        </p>
        <div className="max-h-[60vh] space-y-6 overflow-y-auto pr-1">
          {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="ui-section-head mb-2 font-sans">
                <span className="ui-label">{group.title}</span>
              </h3>
              <dl className="space-y-2">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.keys} className="flex items-start justify-between gap-4 text-[13.5px]">
                    <dt className="text-foreground/85">{shortcut.description}</dt>
                    <dd className="shrink-0">
                      <kbd className="ui-kbd">
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
