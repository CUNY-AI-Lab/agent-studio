import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { nanoid } from 'nanoid';
import { getSession } from '@/lib/session';
import { createSandboxedStorage } from '@/lib/storage';
import { audit, getRequestMeta } from '@/lib/audit';
import { createDefaultWorkspaceConfig } from '@/lib/workspace/defaults';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const sessionId = await getSession();
  const storage = createSandboxedStorage(sessionId);

  const formData = await request.formData();
  const prompt = formData.get('prompt') as string | null;
  const blank = formData.get('blank') === 'true';

  const workspaceId = nanoid(10);
  const now = new Date().toISOString();
  const name = prompt ? generateName(prompt) : 'New Workspace';
  const description = prompt ? prompt.slice(0, 200) : '';

  const workspace = createDefaultWorkspaceConfig({
    id: workspaceId,
    name,
    description,
    createdAt: now,
    updatedAt: now,
  });

  await storage.setWorkspace(workspaceId, workspace);

  await storage.setUIState(workspaceId, {
    panels: [{ id: 'chat', type: 'chat', title: 'Chat' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  });

  if (prompt && !blank) {
    await storage.appendMessage(workspaceId, {
      role: 'user',
      content: prompt,
    });
  }

  const meta = getRequestMeta(request);
  await audit('workspace.create', {
    sessionId,
    workspaceId,
    details: { name, hasPrompt: !!prompt, promptLength: prompt?.length ?? 0 },
    ...meta,
  });

  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  redirect(`${basePath}/w/${workspaceId}`);
}

function generateName(description: string): string {
  const words = description
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 4);

  if (words.length === 0) {
    return 'New Agent';
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
