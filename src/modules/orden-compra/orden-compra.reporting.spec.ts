import { OrdenCompraService } from './orden-compra.service';
import { Categoria, OrdenCompra, OrdenCompraDet } from '../entities';

type Order = Pick<OrdenCompra, 'id' | 'estado'>;
type Category = { categoria_id: string | null; categoria_nombre: string };
type Product = { id: string; categoria_id: string | null };
type CategoryRow = { id: string; nombre: string };
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

type CategoryHarness = {
  buildDetailCategoryMap: (details: Detail[]) => Promise<Map<string, Category>>;
  productoRepo: { find: jest.Mock<Promise<Product[]>, [unknown]> };
  dataSource: {
    getRepository: jest.Mock<
      { find: jest.Mock<Promise<CategoryRow[]>, [unknown]> },
      [typeof Categoria]
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

function categoryFixture(products: Product[] = []) {
  const service = Object.create(
    OrdenCompraService.prototype,
  ) as CategoryHarness;
  const findCategories = jest
    .fn<Promise<CategoryRow[]>, [unknown]>()
    .mockResolvedValue([{ id: 'spares', nombre: 'Repuestos' }]);
  service.productoRepo = {
    find: jest.fn<Promise<Product[]>, [unknown]>().mockResolvedValue(products),
  };
  service.dataSource = {
    getRepository: jest
      .fn<{ find: typeof findCategories }, [typeof Categoria]>()
      .mockReturnValue({ find: findCategories }),
  };
  return { service, findCategories };
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
  it('resuelve categorías por lote y filtra catálogos borrados sin modificar importes', async () => {
    const { service, findCategories } = categoryFixture([
      { id: 'filter', categoria_id: 'spares' },
      { id: 'uncategorized', categoria_id: null },
    ]);
    const details: Detail[] = [
      { producto_id: 'filter', total: '23' },
      { producto_id: 'uncategorized', total: '0' },
    ];
    const categories = await service.buildDetailCategoryMap(details);
    expect(categories.get('filter')).toEqual({
      categoria_id: 'spares',
      categoria_nombre: 'Repuestos',
    });
    expect(categories.get('uncategorized')).toEqual({
      categoria_id: null,
      categoria_nombre: 'Sin categoría',
    });
    expect(service.dataSource.getRepository).toHaveBeenCalledWith(Categoria);
    expect(service.productoRepo.find.mock.calls[0]?.[0]).toMatchObject({
      where: { is_deleted: false },
    });
    expect(findCategories.mock.calls[0]?.[0]).toMatchObject({
      where: { is_deleted: false },
    });
    expect(details[0].total).toBe('23');
  });
  it('no consulta el catálogo cuando no hay líneas', async () => {
    const { service } = categoryFixture();
    expect((await service.buildDetailCategoryMap([])).size).toBe(0);
    expect(service.productoRepo.find).not.toHaveBeenCalled();
  });
});
