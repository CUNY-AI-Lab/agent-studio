'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';

interface WorkspaceCardProps {
  workspace: {
    id: string;
    name: string;
    description?: string;
    updatedAt: string;
  };
}

export function WorkspaceCard({ workspace }: WorkspaceCardProps) {
  const router = useRouter();

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm('Delete this workspace? This cannot be undone.')) return;

    try {
      const res = await apiFetch(`/api/workspaces/${workspace.id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete');
      }
    } catch (error) {
      console.error('Delete error:', error);
      alert('Failed to delete workspace');
    }
  };

  return (
    <div className="group relative flex items-center justify-between p-3 rounded-xl border border-border/50 bg-card/50 transition-all hover:border-primary/30 hover:bg-card">
      <Link
        href={`/w/${workspace.id}`}
        className="absolute inset-0 rounded-xl"
      />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium group-hover:text-primary transition-colors truncate">
          {workspace.name}
        </h3>
        {workspace.description && (
          <p className="text-xs text-muted-foreground truncate">
            {workspace.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 ml-4">
        <time className="text-xs text-muted-foreground/70">
          {new Date(workspace.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </time>
        <button
          onClick={handleDelete}
          className="relative z-10 p-1.5 rounded-lg text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition-all"
          title="Delete workspace"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </button>
      </div>
    </div>
  );
}
