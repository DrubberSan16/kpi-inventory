import { OrdenCompraService } from './orden-compra.service';
import { Categoria, Marca, OrdenCompra, OrdenCompraDet } from '../entities';

type Order = Pick<OrdenCompra, 'id' | 'estado'>;
type Classification = {
  categoria_id: string | null;
  categoria_nombre: string;
  marca_id: string | null;
  marca_nombre: string | null;
};
type Product = {
  id: string;
  categoria_id: string | null;
  marca_id: string | null;
};
type CatalogRow = { id: string; nombre: string };
type Detail = Pick<OrdenCompraDet, 'producto_id' | 'total'>;

function queryBuilder(orders: Order[]) {
  return {
    where: jest.fn<unknown, unknown[]>().mockReturnThis(),
    andWhere: jest.fn<unknown, unknown[]>().mockReturnThis(),
    orderBy: jest.fn<unknown, unknown[]>().mockReturnThis(),
    addOrderBy: jest.fn<unknown, unknown[]>().mockReturnThis(),
    skip: jest.fn<unknown, unknown[]>().mockReturnThis(),
    take: jest.fn<unknown, unknown[]>().mockReturnThis(),
    getManyAndCount: jest
      .fn<Promise<[Order[], number]>, []>()
      .mockResolvedValue([orders, orders.length]),
  };
}

type ListHarness = {
  findAll: OrdenCompraService['findAll'];
  ordenRepo: {
    createQueryBuilder: jest.Mock<ReturnType<typeof queryBuilder>, [string]>;
  };
  getWarehouseIdsBySucursal: jest.Mock<Promise<string[] | null>, []>;
  hydrateOrders: jest.Mock<Promise<Order[]>, [Order[], boolean]>;
};

type ClassificationHarness = {
  buildDetailClassificationMap: (
    details: Detail[],
  ) => Promise<Map<string, Classification>>;
  productoRepo: { find: jest.Mock<Promise<Product[]>, [unknown]> };
  dataSource: {
    getRepository: jest.Mock<
      { find: jest.Mock<Promise<CatalogRow[]>, [unknown]> },
      [typeof Categoria | typeof Marca]
    >;
  };
};

function fixture() {
  const service = Object.create(OrdenCompraService.prototype) as ListHarness;
  const orders: Order[] = [{ id: 'oc', estado: 'EMITIDA' }];
  const qb = queryBuilder(orders);
  service.ordenRepo = {
    createQueryBuilder: jest
      .fn<ReturnType<typeof queryBuilder>, [string]>()
      .mockReturnValue(qb),
  };
  service.getWarehouseIdsBySucursal = jest
    .fn<Promise<string[] | null>, []>()
    .mockResolvedValue(null);
  service.hydrateOrders = jest
    .fn<Promise<Order[]>, [Order[], boolean]>()
    .mockResolvedValue(orders);
  return { service, orders, qb };
}

function classificationFixture(products: Product[] = []) {
  const service = Object.create(
    OrdenCompraService.prototype,
  ) as ClassificationHarness;
  const findCategories = jest
    .fn<Promise<CatalogRow[]>, [unknown]>()
    .mockResolvedValue([{ id: 'spares', nombre: 'REPUESTO' }]);
  const findBrands = jest
    .fn<Promise<CatalogRow[]>, [unknown]>()
    .mockResolvedValue([{ id: 'mtu', nombre: 'MTU' }]);
  service.productoRepo = {
    find: jest.fn<Promise<Product[]>, [unknown]>().mockResolvedValue(products),
  };
  service.dataSource = {
    getRepository: jest
      .fn<{ find: typeof findCategories }, [typeof Categoria | typeof Marca]>()
      .mockImplementation((entity) => ({
        find: entity === Marca ? findBrands : findCategories,
      })),
  };
  return { service, findCategories, findBrands };
}

describe('Reportería de compras compatible con listado operativo', () => {
  it('omite el detalle por defecto y solo lo incluye al solicitarlo explícitamente', async () => {
    const { service, orders } = fixture();
    await service.findAll({});
    expect(service.hydrateOrders).toHaveBeenLastCalledWith(orders, false);
    await service.findAll({ include_details: 'true' });
    expect(service.hydrateOrders).toHaveBeenLastCalledWith(orders, true);
    await service.findAll({ include_details: 'false' });
    expect(service.hydrateOrders).toHaveBeenLastCalledWith(orders, false);
  });
  it('mantiene filtros de fecha, sucursal y exclusión de anuladas antes de cargar detalles', async () => {
    const { service, qb } = fixture();
    service.getWarehouseIdsBySucursal.mockResolvedValue(['warehouse']);
    await service.findAll(
      { desde: '2026-11-01', hasta: '2026-11-06', include_details: 'true' },
      'branch',
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'orden.bodega_destino_id IN (:...warehouseIds)',
      { warehouseIds: ['warehouse'] },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'DATE(orden.fecha_emision) >= :desde',
      { desde: '2026-11-01' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'DATE(orden.fecha_emision) <= :hasta',
      { hasta: '2026-11-06' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('ANULADA'),
    );
  });
  it('resuelve categorías y marcas por lote sin modificar importes', async () => {
    const { service, findCategories, findBrands } = classificationFixture([
      { id: 'filter', categoria_id: 'spares', marca_id: 'mtu' },
      { id: 'uncategorized', categoria_id: null, marca_id: null },
      { id: 'archived-brand', categoria_id: 'spares', marca_id: 'archived' },
    ]);
    const details: Detail[] = [
      { producto_id: 'filter', total: '23' },
      { producto_id: 'uncategorized', total: '0' },
      { producto_id: 'archived-brand', total: '4' },
    ];
    const classification = await service.buildDetailClassificationMap(details);
    expect(classification.get('filter')).toEqual({
      categoria_id: 'spares',
      categoria_nombre: 'REPUESTO',
      marca_id: 'mtu',
      marca_nombre: 'MTU',
    });
    expect(classification.get('uncategorized')).toEqual({
      categoria_id: null,
      categoria_nombre: 'Sin categoría',
      marca_id: null,
      marca_nombre: null,
    });
    expect(classification.get('archived-brand')?.marca_nombre).toBeNull();
    expect(service.dataSource.getRepository).toHaveBeenCalledWith(Categoria);
    expect(service.productoRepo.find.mock.calls[0]?.[0]).toMatchObject({
      where: { is_deleted: false },
    });
    expect(findCategories.mock.calls[0]?.[0]).toMatchObject({
      where: { is_deleted: false },
    });
    expect(findBrands).toHaveBeenCalledTimes(1);
    expect(findBrands.mock.calls[0]?.[0]).toMatchObject({
      where: { is_deleted: false },
    });
    expect(details[0].total).toBe('23');
  });
  it('no consulta el catálogo cuando no hay líneas', async () => {
    const { service } = classificationFixture();
    expect((await service.buildDetailClassificationMap([])).size).toBe(0);
    expect(service.productoRepo.find).not.toHaveBeenCalled();
  });
});
