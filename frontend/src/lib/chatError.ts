import { z } from 'zod';

const notices = {
  quota_exceeded: 'You have reached your usage quota. Try again later.',
  upstream_error: 'The model provider could not finish this response. You can try again.',
  upstream_rate_limited: 'The model provider is busy. Wait a moment before trying again.',
  outcome_unknown: 'The model connection ended before the result could be confirmed. Check the conversation and workspace files before retrying; the request may already have produced a result.',
  response_interrupted: 'The response was interrupted before it finished. Your saved conversation and workspace files are kept. Check them before retrying.',
  provider_configuration_error: 'The model is unavailable because of a service configuration problem. Choose another model or try again later.',
};

const chatErrorSchema = z.object({ message: z.string() });
const errorPayloadSchema = z.object({
  error: z.object({
    code: z.enum(['quota_exceeded', 'upstream_error', 'upstream_rate_limited', 'outcome_unknown', 'response_interrupted', 'provider_configuration_error']),
  }),
});

/** Map recognized streamed codes to bounded copy, without displaying upstream text. */
export function noticeFromChatError<T>(chatError: T): string | null {
  const body = chatErrorSchema.safeParse(chatError).data?.message;
  if (!body) return null;

  const marker = body.indexOf('{');
  if (marker < 0) return null;

  try {
    const parsed = errorPayloadSchema.safeParse(JSON.parse(body.slice(marker))).data;
    return parsed ? notices[parsed.error.code] : null;
  } catch {
    // Ordinary errors keep the generic recovery notice.
    return null;
  }
}
