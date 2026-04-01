import type { UIMessage } from 'ai';
import type { WorkspaceFileInfo, WorkspaceRecord, WorkspaceState } from '../domain/workspace';
import { getMimeType } from './files';

type FileEncoding = 'utf8' | 'base64';

export interface WorkspaceExportFile {
  path: string;
  size?: number;
  uploadedAt?: string;
  etag?: string;
  contentType: string;
  encoding: FileEncoding;
  content: string;
}

export interface WorkspaceExportBundle {
  version: 1;
  exportedAt: string;
  workspace: WorkspaceRecord;
  state: WorkspaceState;
  messages: UIMessage[];
  files: WorkspaceExportFile[];
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('javascript') ||
    contentType.includes('xml') ||
    contentType.includes('yaml') ||
    contentType.includes('svg')
  );
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export async function createWorkspaceExportBundle(args: {
  workspace: WorkspaceRecord;
  state: WorkspaceState;
  messages: UIMessage[];
  files: WorkspaceFileInfo[];
  readFile: (filePath: string) => Promise<{
    contentType: string;
    data: ArrayBuffer;
  } | null>;
}): Promise<WorkspaceExportBundle> {
  const decoder = new TextDecoder();
  const exportedFiles = await Promise.all(
    args.files
      .filter((file) => !file.isDirectory)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(async (file) => {
        const runtimeFile = await args.readFile(file.path);
        if (!runtimeFile) {
          throw new Error(`Failed to export missing file: ${file.path}`);
        }

        const contentType = runtimeFile.contentType || getMimeType(file.path);
        const encoding: FileEncoding = isTextContentType(contentType) ? 'utf8' : 'base64';

        return {
          path: file.path,
          size: file.size,
          uploadedAt: file.uploadedAt,
          etag: file.etag,
          contentType,
          encoding,
          content: encoding === 'utf8' ? decoder.decode(runtimeFile.data) : encodeBase64(runtimeFile.data),
        } satisfies WorkspaceExportFile;
      })
  );

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: args.workspace,
    state: args.state,
    messages: args.messages,
    files: exportedFiles,
  };
}
