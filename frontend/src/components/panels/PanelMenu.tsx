import { downloadBlob } from '../../lib/download';
import { canExportPanelSnapshot, getPanelTitle, type ToolbarDownloadFormat } from '../../lib/panelFiles';
import { getWorkspaceFileUrl } from '../../api';
import type { ContextualChatTarget } from '../../lib/messages';
import type { WorkspacePanel } from '../../types';

/**
 * The per-tile "…" context menu content. Rendered into DraggablePanel's
 * menuContent slot. All effectful callbacks are supplied by WorkspaceShell so
 * this stays a pure projection of the panel + handlers.
 */
export function PanelMenu({
  panel,
  workspaceId,
  maximizedPanelId,
  onAskAboutTile,
  onRevealFile,
  onPanelDownload,
  onCloseMenu,
  onMinimize,
  onMaximize,
  onSetContextualChatTarget,
  onClearContextualDraft,
  onSetMaximizedPanelId,
  onRemovePanel,
}: {
  panel: WorkspacePanel;
  workspaceId: string;
  maximizedPanelId: string | null;
  onAskAboutTile: (panelId: string) => void;
  onRevealFile: (filePath: string) => void;
  onPanelDownload: (panel: WorkspacePanel, format: ToolbarDownloadFormat) => void;
  onCloseMenu: () => void;
  onMinimize: (panelId: string) => void;
  onMaximize: (panelId: string) => void;
  onSetContextualChatTarget: (updater: (current: ContextualChatTarget | null) => ContextualChatTarget | null) => void;
  onClearContextualDraft: () => void;
  onSetMaximizedPanelId: (panelId: string | null) => void;
  onRemovePanel: (panelId: string) => void;
}) {
  return (
    <>
      <button
        onClick={() => {
          onAskAboutTile(panel.id);
          onCloseMenu();
        }}
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
      >
        Ask About This Tile
      </button>
      {'filePath' in panel && panel.filePath ? (
        (() => {
          const filePath = panel.filePath;
          return (
        <>
          <button
            onClick={() => {
              onRevealFile(filePath);
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Show in Workspace Files
          </button>
          <button
            onClick={() => {
              onPanelDownload(panel, 'file');
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Download File
          </button>
          <button
            onClick={() => {
              window.open(getWorkspaceFileUrl(workspaceId, filePath), '_blank', 'noopener,noreferrer');
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Open in New Tab
          </button>
        </>
          );
        })()
      ) : null}
      {panel.type === 'table' ? (
        <>
          <button
            onClick={() => {
              onPanelDownload(panel, 'csv');
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as CSV
          </button>
          <button
            onClick={() => {
              onPanelDownload(panel, 'json');
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as JSON
          </button>
        </>
      ) : null}
      {panel.type === 'chart' ? (
        <>
          <button
            onClick={() => {
              onPanelDownload(panel, 'csv');
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as CSV
          </button>
          <button
            onClick={() => {
              onPanelDownload(panel, 'json');
              onCloseMenu();
            }}
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
          >
            Export Data as JSON
          </button>
        </>
      ) : null}
      {panel.type === 'cards' ? (
        <button
          onClick={() => {
            onPanelDownload(panel, 'json');
            onCloseMenu();
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Export Data as JSON
        </button>
      ) : null}
      {panel.type === 'markdown' ? (
        <button
          onClick={() => {
            onPanelDownload(panel, 'txt');
            onCloseMenu();
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Export Markdown (.md)
        </button>
      ) : null}
      {panel.type === 'preview' && panel.content && !panel.filePath ? (
        <button
          onClick={() => {
            const safeTitle = getPanelTitle(panel).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'preview';
            downloadBlob(new Blob([panel.content || ''], { type: 'text/html;charset=utf-8' }), `${safeTitle}.html`);
            onCloseMenu();
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Download HTML Source
        </button>
      ) : null}
      {canExportPanelSnapshot(panel) ? (
        <button
          onClick={() => {
            onPanelDownload(panel, 'png');
            onCloseMenu();
          }}
          className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
        >
          Save Snapshot as PNG
        </button>
      ) : null}
      <button
        onClick={() => {
          onMinimize(panel.id);
          onSetContextualChatTarget((current) => {
            if (!current) return null;
            return current.panelIds.includes(panel.id) ? null : current;
          });
          onClearContextualDraft();
          if (maximizedPanelId === panel.id) {
            onSetMaximizedPanelId(null);
          }
          onCloseMenu();
        }}
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
      >
        Minimize
      </button>
      <button
        onClick={() => {
          onMaximize(panel.id);
          onCloseMenu();
        }}
        className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
      >
        Maximize
      </button>
      <div className="border-t border-border my-1" />
      <button
        onClick={() => {
          onRemovePanel(panel.id);
          onCloseMenu();
        }}
        className="w-full px-3 py-1.5 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors"
      >
        Remove
      </button>
    </>
  );
}
