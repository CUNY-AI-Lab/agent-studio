import type { WorkspacePanel } from '../types';

export type ToolbarDownloadFormat = 'file' | 'csv' | 'json' | 'txt' | 'png';

export function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function getFileExtension(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  return dotIndex >= 0 ? filePath.slice(dotIndex).toLowerCase() : '';
}

export function getWorkspaceFilePanelId(filePath: string): string {
  return `file-${filePath.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function canOpenFileInPanel(filePath: string): boolean {
  return /\.(pdf|png|jpe?g|gif|webp|svg|md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css|html?)$/i.test(filePath);
}

export function canQueryFileInPanel(filePath: string): boolean {
  return /\.(pdf|md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css|html?|svg)$/i.test(filePath);
}

export function inferWorkspaceFilePanelType(filePath: string): 'pdf' | 'preview' | 'editor' {
  if (/\.pdf$/i.test(filePath)) return 'pdf';
  if (/\.(html?|svg)$/i.test(filePath)) return 'preview';
  return 'editor';
}

export function getFileTypeBadge(filePath: string): string {
  const extension = getFileExtension(filePath).replace(/^\./, '');
  if (!extension) return 'FILE';
  if (extension.length <= 4) return extension.toUpperCase();
  return extension.slice(0, 4).toUpperCase();
}

export function getFileTileLabel(filePath: string): string {
  const extension = getFileExtension(filePath);
  if (extension === '.pdf') return 'PDF';
  if (extension === '.csv' || extension === '.tsv') return 'CSV File';
  if (extension === '.md' || extension === '.markdown') return 'Markdown File';
  if (extension === '.html' || extension === '.htm') return 'HTML View';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(extension)) return 'Image';
  if (extension === '.json') return 'JSON File';
  if (extension === '.txt') return 'Text File';
  return 'File';
}

export function getPanelTitle(panel: WorkspacePanel): string {
  if (panel.title) return panel.title;
  if ('filePath' in panel && panel.filePath) return getFileName(panel.filePath);
  if (panel.type === 'fileTree') return 'Workspace Files';
  return panel.id;
}

export function getPanelTypeLabel(panel: WorkspacePanel): string {
  switch (panel.type) {
    case 'markdown':
      return 'Markdown';
    case 'table':
      return 'Table';
    case 'chart':
      return 'Chart';
    case 'cards':
      return 'Cards';
    case 'pdf':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'PDF';
    case 'preview':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'Web View';
    case 'editor':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'File';
    case 'file':
      return panel.filePath ? getFileTileLabel(panel.filePath) : 'File';
    case 'detail':
      return 'Detail';
    case 'fileTree':
      return 'Files';
    case 'chat':
      return 'Chat';
    default:
      return 'Panel';
  }
}

export function isPanelContextualChatCapable(panel: WorkspacePanel): boolean {
  if (panel.type === 'table' || panel.type === 'chart' || panel.type === 'cards' || panel.type === 'markdown') {
    return true;
  }
  if (panel.type === 'fileTree') return true;
  if (panel.type === 'pdf') return true;
  if (panel.type === 'preview') {
    if (panel.filePath) return canQueryFileInPanel(panel.filePath);
    return !!panel.content;
  }
  if ((panel.type === 'editor' || panel.type === 'file') && 'filePath' in panel && panel.filePath) {
    return canQueryFileInPanel(panel.filePath);
  }
  return false;
}

export function canExportPanelSnapshot(panel: WorkspacePanel): boolean {
  if (panel.type === 'table' || panel.type === 'chart' || panel.type === 'cards' || panel.type === 'markdown' || panel.type === 'fileTree') {
    return true;
  }

  if (panel.type === 'preview' && panel.content) {
    return true;
  }

  if ((panel.type === 'preview' || panel.type === 'editor' || panel.type === 'file') && 'filePath' in panel && panel.filePath) {
    return /\.(png|jpe?g|gif|webp|svg|md|txt|csv|json|xml|ya?ml|js|ts|tsx|jsx|css)$/i.test(panel.filePath);
  }

  return false;
}

export function getPanelDownloadFormats(panel: WorkspacePanel | null): ToolbarDownloadFormat[] {
  if (!panel) return [];

  const formats: ToolbarDownloadFormat[] = [];
  if ('filePath' in panel && panel.filePath) {
    formats.push('file');
  }

  switch (panel.type) {
    case 'table':
      formats.push('csv', 'json');
      break;
    case 'chart':
      formats.push('csv', 'json');
      break;
    case 'cards':
      formats.push('json');
      break;
    case 'markdown':
      formats.push('txt');
      break;
    default:
      break;
  }

  if (canExportPanelSnapshot(panel)) {
    formats.push('png');
  }

  return Array.from(new Set(formats));
}
