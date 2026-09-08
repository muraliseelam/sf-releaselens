/**
 * Secret redaction for anything that might be shown, logged or serialised.
 *
 * The rule this enforces: **no token value may ever appear in an error message,
 * a log line, or telemetry.** That is easy to honour when writing a throw site
 * and easy to break later by adding `${detail}` to a message, so it is enforced
 * here rather than by remembering — every auth error message goes through
 * `redact` before it reaches an `Error` constructor.
 *
 * Two layers, deliberately:
 *
 *  1. **Known values.** The caller passes the exact secrets in play, and those
 *     are replaced whatever they look like.
 *  2. **Shape matching.** Salesforce access tokens have a recognisable form
 *     (`00D…!AQ…`), and refresh tokens are long opaque strings. This catches a
 *     token that reached the text by a path nobody anticipated — which is
 *     precisely the case layer 1 cannot cover.
 */

export const REDACTED = '«redacted»';

/**
 * A Salesforce session/access token: an org id, `!`, then an opaque blob.
 * Deliberately loose — over-redacting a diagnostic is a smaller problem than
 * printing a live credential.
 */
const ACCESS_TOKEN_SHAPE = /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-+=]{10,}/g;

/** `Bearer <anything>` in a header echo. */
const BEARER_SHAPE = /\bBearer\s+[A-Za-z0-9._\-!+=/]{8,}/gi;

/** OAuth parameters that carry secrets when a URL or body gets into a message. */
const SECRET_PARAM_SHAPE =
  /\b(access_token|refresh_token|code_verifier|assertion|client_secret|code)=([^&\s"']+)/gi;

/**
 * A long opaque run that looks like a credential: 20+ characters from a token
 * alphabet, containing at least one digit.
 *
 * This is the layer that catches what the other two cannot — a secret we do not
 * yet hold, echoed back at us. A refresh token, for instance, is unknown to this
 * process while the *initial* code exchange is still failing, so it is neither
 * in the caller's secret list nor of the access-token shape.
 *
 * Requiring a digit keeps ordinary prose intact, and an org id (18 characters)
 * falls below the threshold and survives — which matters, because it is
 * diagnostic rather than secret.
 */
const OPAQUE_RUN_SHAPE = /\b(?=[A-Za-z0-9._\-!+=/]*\d)[A-Za-z0-9._\-!+=/]{20,}\b/g;

/**
 * Removes secrets from text.
 *
 * @param secrets exact values known to be sensitive right now. Empty and very
 *        short entries are ignored: replacing every occurrence of a 3-character
 *        string would corrupt the message without protecting anything.
 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let output = text;

  for (const secret of secrets) {
    if (secret === undefined || secret.length < 8) continue;
    output = output.split(secret).join(REDACTED);
  }

  return output
    .replace(ACCESS_TOKEN_SHAPE, REDACTED)
    .replace(BEARER_SHAPE, `Bearer ${REDACTED}`)
    .replace(SECRET_PARAM_SHAPE, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(OPAQUE_RUN_SHAPE, REDACTED);
}

/**
 * True when `text` still contains any of `secrets`.
 *
 * Used by tests as the assertion, and available to callers that want to fail
 * closed rather than emit something they are unsure about.
 */
export function containsSecret(text: string, secrets: readonly (string | undefined)[]): boolean {
  return secrets.some(
    (secret) => secret !== undefined && secret.length >= 8 && text.includes(secret),
  );
}
