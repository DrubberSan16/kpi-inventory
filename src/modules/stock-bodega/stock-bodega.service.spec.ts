import { StockBodegaService } from './stock-bodega.service';

const buildService = () =>
  new StockBodegaService(
    {} as any,
    {} as any,
    { get: jest.fn().mockReturnValue('') } as any,
  );

describe('StockBodegaService stock breakdown', () => {
  it('calcula el total sumando stock nuevo, usado y crítico', () => {
    const result = (buildService() as any).normalizeStockPayload({
      stock_actual: '999',
      stock_nuevo: '2',
      stock_usado: '3',
      stock_critico: '4',
      es_usado: true,
    });

    expect(result).toMatchObject({
      stock_actual: '9',
      stock_nuevo: '2',
      stock_usado: '3',
      stock_critico: '4',
      stock_fisico: '9',
    });
  });

  it('rechaza valores negativos de stock crítico', () => {
    expect(() =>
      (buildService() as any).normalizeStockPayload({
        stock_nuevo: '0',
        stock_usado: '0',
        stock_critico: '-1',
        es_usado: false,
      }),
    ).toThrow('El stock nuevo, usado, critico y total no pueden ser negativos.');
  });
});
