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

  it('incluye la descripción del material en la búsqueda de stock', async () => {
    const countQuery = {
      getCount: jest.fn().mockResolvedValue(0),
    };
    const resultQuery = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
    };
    const baseQuery = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      clone: jest
        .fn()
        .mockReturnValueOnce(countQuery)
        .mockReturnValueOnce(resultQuery),
    };
    const service = new StockBodegaService(
      { createQueryBuilder: jest.fn().mockReturnValue(baseQuery) } as any,
      {} as any,
      { get: jest.fn().mockReturnValue('') } as any,
    );

    await service.findAllPaginated({ search: 'electrodo' } as any);

    const searchBrackets = baseQuery.andWhere.mock.calls.find(
      ([clause]) => typeof clause === 'object' && clause !== null,
    )?.[0] as { whereFactory: (query: any) => void };
    const searchQuery = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    };
    searchBrackets.whereFactory(searchQuery);

    expect(searchQuery.orWhere).toHaveBeenCalledWith(
      "COALESCE(producto.descripcion, '') ILIKE :search",
      { search: '%electrodo%' },
    );
  });

  it('pagina el catálogo completo usando un alias seguro para priorizar existencias', async () => {
    const countQuery = {
      getCount: jest.fn().mockResolvedValue(1),
    };
    const resultQuery = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawAndEntities: jest.fn().mockResolvedValue({
        entities: [
          {
            id: 'producto-1',
            codigo: 'MAT-001',
            nombre: 'Aceite de motor',
            descripcion: '15W40',
            es_aceite: true,
          },
        ],
        raw: [
          {
            stock_id: null,
            stock_actual: '0',
            stock_nuevo: '0',
            stock_usado: '0',
            stock_critico: '0',
            stock_es_usado: false,
          },
        ],
      }),
    };
    const baseQuery = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      clone: jest
        .fn()
        .mockReturnValueOnce(countQuery)
        .mockReturnValueOnce(resultQuery),
    };
    const bodegaRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'bodega-1',
        codigo: 'BOD-001',
        nombre: 'Bodega principal',
        sucursal_id: 'sucursal-1',
      }),
    };
    const productoRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(baseQuery),
    };
    const dataSource = {
      getRepository: jest
        .fn()
        .mockReturnValueOnce(bodegaRepo)
        .mockReturnValueOnce(productoRepo),
    };
    const service = new StockBodegaService(
      {} as any,
      dataSource as any,
      { get: jest.fn().mockReturnValue('') } as any,
    );

    const result = await service.findCatalogoPorBodega(
      {
        bodega_id: 'bodega-1',
        page: 1,
        limit: 50,
        es_aceite: true,
      } as any,
      'sucursal-1',
    );

    expect(resultQuery.addSelect).toHaveBeenCalledWith(
      'CASE WHEN COALESCE(stock.stock_actual, 0) > 0 THEN 0 ELSE 1 END',
      'stock_priority',
    );
    expect(resultQuery.orderBy).toHaveBeenCalledWith('stock_priority', 'ASC');
    expect(result.data).toEqual([
      expect.objectContaining({
        producto_id: 'producto-1',
        stock_actual: 0,
        sin_stock_en_bodega: true,
      }),
    ]);
  });
});
