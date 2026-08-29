import {
  buildAnnulmentInfo,
  canViewAnnulledRecords,
  isAnnulledState,
  shouldIncludeAnnulledRecords,
} from './annulled-records.util';

describe('annulled-records.util', () => {
  it.each([
    'ADMIN',
    'Administrador',
    'ADMINISTRADOR DEL SISTEMA',
    'Super Administrador',
    'SUPERADMINISTRADOR',
    'SUPER_ADMINISTRADOR',
  ])('autoriza el rol administrativo %s', (roleName) => {
    expect(
      canViewAnnulledRecords({ headers: { 'x-role-name': roleName } }),
    ).toBe(true);
  });

  it('rechaza otros perfiles aunque soliciten incluir anulados', () => {
    const req = { headers: { 'x-role-name': 'SUPERVISOR' } };
    expect(shouldIncludeAnnulledRecords(req, true)).toBe(false);
  });

  it('requiere que el filtro haya sido activado', () => {
    const req = { headers: { 'x-role-name': 'ADMINISTRADOR' } };
    expect(shouldIncludeAnnulledRecords(req, false)).toBe(false);
    expect(shouldIncludeAnnulledRecords(req, 'true')).toBe(true);
  });
});

describe('buildAnnulmentInfo', () => {
  it('resuelve quien y cuando anulo desde el borrado logico', () => {
    const deletedAt = new Date('2026-08-29T10:15:00');
    expect(
      buildAnnulmentInfo({
        estado: 'ANULADA',
        is_deleted: true,
        deleted_by: 'jenny.ramirez',
        deleted_at: deletedAt,
        updated_by: 'otro.usuario',
        updated_at: new Date('2026-08-20T08:00:00'),
      }),
    ).toEqual({
      anulado: true,
      anulado_por: 'jenny.ramirez',
      anulado_at: deletedAt,
    });
  });

  it('cae a la ultima actualizacion cuando no hay borrado logico', () => {
    const updatedAt = new Date('2026-08-29T11:00:00');
    expect(
      buildAnnulmentInfo({
        estado: 'ANULADA',
        updated_by: 'jenny.ramirez',
        updated_at: updatedAt,
      }),
    ).toEqual({
      anulado: true,
      anulado_por: 'jenny.ramirez',
      anulado_at: updatedAt,
    });
  });

  it('no marca como anulado un registro vigente', () => {
    expect(
      buildAnnulmentInfo({
        estado: 'COMPLETADA',
        updated_by: 'jenny.ramirez',
        updated_at: new Date('2026-08-29T11:00:00'),
      }),
    ).toEqual({ anulado: false, anulado_por: null, anulado_at: null });
  });

  it('reconoce los estados equivalentes a anulado', () => {
    expect(isAnnulledState('anulado')).toBe(true);
    expect(isAnnulledState(' CANCELADA ')).toBe(true);
    expect(isAnnulledState('COMPLETADA')).toBe(false);
    expect(isAnnulledState(null)).toBe(false);
  });
});
