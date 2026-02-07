import { readFile, writeFile, mkdir, readdir, cp, rm } from 'fs/promises';
import { join } from 'path';
import { nanoid } from 'nanoid';
import { createSandboxedStorage, UIState, Table, ChartData, CardsData } from '../storage';

const DATA_DIR = process.env.DATA_DIR || 'data';

export interface GalleryItem {
  id: string;
  title: string;
  description: string;
  prompt?: string;
  systemPrompt?: string;
  authorId: string;
  publishedAt: string;
  artifactCount: number;
}

export interface GalleryItemFull extends GalleryItem {
  uiState: UIState;
  tables: Table[];
  charts: ChartData[];
  cards: CardsData[];
}

function getGalleryPath(): string {
  return join(process.cwd(), DATA_DIR, 'gallery');
}

function getGalleryItemPath(id: string): string {
  return join(getGalleryPath(), id);
}

export async function listGalleryItems(): Promise<GalleryItem[]> {
  const galleryPath = getGalleryPath();

  try {
    await mkdir(galleryPath, { recursive: true });
    const entries = await readdir(galleryPath, { withFileTypes: true });
    const items: GalleryItem[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const configPath = join(galleryPath, entry.name, 'config.json');
          const content = await readFile(configPath, 'utf-8');
          items.push(JSON.parse(content));
        } catch {
          // Skip invalid items
        }
      }
    }

    // Sort by most recent first
    return items.sort((a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  } catch {
    return [];
  }
}

export async function getGalleryItem(id: string): Promise<GalleryItemFull | null> {
  try {
    const itemPath = getGalleryItemPath(id);

    // Read config
    const configContent = await readFile(join(itemPath, 'config.json'), 'utf-8');
    const config: GalleryItem = JSON.parse(configContent);

    // Read UI state
    let uiState: UIState = { panels: [], viewport: { x: 0, y: 0, zoom: 1 } };
    try {
      const uiContent = await readFile(join(itemPath, 'ui.json'), 'utf-8');
      uiState = JSON.parse(uiContent);
    } catch {
      // Use default
    }

    // Read tables
    const tables: Table[] = [];
    try {
      const tablesDir = join(itemPath, 'tables');
      const tableFiles = await readdir(tablesDir);
      for (const file of tableFiles) {
        if (file.endsWith('.json')) {
          const content = await readFile(join(tablesDir, file), 'utf-8');
          tables.push(JSON.parse(content));
        }
      }
    } catch {
      // No tables
    }

    // Read charts
    const charts: ChartData[] = [];
    try {
      const chartsDir = join(itemPath, 'charts');
      const chartFiles = await readdir(chartsDir);
      for (const file of chartFiles) {
        if (file.endsWith('.json')) {
          const content = await readFile(join(chartsDir, file), 'utf-8');
          charts.push(JSON.parse(content));
        }
      }
    } catch {
      // No charts
    }

    // Read cards
    const cards: CardsData[] = [];
    try {
      const cardsDir = join(itemPath, 'cards');
      const cardFiles = await readdir(cardsDir);
      for (const file of cardFiles) {
        if (file.endsWith('.json')) {
          const content = await readFile(join(itemPath, 'cards', file), 'utf-8');
          cards.push(JSON.parse(content));
        }
      }
    } catch {
      // No cards
    }

    return {
      ...config,
      uiState,
      tables,
      charts,
      cards,
    };
  } catch {
    return null;
  }
}

export async function publishWorkspace(
  userId: string,
  workspaceId: string,
  title: string,
  description: string
): Promise<GalleryItem> {
  const storage = createSandboxedStorage(userId);
  const workspace = await storage.getWorkspace(workspaceId);

  if (!workspace) {
    throw new Error('Workspace not found');
  }

  const galleryId = nanoid(10);
  const itemPath = getGalleryItemPath(galleryId);

  // Create gallery item directory structure
  await mkdir(itemPath, { recursive: true });
  await mkdir(join(itemPath, 'tables'), { recursive: true });
  await mkdir(join(itemPath, 'charts'), { recursive: true });
  await mkdir(join(itemPath, 'cards'), { recursive: true });
  await mkdir(join(itemPath, 'files'), { recursive: true });

  // Copy UI state
  const uiState = await storage.getUIState(workspaceId);
  await writeFile(join(itemPath, 'ui.json'), JSON.stringify(uiState, null, 2));

  // Copy tables
  const tables = await storage.listTables(workspaceId);
  for (const table of tables) {
    await writeFile(
      join(itemPath, 'tables', `${table.id}.json`),
      JSON.stringify(table, null, 2)
    );
  }

  // Copy charts
  const charts = await storage.listCharts(workspaceId);
  for (const chart of charts) {
    await writeFile(
      join(itemPath, 'charts', `${chart.id}.json`),
      JSON.stringify(chart, null, 2)
    );
  }

  // Copy cards
  const cardsList = await storage.listCards(workspaceId);
  for (const cards of cardsList) {
    await writeFile(
      join(itemPath, 'cards', `${cards.id}.json`),
      JSON.stringify(cards, null, 2)
    );
  }

  // Copy files
  const workspaceFilesPath = join(storage.basePath, 'workspaces', workspaceId, 'files');
  try {
    await cp(workspaceFilesPath, join(itemPath, 'files'), { recursive: true });
  } catch {
    // No files to copy
  }

  // Count artifacts
  const artifactCount = uiState.panels.filter(p => p.type !== 'chat').length;

  // Create config
  const config: GalleryItem = {
    id: galleryId,
    title,
    description,
    prompt: workspace.description,
    systemPrompt: workspace.systemPrompt,
    authorId: userId,
    publishedAt: new Date().toISOString(),
    artifactCount,
  };

  await writeFile(join(itemPath, 'config.json'), JSON.stringify(config, null, 2));

  return config;
}

export async function cloneGalleryItem(
  galleryId: string,
  userId: string
): Promise<string> {
  const galleryItem = await getGalleryItem(galleryId);

  if (!galleryItem) {
    throw new Error('Gallery item not found');
  }

  const storage = createSandboxedStorage(userId);
  const workspaceId = nanoid(10);
  const now = new Date().toISOString();

  // Create workspace config
  await storage.setWorkspace(workspaceId, {
    id: workspaceId,
    name: galleryItem.title,
    description: `Cloned from gallery: ${galleryItem.description}`,
    createdAt: now,
    updatedAt: now,
    systemPrompt: galleryItem.systemPrompt || 'You are a helpful assistant that helps users accomplish tasks by writing code and building interfaces.',
    tools: [
      'execute',
      'read', 'write',
      'filter', 'pick', 'sort',
      'ui.table', 'ui.message',
      'ui.addPanel', 'ui.removePanel', 'ui.updatePanel', 'ui.setLayout',
    ],
  });

  // Copy UI state
  await storage.setUIState(workspaceId, galleryItem.uiState);

  // Copy tables
  for (const table of galleryItem.tables) {
    await storage.setTable(workspaceId, table.id, table);
  }

  // Copy charts
  for (const chart of galleryItem.charts) {
    await storage.setChart(workspaceId, chart.id, chart);
  }

  // Copy cards
  for (const cards of galleryItem.cards) {
    await storage.setCards(workspaceId, cards.id, cards);
  }

  // Copy files
  const galleryFilesPath = join(getGalleryItemPath(galleryId), 'files');
  const workspaceFilesPath = join(storage.basePath, 'workspaces', workspaceId, 'files');
  try {
    await cp(galleryFilesPath, workspaceFilesPath, { recursive: true });
  } catch {
    // No files to copy
  }

  return workspaceId;
}

export async function unpublishGalleryItem(
  galleryId: string,
  userId: string
): Promise<boolean> {
  const item = await getGalleryItem(galleryId);

  if (!item) {
    throw new Error('Gallery item not found');
  }

  // Only the author can unpublish
  if (item.authorId !== userId) {
    throw new Error('Not authorized to unpublish this item');
  }

  const itemPath = getGalleryItemPath(galleryId);
  await rm(itemPath, { recursive: true, force: true });

  return true;
}
