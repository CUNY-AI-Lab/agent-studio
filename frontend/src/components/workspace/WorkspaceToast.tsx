import { cn } from '../../lib/utils';

export function WorkspaceToast({
  toast,
}: {
  toast: { message: string; type: 'success' | 'info' } | null;
}) {
  if (!toast) return null;

  return (
    <div className="toast-notification fixed top-20 right-4 z-50">
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm shadow-lg',
          toast.type === 'success'
            ? 'border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400'
            : 'border border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400'
        )}
      >
        {toast.type === 'success' ? (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
