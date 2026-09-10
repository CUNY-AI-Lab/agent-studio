import { Check, Info } from 'lucide-react';
import { cn } from '../../lib/utils';

export function WorkspaceToast({
  toast,
}: {
  toast: { message: string; type: 'success' | 'info' } | null;
}) {
  if (!toast) return null;

  return (
    <div
      className="toast-notification fixed top-20 right-4 z-50"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className={cn(
          'ui-surface toast-body',
          toast.type === 'success' ? 'toast-success' : 'toast-info'
        )}
      >
        {toast.type === 'success' ? (
          <Check size={16} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Info size={16} aria-hidden="true" />
        )}
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
