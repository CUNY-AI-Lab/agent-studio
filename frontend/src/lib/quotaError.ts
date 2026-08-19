import { z } from 'zod';

const DEFAULT_QUOTA_MESSAGE = 'You have reached your usage quota. Try again later.';

const chatErrorSchema = z.object({ message: z.string() });
const quotaPayloadSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
});

/** Extract the user-facing message from the worker's streamed quota signal. */
export function quotaMessageFromChatError<T>(chatError: T): string | null {
  const body = chatErrorSchema.safeParse(chatError).data?.message;
  if (!body) return null;

  const marker = body.indexOf('{');
  if (marker < 0) return null;

  try {
    const parsed = quotaPayloadSchema.safeParse(JSON.parse(body.slice(marker))).data;
    if (parsed?.error.code !== 'quota_exceeded') return null;
    return parsed.error.message && parsed.error.message.length > 0
      ? parsed.error.message
      : DEFAULT_QUOTA_MESSAGE;
  } catch {
    // Not a quota signal.
    return null;
  }
}
