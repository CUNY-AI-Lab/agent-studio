/**
 * Canonical canvas keyboard map. Single source of truth for the discoverable
 * "Keyboard shortcuts" dialog and for ACCESSIBILITY.md. Keep this list in sync
 * with the handlers in App.tsx (WorkspaceShell) and components/canvas/*.
 */

export interface KeyboardShortcut {
  /** Human-readable key combo, e.g. "Arrow keys" or "Cmd / Ctrl + G". */
  keys: string;
  /** What the combo does when the canvas or a tile has focus. */
  description: string;
}

export interface KeyboardShortcutGroup {
  title: string;
  shortcuts: KeyboardShortcut[];
}

export const CANVAS_STEP = 16;
export const CANVAS_LARGE_STEP = 64;
export const CANVAS_RESIZE_STEP = 16;

export const KEYBOARD_SHORTCUT_GROUPS: KeyboardShortcutGroup[] = [
  {
    title: 'Focus & selection',
    shortcuts: [
      { keys: 'Tab / Shift + Tab', description: 'Move focus between tiles and controls' },
      { keys: 'Enter / Space', description: 'Toggle selection of the focused tile' },
      { keys: 'Escape', description: 'Clear selection, close popover, or exit maximized view' },
      { keys: 'Delete / Backspace', description: 'Remove the selected tiles' },
    ],
  },
  {
    title: 'Move & resize the focused tile',
    shortcuts: [
      { keys: 'Arrow keys', description: `Move the tile by ${CANVAS_STEP}px` },
      { keys: 'Shift + Arrow keys', description: `Move the tile by ${CANVAS_LARGE_STEP}px` },
      { keys: 'Alt + Arrow keys', description: `Resize the tile by ${CANVAS_RESIZE_STEP}px` },
      { keys: 'M', description: 'Open the tile menu' },
    ],
  },
  {
    title: 'Groups & layout',
    shortcuts: [
      { keys: 'Cmd / Ctrl + G', description: 'Group the selected tiles' },
      { keys: 'Cmd / Ctrl + Shift + G', description: 'Ungroup the selected group' },
      { keys: 'Enter / Space', description: 'Select the focused group boundary' },
      { keys: 'Arrow keys', description: `Move the focused group by ${CANVAS_STEP}px` },
      { keys: 'F2', description: 'Rename the focused group' },
    ],
  },
  {
    title: 'Canvas view',
    shortcuts: [
      { keys: '+ / =', description: 'Zoom in (when the canvas is focused)' },
      { keys: '- / _', description: 'Zoom out (when the canvas is focused)' },
      { keys: '0', description: 'Reset zoom and position (when the canvas is focused)' },
      { keys: 'Space + drag', description: 'Pan the canvas (mouse)' },
      { keys: '?', description: 'Open the keyboard shortcuts dialog' },
    ],
  },
];
