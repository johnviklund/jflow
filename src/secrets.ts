/**
 * What counts as a credential in anything jflow persists. Secrets are never
 * stored in configuration, project records or version control (SPEC.md
 * confirmed default 8, D14); the Jev API key comes from the environment or
 * host secret storage.
 */

export const JEV_API_KEY_ENV_VAR = "JFLOW_JEV_API_KEY";

/** A key that names a credential; rejected wherever it appears. */
export const SECRET_KEY_PATTERN =
  /(api[-_]?key|apikey|api[-_]?token|token|secret|password|credential)/i;

/**
 * A string value that looks like a credential: a secret-named assignment to
 * a bare token (no prose after the separator), or a token with a well-known
 * secret prefix. Deliberately narrow so ordinary text never matches; the key
 * scan is the primary guard.
 */
export const SECRET_VALUE_PATTERN =
  /\b(?:api[-_]?key|token|secret|password)\s*[=:]\s*[A-Za-z0-9_\-]{16,}(?:\s|$)|\bsk[-_][A-Za-z0-9_\-]{12,}|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/i;

export const SECRET_MESSAGE =
  `secrets must never be stored in jflow configuration or version control; ` +
  `provide the Jev API key via the ${JEV_API_KEY_ENV_VAR} environment variable or host secret storage`;
