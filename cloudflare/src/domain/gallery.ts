import type { WorkspaceState } from './workspace';

export interface GalleryItem {
  id: string;
  title: string;
  description: string;
  prompt?: string;
  authorId: string;
  publishedAt: string;
  artifactCount: number;
}

export interface GalleryItemFull extends GalleryItem {
  state: WorkspaceState;
}
