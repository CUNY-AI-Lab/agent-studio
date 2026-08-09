const DEFAULT_QUOTA_MESSAGE = 'You have reached your usage quota. Try again later.';

/** Extract the user-facing message from the worker's streamed quota signal. */
export function quotaMessageFromChatError(chatError: unknown): string | null {
  try {
    const body =
      typeof (chatError as { message?: unknown } | null)?.message === 'string'
        ? (chatError as { message: string }).message
        : '';
    const marker = body.indexOf('{');
    if (marker < 0) return null;
    const parsed = JSON.parse(body.slice(marker));
    const error = typeof parsed?.error === 'object' && parsed.error !== null
      ? parsed.error as { code?: unknown; message?: unknown }
      : null;
    if (error?.code === 'quota_exceeded') {
      return typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : DEFAULT_QUOTA_MESSAGE;
    }
  } catch {
    // Not a quota signal.
  }
  return null;
}
