import { ForbiddenException } from '@nestjs/common';
import { TransferenciaBodegaService } from './transferencia-bodega.service';

describe('TransferenciaBodegaService forced annulment guard', () => {
  const service = Object.create(
    TransferenciaBodegaService.prototype,
  ) as TransferenciaBodegaService;

  it.each([
    'Super Administrador',
    'SUPERADMINISTRADOR',
    'SUPER_ADMINISTRADOR',
    'SUPER ADMIN',
  ])(
    'allows the Super Administrator role variant %s to force an authorized-guide annulment',
    (roleName) => {
      expect(() =>
        (service as any).assertCanForceAuthorizedGuideAnnul({ roleName }),
      ).not.toThrow();
    },
  );

  it.each(['Administrador', 'ADMINISTRADOR DEL SISTEMA', 'ADMIN'])(
    'allows the Administrator role variant %s to force an authorized-guide annulment',
    (roleName) => {
      expect(() =>
        (service as any).assertCanForceAuthorizedGuideAnnul({ roleName }),
      ).not.toThrow();
    },
  );

  it.each(['Gerente General', 'Mecánico', undefined])(
    'rejects the unauthorized role %s forcing an authorized-guide annulment',
    (roleName) => {
      expect(() =>
        (service as any).assertCanForceAuthorizedGuideAnnul({
          roleName,
        }),
      ).toThrow(ForbiddenException);
    },
  );
});

describe('TransferenciaBodegaService transferencia parcial de una orden', () => {
  const service = Object.create(
    TransferenciaBodegaService.prototype,
  ) as TransferenciaBodegaService;

  const linea = (over: Record<string, unknown> = {}) => ({
    cantidad: '5.000000',
    cantidad_preaprobada: '5.000000',
    cantidad_recibida: '0.000000',
    cantidad_transferida: '0.000000',
    ...over,
  });

  const porRecibir = (row: any) =>
    (service as any).getPendingReceiptQuantity(row);
  const porTransferir = (row: any) =>
    (service as any).getApprovedAvailableQuantity(row);

  it('la primera transferencia recibe TODO el pedido, no solo lo que sale', () => {
    // La mercaderia llega completa a la bodega de compras; de ahi se reparte.
    expect(porRecibir(linea())).toBe(5);
    expect(porTransferir(linea())).toBe(5);
  });

  it('tras mover 3 de 5, la orden conserva saldo y ya no hay nada que recibir', () => {
    const row = linea({
      cantidad_recibida: '5.000000',
      cantidad_transferida: '3.000000',
    });
    // Los 5 ya entraron: la segunda transferencia mueve existencia, no recibe.
    expect(porRecibir(row)).toBe(0);
    // Y quedan 2 por transferir, que es lo que mantiene abierta la orden.
    expect(porTransferir(row)).toBe(2);
  });

  it('una linea agotada no deja saldo ni por recibir ni por transferir', () => {
    const row = linea({
      cantidad_recibida: '5.000000',
      cantidad_transferida: '5.000000',
    });
    expect(porRecibir(row)).toBe(0);
    expect(porTransferir(row)).toBe(0);
  });

  it('una orden historica, recibida solo por lo que se transfirio, sigue pudiendo recibir el resto', () => {
    // Es el estado que dejo el modelo anterior y que rellena la migracion.
    const row = linea({
      cantidad_recibida: '1.000000',
      cantidad_transferida: '1.000000',
      cantidad: '2.000000',
      cantidad_preaprobada: '2.000000',
    });
    expect(porRecibir(row)).toBe(1);
    expect(porTransferir(row)).toBe(1);
  });

  it('nunca devuelve cantidades negativas aunque los datos vengan descuadrados', () => {
    const row = linea({
      cantidad_recibida: '9.000000',
      cantidad_transferida: '9.000000',
    });
    expect(porRecibir(row)).toBe(0);
    expect(porTransferir(row)).toBe(0);
  });

  it('sin linea de orden no hay nada que recibir', () => {
    expect(porRecibir(null)).toBe(0);
  });
});

describe('TransferenciaBodegaService getOrCreateStockRow', () => {
  const service = Object.create(
    TransferenciaBodegaService.prototype,
  ) as TransferenciaBodegaService;

  const buildManager = (existing: any | null) => ({
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    save: jest.fn(async (_entity: unknown, row: unknown) => row),
  });

  it('reuses and reactivates a soft-deleted zero-stock row without creating a new one', async () => {
    const existingRow: any = {
      id: 'stock-1',
      bodega_id: 'bodega-1',
      producto_id: 'producto-1',
      stock_actual: '0.000000',
      stock_nuevo: '0.000000',
      stock_usado: '0.000000',
      stock_critico: '0.000000',
      stock_fisico: '0.000000',
      costo_promedio_bodega: '5.0000',
      is_deleted: true,
      status: 'INACTIVE',
      deleted_at: new Date('2026-01-01T00:00:00.000Z'),
      deleted_by: 'previous-actor',
    };
    const manager = buildManager(existingRow);

    const result: any = await (service as any).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-1',
      productoId: 'producto-1',
      costoPromedio: 9,
      userName: 'actor-1',
    });

    expect(manager.create).not.toHaveBeenCalled();
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('stock-1');
    expect(result.is_deleted).toBe(false);
    expect(result.status).toBe('ACTIVE');
    expect(result.deleted_at).toBeNull();
    expect(result.deleted_by).toBeNull();
    expect(result.updated_by).toBe('actor-1');
  });

  it('preserves stock, id and cost values when reactivating a soft-deleted row', async () => {
    const existingRow: any = {
      id: 'stock-2',
      bodega_id: 'bodega-1',
      producto_id: 'producto-1',
      stock_actual: '12.500000',
      stock_nuevo: '10.000000',
      stock_usado: '2.500000',
      stock_critico: '0.000000',
      stock_fisico: '12.500000',
      costo_promedio_bodega: '7.2500',
      is_deleted: true,
      status: 'INACTIVE',
      deleted_at: new Date('2026-01-01T00:00:00.000Z'),
      deleted_by: 'previous-actor',
    };
    const manager = buildManager(existingRow);

    const result: any = await (service as any).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-1',
      productoId: 'producto-1',
      costoPromedio: 99,
      userName: 'actor-1',
    });

    expect(result.id).toBe('stock-2');
    expect(result.stock_actual).toBe('12.500000');
    expect(result.stock_nuevo).toBe('10.000000');
    expect(result.stock_usado).toBe('2.500000');
    expect(result.stock_fisico).toBe('12.500000');
    expect(result.costo_promedio_bodega).toBe('7.2500');
  });

  it('returns an active row unchanged without saving or creating', async () => {
    const activeRow: any = {
      id: 'stock-3',
      bodega_id: 'bodega-1',
      producto_id: 'producto-1',
      stock_actual: '4.000000',
      is_deleted: false,
      status: 'ACTIVE',
      deleted_at: null,
      deleted_by: null,
    };
    const manager = buildManager(activeRow);

    const result = await (service as any).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-1',
      productoId: 'producto-1',
      costoPromedio: 3,
      userName: 'actor-1',
    });

    expect(result).toBe(activeRow);
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.create).not.toHaveBeenCalled();
  });

  it('reactivates an inactive row even when it was not soft-deleted', async () => {
    const inactiveRow: any = {
      id: 'stock-inactive',
      bodega_id: 'bodega-1',
      producto_id: 'producto-1',
      stock_actual: '4.000000',
      is_deleted: false,
      status: 'INACTIVE',
      deleted_at: null,
      deleted_by: null,
    };
    const manager = buildManager(inactiveRow);

    const result: any = await (service as any).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-1',
      productoId: 'producto-1',
      costoPromedio: 3,
      userName: 'actor-1',
    });

    expect(result).toMatchObject({
      id: 'stock-inactive',
      status: 'ACTIVE',
      is_deleted: false,
      updated_by: 'actor-1',
    });
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(manager.create).not.toHaveBeenCalled();
  });

  it('creates a new zero-initialized row only when no physical row exists', async () => {
    const manager = buildManager(null);

    const result: any = await (service as any).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-1',
      productoId: 'producto-1',
      costoPromedio: 3,
      userName: 'actor-1',
    });

    expect(manager.create).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(result.bodega_id).toBe('bodega-1');
    expect(result.producto_id).toBe('producto-1');
    expect(result.stock_actual).toBe('0.000000');
    expect(result.costo_promedio_bodega).toBe('3.0000');
  });
});
