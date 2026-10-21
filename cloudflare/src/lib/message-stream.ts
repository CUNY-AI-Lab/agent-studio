import type { UIMessage } from 'ai';
import { parseUiMessage } from './import';

const MESSAGE_STREAM_CHUNK_BYTES = 64 * 1024;

function asyncIterator<T>(values: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in values) return values[Symbol.asyncIterator]();
  const iterator = values[Symbol.iterator]();
  return {
    next: async () => iterator.next(),
    return: iterator.return
      ? async () => iterator.return?.() ?? { done: true, value: undefined }
      : undefined,
  };
}

/**
 * Transfer complete chat history across Durable Object RPC without materializing
 * the transcript in the RPC serializer. Each line is one validated UI message;
 * byte chunks stay bounded independently of message size.
 */
export function createMessageStream(
  messages: AsyncIterable<UIMessage> | Iterable<UIMessage>,
): ReadableStream<Uint8Array> {
  const iterator = asyncIterator(messages);
  const encoder = new TextEncoder();
  let pending: Uint8Array | null = null;
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!pending) {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        pending = encoder.encode(`${JSON.stringify(next.value)}\n`);
        offset = 0;
      }

      const end = Math.min(offset + MESSAGE_STREAM_CHUNK_BYTES, pending.length);
      controller.enqueue(pending.subarray(offset, end));
      offset = end;
      if (offset === pending.length) pending = null;
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function parseLine(line: string): UIMessage | null {
  if (!line) return null;
  return parseUiMessage(JSON.parse(line));
}

export async function* readMessageStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<UIMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const message = parseLine(buffered.slice(0, newline));
        if (message) yield message;
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    }
    buffered += decoder.decode();
    const finalMessage = parseLine(buffered);
    if (finalMessage) yield finalMessage;
  } finally {
    try {
      if (!completed) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export async function collectMessageStream(
  stream: ReadableStream<Uint8Array>,
): Promise<UIMessage[]> {
  const messages: UIMessage[] = [];
  for await (const message of readMessageStream(stream)) messages.push(message);
  return messages;
}
