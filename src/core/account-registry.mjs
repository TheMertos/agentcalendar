const FORBIDDEN_KEYS = new Set(['password', 'pass', 'secret', 'token', 'accessToken', 'refreshToken', 'privateKey']);

/**
 * Reject credential-like keys in account metadata.
 * @param {object} value
 * @param {string} [path]
 */
function assertSafeMetadata(value, path = 'metadata') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || /password|token|secret|private.?key/i.test(key)) {
      throw new Error(`${path}.${key} is not allowed; use an opaque lease/reference`);
    }
    if (nested && typeof nested === 'object') assertSafeMetadata(nested, `${path}.${key}`);
  }
}

export { assertSafeMetadata };
