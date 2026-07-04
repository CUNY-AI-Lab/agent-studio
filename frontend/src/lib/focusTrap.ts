/**
 * Hand-rolled focus utilities for modal dialogs. No runtime dependency — the
 * accessibility pass forbids adding one, and a dialog trap is small enough to
 * own directly.
 *
 * `createFocusTrap` keeps Tab / Shift+Tab cycling inside the container, moves
 * initial focus in, and restores focus to the previously-focused element when
 * released. Wire it up from a component effect keyed on the dialog's open state.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((node) => {
    if (node.hasAttribute('disabled')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    // Skip elements that are not rendered (display:none / detached). In jsdom
    // offsetParent is null for many valid elements, so fall back to rect checks
    // only when layout data is available.
    if (typeof node.getClientRects === 'function') {
      const hasRects = node.getClientRects().length > 0;
      const isConnected = node.isConnected;
      if (isConnected && !hasRects && node.offsetParent === null) {
        // In real browsers this reliably means hidden; jsdom returns 0 rects for
        // everything, so also require offsetParent to be null before excluding.
        const style = typeof window !== 'undefined' ? window.getComputedStyle(node) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) {
          return false;
        }
      }
    }
    return true;
  });
}

export interface FocusTrap {
  /** Call to tear down listeners and restore focus to the prior element. */
  release: () => void;
}

export interface FocusTrapOptions {
  /** Element to focus first. Defaults to the first focusable, else the container. */
  initialFocus?: HTMLElement | null;
  /** Invoked when Escape is pressed inside the trap. */
  onEscape?: () => void;
  /** Element to restore focus to on release. Defaults to document.activeElement. */
  returnFocusTo?: HTMLElement | null;
}

/**
 * Activate a focus trap on `container`. Returns a handle whose `release()` must
 * be called (typically in an effect cleanup) to remove listeners and restore
 * focus.
 */
export function createFocusTrap(
  container: HTMLElement,
  options: FocusTrapOptions = {}
): FocusTrap {
  const previouslyFocused =
    options.returnFocusTo ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const focusFirst = () => {
    const initial = options.initialFocus;
    if (initial && container.contains(initial)) {
      initial.focus();
      return;
    }
    const focusable = getFocusableElements(container);
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      container.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = getFocusableElements(container);
    if (focusable.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (active === first || active === container || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  focusFirst();
  container.addEventListener('keydown', handleKeyDown);

  return {
    release: () => {
      container.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    },
  };
}
