import { Download, MessageSquare, RotateCcw, Trash2 } from 'lucide-react';
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
}: {
  workspaceName: string;
  workspaceDescription: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  tileCount: number;
  fileCount: number;
  modelCatalog: ModelCatalog | null;
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
}) {
  return (
    <header className="canvas-header flex items-center gap-4 px-6 py-3">
      <button
        onClick={onGoHome}
        className="shrink-0 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Back to home"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
      </button>
      <div className="flex-1 min-w-0">
        <input
          className="font-serif text-lg font-medium bg-transparent border-none outline-none w-full text-foreground placeholder:text-muted-foreground"
          value={workspaceName}
          onChange={(event) => onNameChange(event.target.value)}
        />
        <textarea
          className="text-sm text-muted-foreground bg-transparent border-none outline-none w-full resize-none placeholder:text-muted-foreground"
          value={workspaceDescription}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="Describe this workspace."
          rows={1}
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
              className="mr-1 max-w-[9rem] rounded-md border border-border bg-transparent px-2 py-1 text-[11px] text-foreground/80 hover:text-foreground transition-colors cursor-pointer outline-none"
              value={view.effectiveModel}
              onChange={(event) => onModelChange(event.target.value)}
              title={view.effectiveRetiringNote ?? `Model: ${view.effectiveModel}`}
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
        })() : null}
        <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={onRefresh} title="Refresh">
          <RotateCcw size={16} />
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
        ) : null}
        <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={onExport} title="Export">
          <Download size={16} />
        </button>
        <button className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" onClick={onDelete} title="Delete workspace">
          <Trash2 size={16} />
        </button>
        <button className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity" onClick={onSave}>
          {savingWorkspace ? 'Saving…' : 'Save'}
        </button>
        <ThemeToggle />
        {isDockedChatLayout ? (
          <button
            onClick={onToggleChat}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={chatOpen ? 'Hide chat' : 'Show chat'}
          >
            <MessageSquare size={16} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
