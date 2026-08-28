export const INTERNAL_SERVICE_TOKEN_HEADER = 'X-Internal-Service-Token';

/**
 * Cabeceras para las llamadas servicio-a-servicio hacia kpi-security. El token
 * interno solo se adjunta cuando la URL destino pertenece a ese servicio, para
 * no exponer el secreto a terceros.
 */
export function buildSecurityServiceHeaders(options: {
  url: string;
  securityServiceUrl?: string | null;
  internalServiceToken?: string | null;
  json?: boolean;
}) {
  const headers: Record<string, string> = {};
  if (options.json) headers['Content-Type'] = 'application/json';

  const token = String(options.internalServiceToken || '').trim();
  const baseUrl = String(options.securityServiceUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (
    token &&
    baseUrl &&
    (options.url === baseUrl || options.url.startsWith(`${baseUrl}/`))
  ) {
    headers[INTERNAL_SERVICE_TOKEN_HEADER] = token;
  }

  return headers;
}
