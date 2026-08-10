import {
  createTestIdentityIssuer as createPackageTestIdentityIssuer,
  TEST_SUBJECTS,
} from '@cuny-ai-lab/cail-identity/testing';
import { CAIL_CANONICAL_ISSUER } from '../../src/lib/cail-identity.ts';

export { TEST_SUBJECTS };

export function createTestIdentityIssuer(options = {}) {
  return createPackageTestIdentityIssuer({ issuer: CAIL_CANONICAL_ISSUER, ...options });
}
