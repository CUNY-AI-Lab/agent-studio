import { ArrowLeft, Download, Keyboard, MessageSquare, RotateCcw, Share2, Trash2 } from 'lucide-react';
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
    <div className="shrink-0">
      <header className="ws-header flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-4 sm:px-5 sm:py-2.5">
        <button
          onClick={onGoHome}
          className="ui-icon-btn"
          title="Back to home"
          aria-label="Back to home"
        >
          <ArrowLeft size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
          <input
            className="ws-title"
            value={workspaceName}
            onChange={(event) => onNameChange(event.target.value)}
            aria-label="Workspace name"
          />
          <textarea
            className="ws-description"
            value={workspaceDescription}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="Describe this workspace."
            rows={1}
            aria-label="Workspace description"
          />
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1 sm:w-auto sm:flex-nowrap sm:shrink-0">
          <span className="ws-stat mr-2">
            {tileCount} {tileCount === 1 ? 'tile' : 'tiles'} · {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
          {modelCatalog ? (() => {
            const view = buildModelPickerView(modelCatalog, workspaceModel);
            return (
              <>
                <select
                  className="ui-field ui-field-sm ws-model"
                  value={view.effectiveModel}
                  onChange={(event) => onModelChange(event.target.value)}
                  title={view.effectiveRetiringNote ?? `Model: ${view.effectiveModel}`}
                  aria-label="Agent model"
                >
                  {view.unsupportedEffectiveModel ? (
                    <option value={view.unsupportedEffectiveModel} disabled>
                      {view.unsupportedEffectiveModel} (tools unavailable)
                    </option>
                  ) : null}
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
                {view.unsupportedEffectiveModel ? (
                  <span className="max-w-[18rem] text-[11px] leading-tight text-destructive" role="status">
                    This workspace’s model cannot use Agent Studio tools. Choose a function-capable model.
                  </span>
                ) : null}
              </>
            );
          })() : modelQuotaNotice ? (
            <div className="flex max-w-[14rem] items-center gap-1.5 text-[11px] text-muted-foreground" role="status" aria-live="polite">
              <select
                className="ui-field ui-field-sm ws-model"
                disabled
                aria-label="Model choices unavailable"
              >
                <option>Model choices unavailable</option>
              </select>
              <span className="truncate" title={modelQuotaNotice}>{modelQuotaNotice}</span>
            </div>
          ) : null}
          <span className="ui-sep hidden sm:block" aria-hidden="true" />
          <button className="ui-icon-btn" onClick={onRefresh} title="Refresh" aria-label="Refresh workspace">
            <RotateCcw size={16} aria-hidden="true" />
          </button>
          {!isCompactHeaderLayout ? (
            galleryId ? (
              <button
                className="ui-btn ui-btn-sm"
                onClick={onUnpublish}
                disabled={publishing}
              >
                {publishing ? 'Updating…' : 'Unpublish'}
              </button>
            ) : publishableArtifactCount > 0 ? (
              <button
                className="ui-btn ui-btn-sm"
                onClick={onOpenPublishModal}
                disabled={publishing}
              >
                Publish
              </button>
            ) : null
          ) : galleryId ? (
            <button
              className="ui-icon-btn"
              onClick={onUnpublish}
              disabled={publishing}
              title="Unpublish from gallery"
              aria-label="Unpublish from gallery"
            >
              <Share2 size={16} aria-hidden="true" />
            </button>
          ) : publishableArtifactCount > 0 ? (
            <button
              className="ui-icon-btn"
              onClick={onOpenPublishModal}
              disabled={publishing}
              title="Publish to gallery"
              aria-label="Publish to gallery"
            >
              <Share2 size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button className="ui-icon-btn" onClick={onExport} title="Export" aria-label="Export workspace">
            <Download size={16} aria-hidden="true" />
          </button>
          <button className="ui-icon-btn" onClick={onDelete} title="Delete workspace" aria-label="Delete workspace">
            <Trash2 size={16} aria-hidden="true" />
          </button>
          <button
            className="ui-icon-btn"
            onClick={onOpenShortcuts}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={16} aria-hidden="true" />
          </button>
          <span className="ui-sep hidden sm:block" aria-hidden="true" />
          <button className="ui-btn ui-btn-sm ui-btn-primary" onClick={onSave}>
            {savingWorkspace ? 'Saving…' : 'Save'}
          </button>
          <ThemeToggle />
          {isDockedChatLayout ? (
            <button
              onClick={onToggleChat}
              className="ui-icon-btn"
              title={chatOpen ? 'Hide chat' : 'Show chat'}
              aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
            >
              <MessageSquare size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      <div className="ws-header-rule" aria-hidden="true" />
    </div>
  );
}
