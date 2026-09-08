/**
 * PKCE (RFC 7636) with S256. docs/DATASOURCE.md §4 Option B.
 *
 * PKCE is what makes an authorization-code flow safe in a public client that
 * cannot keep a secret — which a browser extension is. The verifier never
 * leaves this process; only its SHA-256 hash goes to the org, so an authorization
 * code intercepted in transit is useless without the verifier.
 *
 * `crypto` is injected so the tests assert exact values against the RFC 7636
 * appendix B vector rather than "some base64-looking string".
 */

/** The subset of Web Crypto this module needs. */
export interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: { digest(algorithm: 'SHA-256', data: BufferSource): Promise<ArrayBuffer> };
}

export interface PkcePair {
  /** Kept in this process only, and sent once to the token endpoint. */
  verifier: string;
  /** `base64url(sha256(verifier))`, safe to put in a URL. */
  challenge: string;
  method: 'S256';
}

/** RFC 7636 §4.1 requires 43–128 characters; 32 random bytes gives 43. */
const VERIFIER_BYTES = 32;

export async function createPkcePair(cryptoImpl: CryptoLike = crypto): Promise<PkcePair> {
  const verifier = base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
  return { verifier, challenge: await deriveChallenge(verifier, cryptoImpl), method: 'S256' };
}

export async function deriveChallenge(
  verifier: string,
  cryptoImpl: CryptoLike = crypto,
): Promise<string> {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * An opaque `state` value, checked on the way back.
 *
 * Without it a crafted redirect could hand us an authorization code the user
 * never approved, and we would exchange it as though they had.
 */
export function createState(cryptoImpl: CryptoLike = crypto): string {
  return base64UrlEncode(cryptoImpl.getRandomValues(new Uint8Array(16)));
}

/** base64url per RFC 4648 §5: no padding, `-` and `_` for `+` and `/`. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
