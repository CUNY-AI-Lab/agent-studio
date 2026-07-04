import { afterEach, describe, expect, it } from 'vitest';
import { createFocusTrap, getFocusableElements } from './focusTrap';

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('getFocusableElements', () => {
  it('collects buttons, inputs and tabbable elements, skipping disabled ones', () => {
    const container = mount(`
      <button id="a">A</button>
      <input id="b" />
      <button id="c" disabled>C</button>
      <div id="d" tabindex="0">D</div>
      <div id="e" tabindex="-1">E</div>
    `);
    const ids = getFocusableElements(container).map((el) => el.id);
    expect(ids).toEqual(['a', 'b', 'd']);
  });
});

describe('createFocusTrap', () => {
  it('moves initial focus to the first focusable element', () => {
    const container = mount('<button id="first">First</button><button id="second">Second</button>');
    const trap = createFocusTrap(container);
    expect(document.activeElement?.id).toBe('first');
    trap.release();
  });

  it('honors an explicit initialFocus target', () => {
    const container = mount('<button id="first">First</button><button id="second">Second</button>');
    const second = container.querySelector<HTMLElement>('#second')!;
    const trap = createFocusTrap(container, { initialFocus: second });
    expect(document.activeElement?.id).toBe('second');
    trap.release();
  });

  it('wraps Tab from the last element back to the first', () => {
    const container = mount('<button id="first">First</button><button id="last">Last</button>');
    const first = container.querySelector<HTMLElement>('#first')!;
    const last = container.querySelector<HTMLElement>('#last')!;
    const trap = createFocusTrap(container);
    last.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    trap.release();
  });

  it('wraps Shift+Tab from the first element to the last', () => {
    const container = mount('<button id="first">First</button><button id="last">Last</button>');
    const first = container.querySelector<HTMLElement>('#first')!;
    const last = container.querySelector<HTMLElement>('#last')!;
    const trap = createFocusTrap(container);
    first.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    trap.release();
  });

  it('invokes onEscape when Escape is pressed', () => {
    const container = mount('<button id="first">First</button>');
    let escaped = false;
    const trap = createFocusTrap(container, { onEscape: () => { escaped = true; } });
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(escaped).toBe(true);
    trap.release();
  });

  it('restores focus to the previously-focused element on release', () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.append(outside);
    outside.focus();
    const container = mount('<button id="inside">Inside</button>');
    const trap = createFocusTrap(container);
    expect(document.activeElement?.id).toBe('inside');
    trap.release();
    expect(document.activeElement?.id).toBe('outside');
  });
});
