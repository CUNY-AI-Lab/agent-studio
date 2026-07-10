import { Download, Keyboard, MessageSquare, RotateCcw, Share2, Trash2 } from 'lucide-react';
import { ThemeToggle } from '../ThemeToggle';
import { buildModelPickerView, type ModelCatalog } from '../../api';

/**
 * Workspace canvas header: editable title/description, tile/file counts,
 * model picker, and the refresh/publish/export/delete/save action cluster.
 * Purely presentational — all state and handlers come from WorkspaceShell.
 */
export function WorkspaceHeader({
  workspaceName,
  workspaceDescription,
  onNameChange,
  onDescriptionChange,
  tileCount,
  fileCount,
  modelCatalog,
  modelQuotaNotice,
  workspaceModel,
  onModelChange,
  onGoHome,
  onRefresh,
  onExport,
  onDelete,
  onSave,
  savingWorkspace,
  isCompactHeaderLayout,
  galleryId,
  publishing,
  publishableArtifactCount,
  onUnpublish,
  onOpenPublishModal,
  isDockedChatLayout,
  chatOpen,
  onToggleChat,
  onOpenShortcuts,
}: {
  workspaceName: string;
  workspaceDescription: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  tileCount: number;
  fileCount: number;
  modelCatalog: ModelCatalog | null;
  modelQuotaNotice: string | null;
  workspaceModel: string | undefined;
  onModelChange: (modelId: string) => void;
  onGoHome: () => void;
  onRefresh: () => void;
  onExport: () => void;
  onDelete: () => void;
  onSave: () => void;
  savingWorkspace: boolean;
  isCompactHeaderLayout: boolean;
  galleryId: string | null | undefined;
  publishing: boolean;
  publishableArtifactCount: number;
  onUnpublish: () => void;
  onOpenPublishModal: () => void;
  isDockedChatLayout: boolean;
  chatOpen: boolean;
  onToggleChat: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <header className="canvas-header flex items-center gap-4 px-6 py-3">
      <button
        onClick={onGoHome}
        className="shrink-0 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title="Back to home"
        aria-label="Back to home"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
      </button>
      <div className="flex-1 min-w-0">
        <input
          className="font-serif text-lg font-medium bg-transparent border-none outline-none w-full text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring rounded"
          value={workspaceName}
          onChange={(event) => onNameChange(event.target.value)}
          aria-label="Workspace name"
        />
        <textarea
          className="text-sm text-muted-foreground bg-transparent border-none outline-none w-full resize-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring rounded"
          value={workspaceDescription}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="Describe this workspace."
          rows={1}
          aria-label="Workspace description"
        />
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-xs text-muted-foreground font-mono mr-2">
          {tileCount}T · {fileCount}F
        </span>
        {modelCatalog ? (() => {
          const view = buildModelPickerView(modelCatalog, workspaceModel);
          return (
            <select
              className="mr-1 max-w-[9rem] rounded-md border border-border bg-transparent px-2 py-1 text-[11px] text-foreground/80 hover:text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={view.effectiveModel}
              onChange={(event) => onModelChange(event.target.value)}
              title={view.effectiveRetiringNote ?? `Model: ${view.effectiveModel}`}
              aria-label="Agent model"
            >
              {view.recommended.map((option) => (
                <option key={option.id} value={option.id} title={option.title}>
                  {option.label}
                </option>
              ))}
              {view.advanced.length > 0 ? (
                <optgroup label="Other models">
                  {view.advanced.map((option) => (
                    <option key={option.id} value={option.id} title={option.title}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          );
        })() : modelQuotaNotice ? (
          <select
            className="mr-1 max-w-[9rem] rounded-md border border-border bg-transparent px-2 py-1 text-[11px] text-foreground/80 transition-colors cursor-not-allowed opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled
            title={modelQuotaNotice}
            aria-label="Agent model (unavailable: quota reached)"
          >
            <option>Models unavailable — quota reached</option>
          </select>
        ) : null}
        <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onRefresh} title="Refresh" aria-label="Refresh workspace">
          <RotateCcw size={16} aria-hidden="true" />
        </button>
        {!isCompactHeaderLayout ? (
          galleryId ? (
            <button
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              onClick={onUnpublish}
              disabled={publishing}
            >
              {publishing ? 'Updating…' : 'Unpublish'}
            </button>
          ) : publishableArtifactCount > 0 ? (
            <button
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              onClick={onOpenPublishModal}
              disabled={publishing}
            >
              Publish
            </button>
          ) : null
        ) : galleryId ? (
          <button
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onUnpublish}
            disabled={publishing}
            title="Unpublish from gallery"
            aria-label="Unpublish from gallery"
          >
            <Share2 size={16} aria-hidden="true" />
          </button>
        ) : publishableArtifactCount > 0 ? (
          <button
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpenPublishModal}
            disabled={publishing}
            title="Publish to gallery"
            aria-label="Publish to gallery"
          >
            <Share2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onExport} title="Export" aria-label="Export workspace">
          <Download size={16} aria-hidden="true" />
        </button>
        <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onDelete} title="Delete workspace" aria-label="Delete workspace">
          <Trash2 size={16} aria-hidden="true" />
        </button>
        <button
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={16} aria-hidden="true" />
        </button>
        <button className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onSave}>
          {savingWorkspace ? 'Saving…' : 'Save'}
        </button>
        <ThemeToggle />
        {isDockedChatLayout ? (
          <button
            onClick={onToggleChat}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={chatOpen ? 'Hide chat' : 'Show chat'}
            aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
          >
            <MessageSquare size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
