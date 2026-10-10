import { BadRequestException } from '@nestjs/common';
import { OrdenCompraService } from './orden-compra.service';
import { OrdenCompra, OrdenCompraDet, TransferenciaBodega } from '../entities';

function fixture(received = 12, activeTransfer = false) {
  const order = { id: 'order', estado: 'EMITIDA', is_deleted: false };
  const manager: any = {
    query: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(async (entity: any, options: any) =>
      entity === OrdenCompra
        ? order
        : entity === TransferenciaBodega && activeTransfer
          ? { estado: options.where.estado ? 'PENDIENTE_RECEPCION' : 'ANULADA' }
          : null,
    ),
    find: jest.fn(async (entity: any) =>
      entity === OrdenCompraDet
        ? [{ cantidad_recibida: String(received), is_deleted: false }]
        : [],
    ),
    save: jest.fn(),
  };
  const service: any = Object.create(OrdenCompraService.prototype);
  service.dataSource = { transaction: jest.fn(async (fn: any) => fn(manager)) };
  service.queueTransactionLog = jest.fn();
  service.saveOrder = jest.fn();
  service.hydrateOrdersWithManager = jest.fn().mockResolvedValue([order]);
  return { service, manager, order };
}

describe('Compra recibida antes de la recepción de traslado', () => {
  it('no permite editar ni reiniciar la cantidad recibida cuando el traslado fue anulado', async () => {
    const f = fixture();
    await expect(
      f.service.update('order', { created_by: 'admin' }),
    ).rejects.toThrow('ingreso de compra registrado');
    expect(f.service.saveOrder).not.toHaveBeenCalled();
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('no anula una compra cuyo ingreso real permanece en bodega', async () => {
    const f = fixture();
    await expect(
      f.service.annul('order', {
        username: 'admin',
        roleName: 'Administrador',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(f.order.estado).toBe('EMITIDA');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it.each(['update', 'annul'])(
    'busca cualquier traslado activo antes de %s aunque haya otro anulado',
    async (method) => {
      const f = fixture(0, true);
      const action =
        method === 'update'
          ? f.service.update('order', {})
          : f.service.annul('order', { roleName: 'Administrador' });
      await expect(action).rejects.toThrow('transferencia');
      expect(f.manager.findOne).toHaveBeenCalledWith(
        TransferenciaBodega,
        expect.objectContaining({
          where: expect.objectContaining({
            estado: expect.objectContaining({
              _type: 'not',
              _value: 'ANULADA',
            }),
          }),
        }),
      );
    },
  );
});
