'use client';

interface SelectionBoxProps {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export function SelectionBox({ start, end }: SelectionBoxProps) {
  // Calculate the rectangle bounds
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  if (width < 5 && height < 5) return null;

  return (
    <div
      className="selection-box absolute pointer-events-none"
      style={{
        left,
        top,
        width,
        height,
      }}
    />
  );
}
