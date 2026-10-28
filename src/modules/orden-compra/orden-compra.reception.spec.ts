import { OrdenCompraService } from './orden-compra.service';
import { OrdenCompra, OrdenCompraDet, TransferenciaBodega } from '../entities';

function fixture(received = 12, activeTransfer = false) {
  const order = { id: 'order', estado: 'EMITIDA', is_deleted: false };
  const line = { cantidad_recibida: String(received), is_deleted: false };
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
      entity === OrdenCompraDet ? [line] : [],
    ),
    save: jest.fn(),
  };
  const service: any = Object.create(OrdenCompraService.prototype);
  service.dataSource = { transaction: jest.fn(async (fn: any) => fn(manager)) };
  service.queueTransactionLog = jest.fn();
  service.saveOrder = jest.fn();
  service.hydrateOrdersWithManager = jest.fn().mockResolvedValue([order]);
  service.transferenciaService = {
    annulOrderReceiptsOfAnnulledTransfers: jest.fn(),
    notifyMaintenanceRecalculationForStocks: jest.fn(),
  };
  return { service, manager, order, line };
}

const admin = { username: 'admin', roleName: 'Administrador' };

describe('Compra recibida antes de la recepción de traslado', () => {
  it('no permite editar ni reiniciar la cantidad recibida cuando el traslado fue anulado', async () => {
    const f = fixture();
    await expect(
      f.service.update('order', { created_by: 'admin' }),
    ).rejects.toThrow('ingreso de compra registrado');
    expect(f.service.saveOrder).not.toHaveBeenCalled();
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('anula la compra junto con el ingreso que dejó su transferencia anulada', async () => {
    const f = fixture();
    const receipts = f.service.transferenciaService
      .annulOrderReceiptsOfAnnulledTransfers as jest.Mock;
    receipts.mockImplementation(
      async (_m: any, _id: string, _u: string, changed: Set<string>) => {
        f.line.cantidad_recibida = '0.000000';
        changed.add('stock-compras');
      },
    );
    await f.service.annul('order', admin);
    expect(receipts).toHaveBeenCalledWith(
      f.manager,
      'order',
      'admin',
      expect.any(Set),
      expect.any(Set),
    );
    expect(f.order.estado).toBe('ANULADA');
    expect(
      f.service.transferenciaService.notifyMaintenanceRecalculationForStocks,
    ).toHaveBeenCalledWith(
      new Set(['stock-compras']),
      'purchase-order-annulment',
      expect.objectContaining({ actorUsername: 'admin' }),
    );
  });
  it('no anula si queda un ingreso que no salió de una transferencia anulada', async () => {
    const f = fixture();
    await expect(f.service.annul('order', admin)).rejects.toThrow(
      'no salio de una transferencia anulada',
    );
    expect(f.order.estado).toBe('EMITIDA');
    expect(f.manager.save).not.toHaveBeenCalled();
  });
  it('una compra sin ingreso se anula sin tocar el inventario', async () => {
    const f = fixture(0);
    await f.service.annul('order', admin);
    expect(f.order.estado).toBe('ANULADA');
    expect(
      f.service.transferenciaService.annulOrderReceiptsOfAnnulledTransfers,
    ).not.toHaveBeenCalled();
    expect(
      f.service.transferenciaService.notifyMaintenanceRecalculationForStocks,
    ).not.toHaveBeenCalled();
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
