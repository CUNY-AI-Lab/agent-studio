import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, CANVAS_WHEEL_CONFIG } from './canvasViewport';

describe('canvas viewport integration', () => {
  it('wires a cursor-anchored smooth wheel event through the real transform runtime', () => {
    const { container } = render(
      <TransformWrapper
        initialScale={1}
        initialPositionX={0}
        initialPositionY={0}
        minScale={CANVAS_MIN_ZOOM}
        maxScale={CANVAS_MAX_ZOOM}
        limitToBounds={false}
        centerZoomedOut={false}
        wheel={CANVAS_WHEEL_CONFIG}
        panning={{ velocityDisabled: false, allowLeftClickPan: true, allowMiddleClickPan: true }}
      >
        <TransformComponent>
          <div data-testid="canvas-content" style={{ width: 1000, height: 800 }} />
        </TransformComponent>
      </TransformWrapper>,
    );

    const content = container.querySelector('[data-testid="canvas-content"]');
    expect(content).not.toBeNull();
    if (!(content instanceof HTMLElement)) throw new Error('Canvas content was not mounted');
    Object.defineProperty(content, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });

    act(() => {
      fireEvent.wheel(content, { deltaY: -100, clientX: 250, clientY: 200 });
    });

    const transformed = content.parentElement;
    expect(transformed).not.toBeNull();
    expect(transformed?.style.transform).toContain('scale(1.08)');
    expect(transformed?.style.transform).toContain('translate(-20px, -16px)');
  });
});
