import { createHash } from 'crypto';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './pkce.js';

const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+$/;

describe('pkce', () => {
  describe('generateCodeVerifier', () => {
    it('returns a URL-safe base64 string', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(URL_SAFE_BASE64);
    });

    it('returns a string within RFC 7636 length bounds (43-128 chars)', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    });

    it('returns different values across calls', () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toEqual(b);
    });
  });

  describe('generateCodeChallenge', () => {
    it('matches base64url(sha256(verifier))', () => {
      const verifier = 'fixed-test-verifier-value';
      const expected = createHash('sha256')
        .update(verifier)
        .digest('base64url');
      expect(generateCodeChallenge(verifier)).toEqual(expected);
    });

    it('returns a URL-safe base64 string', () => {
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);
      expect(challenge).toMatch(URL_SAFE_BASE64);
    });

    it('is deterministic for the same verifier', () => {
      const verifier = generateCodeVerifier();
      expect(generateCodeChallenge(verifier)).toEqual(
        generateCodeChallenge(verifier),
      );
    });
  });

  describe('generateState', () => {
    it('returns a URL-safe base64 string', () => {
      expect(generateState()).toMatch(URL_SAFE_BASE64);
    });

    it('returns different values across calls', () => {
      const a = generateState();
      const b = generateState();
      expect(a).not.toEqual(b);
    });
  });
});
