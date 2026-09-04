import {
  canRoleViewMaterialCosts,
  stripMaterialCosts,
} from './material-cost-visibility.interceptor';

describe('material cost visibility', () => {
  it.each([
    'GERENTE GENERAL',
    'GERENCIA GENERAL',
    'ADMINISTRADOR',
    'ADMINISTRADOR DEL SISTEMA',
    'SUPER ADMINISTRADOR',
    'SUPERADMINISTRADOR',
  ])('permite ver costos al rol %s', (roleName) => {
    expect(canRoleViewMaterialCosts(roleName)).toBe(true);
  });

  it.each(['SUPERVISOR', 'OPERADOR', 'BODEGUERO', '', undefined])(
    'oculta costos al rol %s',
    (roleName) => {
      expect(canRoleViewMaterialCosts(roleName)).toBe(false);
    },
  );

  it('retira costos anidados sin alterar cantidades', () => {
    expect(
      stripMaterialCosts({
        cantidad: 3,
        costo_unitario: 12,
        total: 36,
        detalle: [{ subtotal: 36, stock_actual: 8 }],
        producto: { precio_venta: 18, nombre: 'Filtro' },
        paginacion: { total: 25, page: 1 },
      }),
    ).toEqual({
      cantidad: 3,
      detalle: [{ stock_actual: 8 }],
      producto: { nombre: 'Filtro' },
      paginacion: { total: 25, page: 1 },
    });
  });
});
