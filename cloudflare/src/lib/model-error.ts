import { z } from 'zod';
import { canonicalError } from './error-envelope';
import { extractCanonicalCailError, quotaSignalFromError } from './quota-error';

const modelServiceCode = z.enum([
  'outcome_unknown',
  'upstream_error',
  'upstream_rate_limited',
  'provider_configuration_error',
]);

/** Forward recognized Gateway failures, never raw provider exceptions. */
export function modelErrorSignal(error: Error | null): string | null {
  const cail = extractCanonicalCailError(error);
  const quota = quotaSignalFromError(error, cail);
  if (quota) return quota;
  if (!cail) return null;
  const code = modelServiceCode.safeParse(cail.code);
  if (!code.success) return null;
  const retryable = code.data === 'outcome_unknown'
    ? false
    : z.boolean().safeParse(cail.extras.retryable).data;
  return JSON.stringify(canonicalError(code.data, cail.message, {
    type: code.data === 'upstream_rate_limited' ? 'rate_limit_error' : 'server_error',
    retryable,
  }));
}
