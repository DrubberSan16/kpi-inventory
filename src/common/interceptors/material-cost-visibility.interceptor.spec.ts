import {
  canRoleSetIncomeUnitCost,
  canRoleSaveUnpricedIncome,
  canRoleViewMaterialCosts,
  isIncomePriceReferenceRequest,
  stripMaterialCosts,
} from './material-cost-visibility.interceptor';

describe('material cost visibility', () => {
  it.each([
    'GERENTE GENERAL',
    'GERENCIA GENERAL',
    'ADMINISTRADOR',
    'ADMINISTRADOR DEL SISTEMA',
    'ADMIN',
    'SUPER ADMINISTRADOR',
    'SUPERADMINISTRADOR',
    'SUPER_ADMINISTRADOR',
    'SUPER_ADMIN',
    'SUPER ADMIN',
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

describe('precio de entrada en el ingreso de bodega', () => {
  it.each(['BODEGA', 'BODEGUERO', ' bodega '])('permite ingreso sin referencia solo a %s', role => {
    expect(canRoleSaveUnpricedIncome(role)).toBe(true);
  });
  it.each(['ADMINISTRADOR', 'SUPER ADMINISTRADOR', 'GERENTE GENERAL', 'OPERADOR', undefined])(
    'requiere referencia o precio para %s', role => expect(canRoleSaveUnpricedIncome(role)).toBe(false),
  );
  it('la excepción de consulta conserva solo el precio unitario del ingreso', () => {
    expect(stripMaterialCosts({ data: { costo_unitario: 7, costo_promedio: 9, precio_venta: 12, total_costos: 50, fuente: 'INGRESO' } }, true))
      .toEqual({ data: { costo_unitario: 7, fuente: 'INGRESO' } });
    expect(isIncomePriceReferenceRequest('GET', '/kpi_inventory/kardex/precios-ingreso?producto_id=1')).toBe(true);
    expect(isIncomePriceReferenceRequest('POST', '/kpi_inventory/kardex/precios-ingreso')).toBe(false);
    expect(isIncomePriceReferenceRequest('GET', '/kpi_inventory/kardex/documentos')).toBe(false);
    expect(isIncomePriceReferenceRequest('GET', '/kpi_inventory/kardex/precios-ingreso/export')).toBe(false);
  });
  it.each(['BODEGA', 'BODEGUERO'])(
    'deja fijar el precio de entrada al rol %s, que es quien recibe',
    (roleName) => {
      expect(canRoleSetIncomeUnitCost(roleName)).toBe(true);
    },
  );

  it.each([
    'GERENTE GENERAL',
    'ADMINISTRADOR',
    'SUPER ADMINISTRADOR',
    'Gerencia General',
  ])(
    'tambien lo deja al rol %s, que es quien corrige una entrada mal costeada',
    (roleName) => {
      expect(canRoleSetIncomeUnitCost(roleName)).toBe(true);
    },
  );

  it.each(['OPERADOR', 'SUPERVISOR', '', null, undefined])(
    'no lo deja al rol %s',
    (roleName) => {
      expect(canRoleSetIncomeUnitCost(roleName)).toBe(false);
    },
  );
});
