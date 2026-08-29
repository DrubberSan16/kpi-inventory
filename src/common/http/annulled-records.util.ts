function normalizeRoleName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function canViewAnnulledRecords(req?: any): boolean {
  const roleName = normalizeRoleName(
    req?.headers?.['x-role-name'] ??
      req?.user?.role?.nombre ??
      req?.user?.roleName,
  );
  return [
    'ADMIN',
    'ADMINISTRADOR',
    'ADMINISTRADOR DEL SISTEMA',
    'SUPER ADMIN',
    'SUPER ADMINISTRADOR',
    'SUPERADMINISTRADOR',
  ].includes(roleName);
}

export function shouldIncludeAnnulledRecords(
  req: any,
  requested: unknown,
): boolean {
  const enabled =
    requested === true ||
    ['true', '1', 'yes', 'si', 'sí'].includes(
      String(requested ?? '')
        .trim()
        .toLowerCase(),
    );
  return enabled && canViewAnnulledRecords(req);
}

/** Estados de negocio que marcan un documento como anulado. */
export const ANNULLED_STATES = [
  'ANULADA',
  'ANULADO',
  'CANCELADA',
  'CANCELADO',
  'VOID',
  'VOIDED',
];

export function isAnnulledState(value: unknown): boolean {
  return ANNULLED_STATES.includes(String(value ?? '').trim().toUpperCase());
}

export type AnnulmentInfo = {
  anulado: boolean;
  anulado_por: string | null;
  anulado_at: Date | string | null;
};

/**
 * Resuelve quien y cuando anulo un registro. La anulacion puede quedar marcada
 * por el borrado logico o por el estado de negocio, y no todos los modulos
 * llenan `deleted_by`, asi que se cae a la ultima actualizacion.
 */
export function buildAnnulmentInfo(item?: {
  estado?: string | null;
  status?: string | null;
  is_deleted?: boolean | null;
  deleted_by?: string | null;
  deleted_at?: Date | string | null;
  updated_by?: string | null;
  updated_at?: Date | string | null;
} | null): AnnulmentInfo {
  const annulled =
    item?.is_deleted === true ||
    isAnnulledState(item?.estado) ||
    isAnnulledState(item?.status);

  if (!annulled) {
    return { anulado: false, anulado_por: null, anulado_at: null };
  }

  return {
    anulado: true,
    anulado_por: item?.deleted_by || item?.updated_by || 'SYSTEM',
    anulado_at: item?.deleted_at || item?.updated_at || null,
  };
}
