import { createHash, randomBytes } from 'crypto';

const CODE_VERIFIER_BYTES = 48;
const STATE_BYTES = 16;

export const generateCodeVerifier = (): string =>
  randomBytes(CODE_VERIFIER_BYTES).toString('base64url');

export const generateCodeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const generateState = (): string =>
  randomBytes(STATE_BYTES).toString('base64url');
