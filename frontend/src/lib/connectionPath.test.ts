import { describe, expect, it } from 'vitest';
import { generateConnectionPath, getConnectionEdgePoint } from './connectionPath';

const left = { x: 0, y: 0, width: 100, height: 100 };
const right = { x: 300, y: 0, width: 100, height: 100 };
const below = { x: 0, y: 300, width: 100, height: 100 };

describe('getConnectionEdgePoint', () => {
  it('exits from the right edge of the source toward a target on its right', () => {
    const point = getConnectionEdgePoint(left, right, true);
    expect(point).toEqual({ x: 100, y: 50, side: 'right' });
  });

  it('enters the left edge of the target from a source on its left', () => {
    const point = getConnectionEdgePoint(left, right, false);
    expect(point).toEqual({ x: 300, y: 50, side: 'left' });
  });

  it('uses vertical edges when the vertical distance dominates', () => {
    const source = getConnectionEdgePoint(left, below, true);
    expect(source).toEqual({ x: 50, y: 100, side: 'bottom' });
    const target = getConnectionEdgePoint(left, below, false);
    expect(target).toEqual({ x: 50, y: 300, side: 'top' });
  });
});

describe('generateConnectionPath', () => {
  it('builds a cubic bezier bowing outward from each side by the curvature', () => {
    const source = getConnectionEdgePoint(left, right, true); // right edge
    const target = getConnectionEdgePoint(left, right, false); // left edge
    const path = generateConnectionPath(source, target);
    // source right edge => +80 on control x; target left edge => -80 on control x
    expect(path).toBe('M 100 50 C 180 50, 220 50, 300 50');
  });

  it('offsets control points vertically for top/bottom sides', () => {
    const source = getConnectionEdgePoint(left, below, true); // bottom
    const target = getConnectionEdgePoint(left, below, false); // top
    const path = generateConnectionPath(source, target);
    expect(path).toBe('M 50 100 C 50 180, 50 220, 50 300');
  });
});
