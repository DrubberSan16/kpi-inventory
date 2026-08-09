const ADMINISTRATIVE_MANAGEMENT_ROLE_NAMES = new Set([
  'ADMINISTRADOR',
  'SUPER ADMINISTRADOR',
  'GERENTE GENERAL',
]);

export function normalizeAdministrativeRoleName(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

export function isAdministrativeManagementRoleName(value: unknown): boolean {
  return ADMINISTRATIVE_MANAGEMENT_ROLE_NAMES.has(
    normalizeAdministrativeRoleName(value),
  );
}
