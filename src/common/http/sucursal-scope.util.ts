export const SUCURSAL_SCOPE_HEADER = 'x-sucursal-id';

export function getSucursalScopeId(req?: {
  headers?: Record<string, unknown>;
  get?: (name: string) => string | undefined;
}) {
  const headerValue =
    req?.get?.(SUCURSAL_SCOPE_HEADER) ??
    req?.headers?.[SUCURSAL_SCOPE_HEADER] ??
    req?.headers?.[SUCURSAL_SCOPE_HEADER.toUpperCase()];

  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const normalized = String(value || '').trim();
  return normalized ? normalized : null;
}
