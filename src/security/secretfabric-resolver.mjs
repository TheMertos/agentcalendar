/** Trusted SecretFabric principal header. Never taken from MCP tool arguments. */
export const HERMES_PRINCIPAL_HEADER = 'x-hermes-principal';

/**
 * Resolve a short-lived CalDAV lease for one trusted runtime principal.
 * @param {{ baseUrl: string, apiToken: string, principal: string, fetchImpl?: typeof fetch }} options
 */
export function createSecretFabricResolver({ baseUrl, apiToken, principal, fetchImpl = fetch }) {
  if (!baseUrl || !apiToken || !principal) throw new TypeError('baseUrl, apiToken, and principal are required');

  /**
   * Request one purpose-scoped lease.
   * @param {{ resourceId: string, purpose: string, fieldPaths: string[] }} request Lease request.
   * @returns {Promise<{ username: string, password: string }>}
   */
  return async function resolveCredentials({ resourceId, purpose, fieldPaths }) {
    const response = await fetchImpl(`${baseUrl}/api/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiToken}`,
        [HERMES_PRINCIPAL_HEADER]: principal
      },
      body: JSON.stringify({ resourceId, purpose, fieldPaths })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `secretfabric_http_${response.status}`);

    const fields = payload.fields ?? {};
    const username = fields['incoming.username'] ?? fields['outgoing.username'] ?? fields['auth.username'] ?? fields['identity.email'];
    const password = fields['incoming.password'] ?? fields['outgoing.password'] ?? fields['auth.password'];
    if (!username || !password) throw new Error('resolved_credential_incomplete');
    return { username, password };
  };
}
