import { safeValidateUIMessages, type UIMessage } from 'ai';

type SessionHistoryReader = {
  getLatestLeaf(): Promise<{ id: string } | null>;
  getHistoryRowStats(leafId?: string | null): Promise<Array<{ id: string }>>;
  getMessage(id: string): Promise<{
    id: string;
    role: string;
    parts: Array<{ type: string }>;
  } | null>;
};

/**
 * Stream every stored message on the active Sessions branch in root-to-leaf
 * order. Agents caps each history/path read at 10,001 rows, so first discover
 * the overlapping page boundaries and then read those pages oldest-first.
 * The active leaf is pinned before discovery; messages appended later are not
 * mixed into the snapshot.
 */
export async function* completeSessionHistory(
  session: SessionHistoryReader,
): AsyncGenerator<UIMessage> {
  const latest = await session.getLatestLeaf();
  if (!latest) return;

  const pageLeaves: string[] = [];
  const seenBoundaries = new Set<string>();
  let leafId = latest.id;

  while (true) {
    if (seenBoundaries.has(leafId)) {
      throw new Error('Session history contains a repeated page boundary.');
    }
    seenBoundaries.add(leafId);
    pageLeaves.push(leafId);

    const rows = await session.getHistoryRowStats(leafId);
    if (rows.length === 0 || rows.at(-1)?.id !== leafId) {
      throw new Error('Session history page is missing its requested leaf.');
    }
    const oldestId = rows[0].id;
    if (oldestId === leafId) break;
    leafId = oldestId;
  }

  for (let page = pageLeaves.length - 1; page >= 0; page -= 1) {
    const rows = await session.getHistoryRowStats(pageLeaves[page]);
    if (rows.length === 0 || rows.at(-1)?.id !== pageLeaves[page]) {
      throw new Error('Session history changed while it was being read.');
    }

    const overlapId = page < pageLeaves.length - 1 ? pageLeaves[page + 1] : null;
    if (overlapId !== null && rows[0]?.id !== overlapId) {
      throw new Error('Session history page boundary changed while it was being read.');
    }

    for (let index = overlapId === null ? 0 : 1; index < rows.length; index += 1) {
      const message = await session.getMessage(rows[index].id);
      if (!message) throw new Error('Session history message disappeared while it was being read.');
      const validated = await safeValidateUIMessages<UIMessage>({ messages: [message] });
      if (!validated.success || validated.data.length !== 1) {
        throw new Error('Session history contains an invalid message.');
      }
      yield validated.data[0];
    }
  }
}
