import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadFileSource, type FileSource } from './fileUrls';

describe('downloadFileSource', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('uses the shared delayed-revocation download primitive', async () => {
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const createObjectUrl = vi.fn(() => 'blob:notes');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const fetcher = vi.fn<(source: FileSource, filePath: string) => Promise<Response>>()
      .mockResolvedValue(new Response('notes', { status: 200 }));

    vi.useFakeTimers();
    try {
      await downloadFileSource({ kind: 'workspace', id: 'workspace-1' }, 'notes.md', 'notes.md', fetcher);

      expect(fetcher).toHaveBeenCalledWith({ kind: 'workspace', id: 'workspace-1' }, 'notes.md');
      expect(createObjectUrl).toHaveBeenCalledOnce();
      expect(anchorClick).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).not.toHaveBeenCalled();

      vi.advanceTimersByTime(999);
      expect(revokeObjectUrl).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:notes');
    } finally {
      anchorClick.mockRestore();
      vi.useRealTimers();
      if (createObjectUrlDescriptor) {
        Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
      } else {
        Reflect.deleteProperty(URL, 'createObjectURL');
      }
      if (revokeObjectUrlDescriptor) {
        Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
      } else {
        Reflect.deleteProperty(URL, 'revokeObjectURL');
      }
    }
  });
});
