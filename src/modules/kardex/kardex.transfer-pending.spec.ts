import { KardexService } from './kardex.service';
import { StockBodegaService } from '../stock-bodega/stock-bodega.service';

describe('Kardex: protección del material pendiente de recepción', () => {
  const service: any = Object.create(KardexService.prototype);
  const stock: any = { producto_id: 'material', bodega_id: 'origen', stock_actual: '20', stock_nuevo: '12', stock_usado: '8', stock_critico: '0' };
  const pending = { nuevo: 7, usado: 4, critico: 0, total: 11 };

  it('resta reservas de OT y pendiente de recepción sin permitir usar otra condición', () => {
    expect(service.getAvailableStockByCondition(stock, 'NUEVO', 5, pending)).toBe(4);
    expect(service.getAvailableStockByCondition(stock, 'USADO', 0, pending)).toBe(4);
    expect(service.getAvailableStockByCondition(stock, 'NUEVO', 0, pending)).toBe(5);
  });

  it('impide anular un ingreso o importar un saldo que borre el pendiente', async () => {
    const manager = { query: jest.fn().mockResolvedValue([pending]) };
    await expect(service.assertTransferStockFloor(manager, stock, { nuevo: 6, usado: 8, critico: 0 })).rejects.toThrow('pendiente de recepción');
    await expect(service.assertTransferStockFloor(manager, stock, { nuevo: 7, usado: 4, critico: 0 })).resolves.toBeUndefined();
  });

  it('stock no puede eliminarse mientras está comprometido y se valida bajo bloqueo', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(stock), query: jest.fn().mockResolvedValue([pending]), save: jest.fn() };
    const stockService: any = Object.create(StockBodegaService.prototype);
    stockService.dataSource = { transaction: async callback => callback(manager) };
    await expect(stockService.remove('stock', 'admin')).rejects.toThrow('comprometido');
    expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
    expect(manager.save).not.toHaveBeenCalled();
  });
});
