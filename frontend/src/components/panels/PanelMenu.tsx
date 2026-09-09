import { downloadBlob } from '../../lib/download';
import { canExportPanelSnapshot, getPanelTitle, type ToolbarDownloadFormat } from '../../lib/panelFiles';
import type { WorkspacePanel } from '../../types';

/**
 * The per-tile "…" context menu content. Rendered into the canvas node's
 * menuContent slot. All effectful callbacks are supplied by WorkspaceShell so
 * this stays a pure projection of the panel + handlers.
 */
export function PanelMenu({
  panel,
  maximizedPanelId,
  onAskAboutTile,
  onRevealFile,
  onPanelDownload,
  onCloseMenu,
  onMinimize,
  onMaximize,
  onSetMaximizedPanelId,
  onRemovePanel,
}: {
  panel: WorkspacePanel;
  maximizedPanelId: string | null;
  onAskAboutTile: (panelId: string) => void;
  onRevealFile: (filePath: string) => void;
  onPanelDownload: (panel: WorkspacePanel, format: ToolbarDownloadFormat) => void;
  onCloseMenu: () => void;
  onMinimize: (panelId: string) => void;
  onMaximize: (panelId: string) => void;
  onSetMaximizedPanelId: (panelId: string | null) => void;
  onRemovePanel: (panelId: string) => void;
}) {
  return (
    <>
      <button
        role="menuitem"
        onClick={() => {
          onAskAboutTile(panel.id);
          onCloseMenu();
        }}
        className="ui-menu-item"
      >
        Ask about this tile
      </button>
      {'filePath' in panel && panel.filePath ? (
        (() => {
          const filePath = panel.filePath;
          return (
        <>
          <button
        role="menuitem"
            onClick={() => {
              onRevealFile(filePath);
              onCloseMenu();
            }}
            className="ui-menu-item"
          >
            Show in workspace files
          </button>
          <button
        role="menuitem"
            onClick={() => {
              onPanelDownload(panel, 'file');
              onCloseMenu();
            }}
            className="ui-menu-item"
          >
            Download
          </button>
        </>
          );
        })()
      ) : null}
      {panel.type === 'table' ? (
        <>
          <button
        role="menuitem"
            onClick={() => {
              onPanelDownload(panel, 'csv');
              onCloseMenu();
            }}
            className="ui-menu-item"
          >
            Export as CSV
          </button>
          <button
        role="menuitem"
            onClick={() => {
              onPanelDownload(panel, 'json');
              onCloseMenu();
            }}
            className="ui-menu-item"
          >
            Export as JSON
          </button>
        </>
      ) : null}
      {panel.type === 'chart' ? (
        <>
          <button
        role="menuitem"
            onClick={() => {
              onPanelDownload(panel, 'csv');
              onCloseMenu();
            }}
            className="ui-menu-item"
          >
            Export as CSV
          </button>
          <button
        role="menuitem"
            onClick={() => {
              onPanelDownload(panel, 'json');
              onCloseMenu();
            }}
            className="ui-menu-item"
          >
            Export as JSON
          </button>
        </>
      ) : null}
      {panel.type === 'cards' ? (
        <button
        role="menuitem"
          onClick={() => {
            onPanelDownload(panel, 'json');
            onCloseMenu();
          }}
          className="ui-menu-item"
        >
          Export as JSON
        </button>
      ) : null}
      {panel.type === 'markdown' ? (
        <button
        role="menuitem"
          onClick={() => {
            onPanelDownload(panel, 'txt');
            onCloseMenu();
          }}
          className="ui-menu-item"
        >
          Export Markdown (.md)
        </button>
      ) : null}
      {panel.type === 'preview' && panel.content && !panel.filePath ? (
        <button
        role="menuitem"
          onClick={() => {
            const safeTitle = getPanelTitle(panel).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'preview';
            downloadBlob(new Blob([panel.content || ''], { type: 'text/html;charset=utf-8' }), `${safeTitle}.html`);
            onCloseMenu();
          }}
          className="ui-menu-item"
        >
          Download as HTML
        </button>
      ) : null}
      {canExportPanelSnapshot(panel) ? (
        <button
        role="menuitem"
          onClick={() => {
            onPanelDownload(panel, 'png');
            onCloseMenu();
          }}
          className="ui-menu-item"
        >
          Save as image (PNG)
        </button>
      ) : null}
      <button
        role="menuitem"
        onClick={() => {
          onMinimize(panel.id);
          if (maximizedPanelId === panel.id) {
            onSetMaximizedPanelId(null);
          }
          onCloseMenu();
        }}
        className="ui-menu-item"
      >
        Minimize
      </button>
      <button
        role="menuitem"
        onClick={() => {
          onMaximize(panel.id);
          onCloseMenu();
        }}
        className="ui-menu-item"
      >
        Maximize
      </button>
      <div className="ui-menu-sep" />
      <button
        role="menuitem"
        onClick={() => {
          onRemovePanel(panel.id);
          onCloseMenu();
        }}
        className="ui-menu-item ui-menu-item-danger"
      >
        Remove
      </button>
    </>
  );
}
