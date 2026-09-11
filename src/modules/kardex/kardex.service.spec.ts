import { ConfigService } from '@nestjs/config';
import {
  Brackets,
  DataSource,
  EntityManager,
  ObjectLiteral,
  Repository,
  WhereExpressionBuilder,
} from 'typeorm';
import { Bodega } from '../entities/bodega.entity';
import { Categoria } from '../entities/categoria.entity';
import { Kardex } from '../entities/kardex.entity';
import { Linea } from '../entities/linea.entity';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { Producto } from '../entities/producto.entity';
import { StockBodega } from '../entities/stock-bodega.entity';
import { Sucursal } from '../entities/sucursal.entity';
import { UnidadMedida } from '../entities/unidad-medida.entity';
import { KardexService } from './kardex.service';

type ImportLocationResolver = {
  findOrCreateInventoryImportSucursal(
    manager: EntityManager,
    input: { codigo: string; nombre: string; userName: string },
  ): Promise<Sucursal>;
  findOrCreateInventoryImportBodega(
    manager: EntityManager,
    input: {
      sucursalId: string;
      codigo: string;
      nombre: string;
      direccion?: string | null;
      esPrincipal?: boolean;
      esDefaultCompra?: boolean;
      esChatarra?: boolean;
      userName: string;
    },
  ): Promise<Bodega>;
  getOrCreateStockRow(
    manager: EntityManager,
    args: {
      bodegaId: string;
      productoId: string;
      costoPromedio: number;
      userName: string;
    },
  ): Promise<StockBodega>;
  getOrReactivateMovementProduct(
    manager: EntityManager,
    productId: string,
    userName: string,
  ): Promise<Producto | null>;
  applyInventoryImportStockTarget(
    stockRow: StockBodega,
    target: {
      stockActual: number;
      stockNuevo: number;
      stockUsado: number;
      stockCritico: number;
      stockFisico: number;
      stockMinBodega: number;
      stockMaxBodega: number;
      stockMinGlobal: number;
      stockContenedores: number;
      costoPromedio: number;
      userName: string;
    },
  ): number;
  shouldSkipInventoryValidationRow(row: Record<string, unknown>): boolean;
  reconcileInventoryStockBreakdown(input: {
    hasStockActual: boolean;
    hasStockNuevo: boolean;
    hasStockUsado: boolean;
    hasStockCritico: boolean;
    stockActual: number;
    stockNuevo: number;
    stockUsado: number;
    stockCritico: number;
  }): {
    stockActual: number;
    stockNuevo: number;
    stockUsado: number;
    stockCritico: number;
  };
  resolveUnidadMedidaForProduct(
    manager: EntityManager,
    options: {
      codigoUnidad?: string | null;
      nombreUnidad?: string | null;
      abreviaturaUnidad?: string | null;
      tipoUnidad?: string | null;
      productName?: string | null;
      userName: string;
    },
  ): Promise<UnidadMedida>;
};

type MaterialSearchFilterResolver = {
  applyMaterialSearchFilter(qb: any, search?: string | null): void;
};

type MovementOriginFilterResolver = {
  applyMovementOriginFilter(qb: any, origin: string | null): void;
};

type CriticalStockResolver = {
  resolveManualMovementCondition(
    stock: StockBodega,
    type: 'INGRESO' | 'SALIDA',
    requestedCondition?: unknown,
  ): 'NUEVO' | 'USADO' | 'CRITICO';
  applyStockDeltaByCondition(
    stock: StockBodega,
    delta: number,
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
  ): number;
};

const emptyRepository = <T extends ObjectLiteral>() =>
  ({}) as unknown as Repository<T>;

const buildService = (dataSource = {} as DataSource) =>
  new KardexService(
    emptyRepository<Kardex>(),
    emptyRepository<StockBodega>(),
    emptyRepository<MovimientoInventario>(),
    emptyRepository<MovimientoInventarioDet>(),
    emptyRepository<Producto>(),
    emptyRepository<Bodega>(),
    emptyRepository<Sucursal>(),
    emptyRepository<Linea>(),
    emptyRepository<Categoria>(),
    emptyRepository<UnidadMedida>(),
    { get: jest.fn().mockReturnValue('') } as unknown as ConfigService,
    dataSource,
  );

const asImportLocationResolver = (service: KardexService) =>
  service as unknown as ImportLocationResolver;

const asMaterialSearchFilterResolver = (service: KardexService) =>
  service as unknown as MaterialSearchFilterResolver;

const asCriticalStockResolver = (service: KardexService) =>
  service as unknown as CriticalStockResolver;

const asMovementOriginFilterResolver = (service: KardexService) =>
  service as unknown as MovementOriginFilterResolver;

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('KardexService material search filters', () => {
  it('aplica los mismos criterios de material y documento al resumen y al detalle', () => {
    const andWhere = jest.fn();
    asMaterialSearchFilterResolver(buildService()).applyMaterialSearchFilter(
      { andWhere },
      '  EMPAQUE TAPA VALVULA  ',
    );

    expect(andWhere).toHaveBeenCalledTimes(1);
    const calls = andWhere.mock.calls as unknown as Array<[Brackets]>;
    const brackets = calls[0][0];
    const where = jest.fn().mockReturnThis();
    const orWhere = jest.fn().mockReturnThis();
    brackets.whereFactory({
      where,
      orWhere,
    } as unknown as WhereExpressionBuilder);

    const params = { search: '%EMPAQUE TAPA VALVULA%' };
    expect(where).toHaveBeenCalledWith('producto.nombre ILIKE :search', params);
    expect(orWhere).toHaveBeenCalledWith(
      'producto.codigo ILIKE :search',
      params,
    );
    expect(orWhere).toHaveBeenCalledWith(
      "COALESCE(producto.descripcion, '') ILIKE :search",
      params,
    );
    expect(orWhere).toHaveBeenCalledWith(
      "COALESCE(movimiento.numero_documento, '') ILIKE :search",
      params,
    );
    expect(orWhere).toHaveBeenCalledWith(
      "COALESCE(kardex.observacion, '') ILIKE :search",
      params,
    );
  });
});

type MovementLineAmountsResolver = {
  resolveMovementLineAmounts(
    cantidad: number,
    costoUnitarioBruto: number,
    detail: Record<string, unknown> | null,
    acceptsDiscount: boolean,
  ): {
    costoUnitarioBruto: number;
    descuento: number;
    porcentajeDescuento: number;
    subtotal: number;
    costoUnitarioNeto: number;
    ivaPorcentaje: number;
    iva: number;
    total: number;
  };
};

const asMovementLineAmountsResolver = (service: KardexService) =>
  service as unknown as MovementLineAmountsResolver;

type RunningBalanceResolver = {
  applyRunningBalanceToMovements(
    movements: Array<Record<string, unknown>>,
    stockInicial: number,
  ): Array<Record<string, unknown>>;
};

const asRunningBalanceResolver = (service: KardexService) =>
  service as unknown as RunningBalanceResolver;

describe('KardexService saldo corrido del detalle', () => {
  // La lista llega del mas reciente al mas antiguo, como se muestra.
  const movimientos = () => [
    { documento: 'EB-595', entrada: 0, salida: 45 },
    { documento: 'IB-2713', entrada: 45, salida: 0 },
    { documento: 'EB-161', entrada: 0, salida: 12 },
    { documento: 'IB-2264', entrada: 12, salida: 0 },
    { documento: 'EB-160', entrada: 0, salida: 36 },
    { documento: 'IB-2262', entrada: 36, salida: 0 },
  ];

  it('encadena el saldo desde la existencia inicial del rango', () => {
    const rows = movimientos();
    asRunningBalanceResolver(buildService()).applyRunningBalanceToMovements(rows, 0);

    expect(
      rows.map((row) => [row.documento, row.stock_inicial, row.stock_final]),
    ).toEqual([
      ['EB-595', 45, 0],
      ['IB-2713', 0, 45],
      ['EB-161', 12, 0],
      ['IB-2264', 0, 12],
      ['EB-160', 36, 0],
      ['IB-2262', 0, 36],
    ]);
  });

  it('el saldo final de una fila es el inicial de la anterior en la lista', () => {
    const rows = movimientos();
    asRunningBalanceResolver(buildService()).applyRunningBalanceToMovements(rows, 0);

    for (let index = 0; index < rows.length - 1; index += 1) {
      expect(rows[index]!.stock_inicial).toBe(rows[index + 1]!.stock_final);
    }
  });

  it('parte de la existencia previa cuando el rango no empieza en cero', () => {
    const rows = [
      { documento: 'EB-2', entrada: 0, salida: 3 },
      { documento: 'IB-1', entrada: 5, salida: 0 },
    ];
    asRunningBalanceResolver(buildService()).applyRunningBalanceToMovements(rows, 10);

    expect(rows[1]).toMatchObject({ stock_inicial: 10, stock_final: 15 });
    expect(rows[0]).toMatchObject({ stock_inicial: 15, stock_final: 12 });
  });

  it('un movimiento anulado no mueve el saldo', () => {
    const rows = [
      { documento: 'EB-2', entrada: 0, salida: 4 },
      { documento: 'EB-1', entrada: 0, salida: 7, anulado: true },
    ];
    asRunningBalanceResolver(buildService()).applyRunningBalanceToMovements(rows, 10);

    expect(rows[1]).toMatchObject({ stock_inicial: 10, stock_final: 10 });
    expect(rows[0]).toMatchObject({ stock_inicial: 10, stock_final: 6 });
  });

  it('`stock` queda como el saldo final, que es lo que la columna decia', () => {
    const rows = [{ documento: 'IB-1', entrada: 8, salida: 0, stock: 999 }];
    asRunningBalanceResolver(buildService()).applyRunningBalanceToMovements(rows, 2);

    expect(rows[0]!.stock).toBe(10);
  });
});

describe('KardexService ingreso de bodega con descuento', () => {
  const resolve = (
    cantidad: number,
    bruto: number,
    detail: Record<string, unknown> | null,
    acceptsDiscount = true,
  ) =>
    asMovementLineAmountsResolver(buildService()).resolveMovementLineAmounts(
      cantidad,
      bruto,
      detail,
      acceptsDiscount,
    );

  it('descuenta el importe y baja el costo unitario que entra al inventario', () => {
    const linea = resolve(10, 20, { descuento: 50 });

    expect(linea.subtotal).toBe(150);
    expect(linea.descuento).toBe(50);
    expect(linea.costoUnitarioBruto).toBe(20);
    // Lo que se valoriza es lo que se pago, no el precio de lista.
    expect(linea.costoUnitarioNeto).toBe(15);
    expect(linea.porcentajeDescuento).toBeCloseTo(25, 6);
  });

  it('acepta el descuento en porcentaje cuando no se da el importe', () => {
    const linea = resolve(4, 25, { porcentaje_descuento: 10 });

    expect(linea.descuento).toBe(10);
    expect(linea.subtotal).toBe(90);
    expect(linea.costoUnitarioNeto).toBe(22.5);
  });

  it('el importe manda sobre el porcentaje, igual que en la orden de compra', () => {
    const linea = resolve(2, 100, { descuento: 30, porcentaje_descuento: 90 });

    expect(linea.descuento).toBe(30);
    expect(linea.subtotal).toBe(170);
  });

  it('un descuento mayor que la linea la deja en cero, nunca en negativo', () => {
    const linea = resolve(2, 10, { descuento: 999 });

    expect(linea.descuento).toBe(20);
    expect(linea.subtotal).toBe(0);
    expect(linea.costoUnitarioNeto).toBe(0);
  });

  it('sin permiso para tocar importes el descuento se ignora', () => {
    const linea = resolve(5, 10, { descuento: 20, porcentaje_descuento: 50 }, false);

    expect(linea.descuento).toBe(0);
    expect(linea.subtotal).toBe(50);
    expect(linea.costoUnitarioNeto).toBe(10);
  });

  it('sin descuento el neto es el bruto', () => {
    const linea = resolve(3, 7, null);

    expect(linea.descuento).toBe(0);
    expect(linea.subtotal).toBe(21);
    expect(linea.costoUnitarioNeto).toBe(7);
    expect(linea.porcentajeDescuento).toBe(0);
  });

  it('el IVA se calcula sobre el neto y NO entra al costo del inventario', () => {
    const linea = resolve(10, 20, { descuento: 50, iva_porcentaje: 15 });

    expect(linea.subtotal).toBe(150);
    expect(linea.iva).toBe(22.5);
    // Lo que se paga.
    expect(linea.total).toBe(172.5);
    // Lo que vale la mercaderia: el impuesto es credito tributario, no costo.
    expect(linea.costoUnitarioNeto).toBe(15);
  });

  it('sin IVA el total de la linea es su subtotal', () => {
    const linea = resolve(2, 30, { iva_porcentaje: 0 });

    expect(linea.iva).toBe(0);
    expect(linea.total).toBe(60);
    expect(linea.subtotal).toBe(60);
  });

  it('sin permiso para tocar importes tampoco se aplica IVA', () => {
    const linea = resolve(2, 30, { iva_porcentaje: 15 }, false);

    expect(linea.ivaPorcentaje).toBe(0);
    expect(linea.iva).toBe(0);
    expect(linea.total).toBe(60);
  });
});

describe('KardexService movement origin filter', () => {
  it('cuenta como orden de compra tanto la transferencia enlazada como la OC citada a mano', () => {
    const andWhere = jest.fn();
    asMovementOriginFilterResolver(buildService()).applyMovementOriginFilter(
      { andWhere },
      'ORDEN_COMPRA',
    );

    expect(andWhere).toHaveBeenCalledTimes(1);
    const calls = andWhere.mock.calls as unknown as Array<[Brackets]>;
    const where = jest.fn().mockReturnThis();
    const orWhere = jest.fn().mockReturnThis();
    calls[0][0].whereFactory({
      where,
      orWhere,
    } as unknown as WhereExpressionBuilder);

    expect(squash(where.mock.calls[0][0] as string)).toContain(
      'transferencia_origen.orden_compra_id IS NOT NULL',
    );
    // Bodega recibe la mercaderia y teclea el codigo de la OC en la
    // referencia sin pasar por la transferencia: sigue siendo una compra.
    expect(squash(orWhere.mock.calls[0][0] as string)).toContain(
      "UPPER(TRIM(oc_referida.codigo)) = UPPER(TRIM(COALESCE(movimiento.referencia, '')))",
    );
  });

  it('deja fuera de los manuales lo que cita una orden de compra', () => {
    const andWhere = jest.fn();
    asMovementOriginFilterResolver(buildService()).applyMovementOriginFilter(
      { andWhere },
      'MANUAL',
    );

    const conditions = andWhere.mock.calls.map((call) =>
      squash(String(call[0])),
    );
    expect(conditions).toContain('movimiento.work_order_id IS NULL');
    expect(
      conditions.some((condition) =>
        condition.startsWith('NOT EXISTS ( SELECT 1 FROM kpi_inventory.tb_transferencia_bodega'),
      ),
    ).toBe(true);
    expect(
      conditions.some((condition) =>
        condition.startsWith('NOT EXISTS ( SELECT 1 FROM kpi_inventory.tb_orden_compra'),
      ),
    ).toBe(true);
  });
});

describe('KardexService critical stock', () => {
  it('consume stock crítico únicamente cuando nuevo y usado están en cero', () => {
    const stock = {
      stock_actual: '5.000000',
      stock_nuevo: '0.000000',
      stock_usado: '0.000000',
      stock_critico: '5.000000',
    } as StockBodega;

    const resolver = asCriticalStockResolver(buildService());
    const condition = resolver.resolveManualMovementCondition(
      stock,
      'SALIDA',
      'NUEVO',
    );
    const total = resolver.applyStockDeltaByCondition(stock, -2, condition);

    expect({ total, condition }).toEqual({ total: 3, condition: 'CRITICO' });
    expect(stock).toMatchObject({
      stock_actual: '3.000000',
      stock_nuevo: '0.000000',
      stock_usado: '0.000000',
      stock_critico: '3.000000',
    });
  });
});

describe('KardexService manual movement annulment', () => {
  it('identifica movimientos manuales históricos con referencia libre', async () => {
    const query = jest.fn().mockResolvedValue([
      { es_transferencia: false, es_compra: false },
    ]);
    const service = buildService({ query } as unknown as DataSource);

    await expect(
      (service as any).isKardexManualMovement({ query }, {
        id: 'movimiento-manual',
        tipo_documento: 'INGRESO_BODEGA',
        referencia: 'INGRESO PARA ENVIO A BLOQUE',
      }),
    ).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('tb_transferencia_bodega transferencia');
    expect(query.mock.calls[0][0]).toContain('tb_orden_compra orden_compra');
  });

  it('revierte el stock y desactiva los documentos generados desde Kardex', async () => {
    const movement = {
      id: 'movimiento-1',
      tipo_movimiento: 'SALIDA',
      tipo_documento: 'EGRESO_BODEGA',
      bodega_origen_id: 'bodega-1',
      numero_documento: 'KB-0001',
    } as MovimientoInventario;
    const stock = {
      id: 'stock-1',
      bodega_id: 'bodega-1',
      producto_id: 'producto-1',
      stock_actual: '5.000000',
      stock_fisico: '5.000000',
      stock_nuevo: '5.000000',
      stock_usado: '0.000000',
      stock_critico: '0.000000',
    } as StockBodega;
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([
        { es_transferencia: false, es_compra: false },
      ]),
      findOne: jest
        .fn()
        .mockResolvedValueOnce(movement)
        .mockResolvedValueOnce(stock),
      find: jest.fn().mockResolvedValue([
        {
          producto_id: 'producto-1',
          cantidad: '5',
          condicion_material: 'NUEVO',
        } as MovimientoInventarioDet,
      ]),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((callback) => callback(manager)),
    } as unknown as DataSource;
    const service = buildService(dataSource);
    jest
      .spyOn(service as any, 'notifyMaintenanceRecalculationForStocks')
      .mockResolvedValue(undefined);

    await expect(
      service.annulMovementDocument('movimiento-1', 'tester'),
    ).resolves.toMatchObject({ id: 'movimiento-1', estado: 'ANULADO' });

    expect(stock).toMatchObject({
      stock_actual: '10.000000',
      stock_fisico: '10.000000',
      stock_nuevo: '10.000000',
    });
    expect(movement).toMatchObject({
      estado: 'ANULADO',
      status: 'INACTIVE',
      is_deleted: true,
      deleted_by: 'tester',
    });
    expect(queryBuilder.execute).toHaveBeenCalledTimes(2);
  });

  it('rechaza documentos que no se originaron en Kardex', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        { es_transferencia: true, es_compra: false },
      ]),
      findOne: jest.fn().mockResolvedValue({
        id: 'movimiento-transferencia',
        tipo_documento: 'EGRESO_BODEGA',
      }),
    };
    const service = buildService({
      query: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn((callback) => callback(manager)),
    } as unknown as DataSource);

    await expect(
      service.annulMovementDocument('movimiento-transferencia'),
    ).rejects.toThrow('Solo se pueden anular documentos registrados desde el módulo de Kardex.');
  });
});

describe('KardexService inventory import locations', () => {
  it('reutiliza una sucursal existente sin editarla ni guardarla', async () => {
    const existing = {
      id: 'sucursal-existente',
      codigo: 'SUC-001',
      nombre: 'Nombre original',
      updated_by: 'USUARIO-ORIGINAL',
    } as Sucursal;
    const create = jest.fn();
    const save = jest.fn();
    const manager = {
      findOne: jest.fn().mockResolvedValue(existing),
      create,
      save,
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).findOrCreateInventoryImportSucursal(manager, {
      codigo: 'SUC-001',
      nombre: 'Nombre enviado por Excel',
      userName: 'IMPORTADOR',
    });

    expect(result).toBe(existing);
    expect(existing.nombre).toBe('Nombre original');
    expect(existing.updated_by).toBe('USUARIO-ORIGINAL');
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('reutiliza la bodega existente de la sucursal sin editar sus datos', async () => {
    const existing = {
      id: 'bodega-existente',
      sucursal_id: 'sucursal-existente',
      codigo: 'BOD-001',
      nombre: 'Bodega original',
      direccion: 'Dirección original',
      es_principal: false,
      es_default_compra: false,
      es_chatarra: false,
      updated_by: 'USUARIO-ORIGINAL',
    } as Bodega;
    const findOne = jest.fn().mockResolvedValue(existing);
    const create = jest.fn();
    const save = jest.fn();
    const manager = {
      findOne,
      create,
      save,
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).findOrCreateInventoryImportBodega(manager, {
      sucursalId: 'sucursal-existente',
      codigo: 'BOD-001',
      nombre: 'Nombre enviado por Excel',
      direccion: 'Dirección enviada por Excel',
      esPrincipal: true,
      esDefaultCompra: true,
      esChatarra: true,
      userName: 'IMPORTADOR',
    });

    expect(result).toBe(existing);
    expect(existing).toMatchObject({
      nombre: 'Bodega original',
      direccion: 'Dirección original',
      es_principal: false,
      es_default_compra: false,
      es_chatarra: false,
      updated_by: 'USUARIO-ORIGINAL',
    });
    expect(findOne).toHaveBeenCalledWith(Bodega, {
      where: {
        codigo: 'BOD-001',
        sucursal_id: 'sucursal-existente',
        is_deleted: false,
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('crea la sucursal y la bodega cuando no existen', async () => {
    const newSucursal = {
      codigo: 'SUC-NEW',
      nombre: 'Sucursal nueva',
    } as Sucursal;
    const savedSucursal = {
      ...newSucursal,
      id: 'sucursal-nueva',
    } as Sucursal;
    const saveSucursal = jest.fn().mockResolvedValue(savedSucursal);
    const sucursalManager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockReturnValue(newSucursal),
      save: saveSucursal,
    } as unknown as EntityManager;
    const resolver = asImportLocationResolver(buildService());

    const sucursal = await resolver.findOrCreateInventoryImportSucursal(
      sucursalManager,
      {
        codigo: 'SUC-NEW',
        nombre: 'Sucursal nueva',
        userName: 'IMPORTADOR',
      },
    );

    const newBodega = {
      sucursal_id: sucursal.id,
      codigo: 'BOD-NEW',
      nombre: 'Bodega nueva',
    } as Bodega;
    const savedBodega = {
      ...newBodega,
      id: 'bodega-nueva',
    } as Bodega;
    const saveBodega = jest.fn().mockResolvedValue(savedBodega);
    const bodegaManager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockReturnValue(newBodega),
      save: saveBodega,
    } as unknown as EntityManager;

    const bodega = await resolver.findOrCreateInventoryImportBodega(
      bodegaManager,
      {
        sucursalId: sucursal.id,
        codigo: 'BOD-NEW',
        nombre: 'Bodega nueva',
        direccion: 'Dirección nueva',
        esPrincipal: true,
        userName: 'IMPORTADOR',
      },
    );

    expect(sucursal).toBe(savedSucursal);
    expect(bodega).toBe(savedBodega);
    expect(saveSucursal).toHaveBeenCalledTimes(1);
    expect(saveBodega).toHaveBeenCalledTimes(1);
  });

  it('reactiva la fila de stock eliminada y conserva el saldo antes de sumar el ingreso', async () => {
    const existingStock = {
      id: 'stock-existente',
      bodega_id: 'bodega-tpta',
      producto_id: 'producto-1',
      stock_actual: '40.000000',
      stock_nuevo: '40.000000',
      stock_usado: '0.000000',
      stock_critico: '0.000000',
      stock_fisico: '40.000000',
      status: 'INACTIVE',
      is_deleted: true,
      deleted_at: new Date('2026-08-24T23:00:48.058Z'),
      deleted_by: 'USUARIO-ANTERIOR',
    } as StockBodega;
    const create = jest.fn();
    const save = jest.fn(async (_entity: unknown, row: StockBodega) => row);
    const findOne = jest.fn().mockResolvedValue(existingStock);
    const manager = { findOne, create, save } as unknown as EntityManager;
    const service = buildService();

    const result = await asImportLocationResolver(
      service,
    ).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-tpta',
      productoId: 'producto-1',
      costoPromedio: 0,
      userName: 'IMPORTADOR',
    });
    const total = asCriticalStockResolver(service).applyStockDeltaByCondition(
      result,
      40,
      'NUEVO',
    );

    expect(findOne).toHaveBeenCalledWith(StockBodega, {
      where: {
        bodega_id: 'bodega-tpta',
        producto_id: 'producto-1',
      },
      lock: { mode: 'pessimistic_write' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: 'stock-existente',
      status: 'ACTIVE',
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      updated_by: 'IMPORTADOR',
      stock_actual: '80.000000',
      stock_nuevo: '80.000000',
    });
    expect(total).toBe(80);
  });

  it('reactiva el producto eliminado cuando vuelve a ingresar stock', async () => {
    const product = {
      id: 'producto-1',
      codigo: 'P00001241',
      nombre: 'GUANTE MULTIUSOS T9',
      status: 'INACTIVE',
      is_deleted: true,
      deleted_at: new Date('2026-08-30T18:03:20.477Z'),
      deleted_by: 'USUARIO-ANTERIOR',
    } as Producto;
    const save = jest.fn(async (_entity: unknown, row: Producto) => row);
    const manager = {
      findOne: jest.fn().mockResolvedValue(product),
      save,
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).getOrReactivateMovementProduct(manager, product.id, 'IMPORTADOR');

    expect(result).toMatchObject({
      id: 'producto-1',
      status: 'ACTIVE',
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      updated_by: 'IMPORTADOR',
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('no persiste un registro de stock nuevo con saldos provisionales en cero', async () => {
    const newStock = {
      bodega_id: 'bodega-tpta',
      producto_id: 'producto-1',
      stock_actual: '0.000000',
      stock_nuevo: '0.000000',
      stock_usado: '0.000000',
      stock_fisico: '0.000000',
    } as StockBodega;
    const create = jest.fn().mockReturnValue(newStock);
    const save = jest.fn();
    const manager = {
      findOne: jest.fn().mockResolvedValue(null),
      create,
      save,
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).getOrCreateStockRow(manager, {
      bodegaId: 'bodega-tpta',
      productoId: 'producto-1',
      costoPromedio: 0,
      userName: 'IMPORTADOR',
    });

    expect(result).toBe(newStock);
    expect(create).toHaveBeenCalledWith(
      StockBodega,
      expect.objectContaining({
        bodega_id: 'bodega-tpta',
        producto_id: 'producto-1',
      }),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('aplica juntos los cuatro saldos leídos del Excel antes de guardar', () => {
    const stock = {
      stock_actual: '0.000000',
      stock_nuevo: '0.000000',
      stock_usado: '0.000000',
      stock_critico: '0.000000',
      stock_fisico: '0.000000',
    } as StockBodega;

    const total = asImportLocationResolver(
      buildService(),
    ).applyInventoryImportStockTarget(stock, {
      stockActual: 2,
      stockNuevo: 0,
      stockUsado: 2,
      stockCritico: 0,
      stockFisico: 2,
      stockMinBodega: 6,
      stockMaxBodega: 12,
      stockMinGlobal: 12,
      stockContenedores: 0,
      costoPromedio: 0,
      userName: 'IMPORTADOR',
    });

    expect(total).toBe(2);
    expect(stock).toMatchObject({
      stock_actual: '2.000000',
      stock_nuevo: '0.000000',
      stock_usado: '2.000000',
      stock_critico: '0.000000',
      stock_fisico: '2.000000',
      stock_min_bodega: '6.000000',
      stock_max_bodega: '12.000000',
      stock_min_global: '12.000000',
      stock_contenedores: '0.000000',
      es_usado: true,
      updated_by: 'IMPORTADOR',
    });
  });

  it('rechaza un desglose que no coincide con el stock total', () => {
    expect(() =>
      asImportLocationResolver(buildService()).reconcileInventoryStockBreakdown(
        {
          hasStockActual: true,
          hasStockNuevo: true,
          hasStockUsado: true,
          hasStockCritico: true,
          stockActual: 1,
          stockNuevo: 2,
          stockUsado: 1,
          stockCritico: 0,
        },
      ),
    ).toThrow(
      'Stock Actual (1) debe coincidir con Stock Nuevo + Stock Usado + Stock Critico (3).',
    );
  });

  it('omite las filas marcadas como INCONGRUENTE', () => {
    const resolver = asImportLocationResolver(buildService());

    expect(
      resolver.shouldSkipInventoryValidationRow({
        'Estado Validacion Kardex': 'INCONGRUENTE',
      }),
    ).toBe(true);
    expect(
      resolver.shouldSkipInventoryValidationRow({
        'Estado Validacion Kardex': 'OK',
      }),
    ).toBe(false);
  });

  it('prioriza la unidad existente por nombre sin renombrar la unidad del código', async () => {
    const unidadGenerica = {
      id: 'unidad-generica',
      codigo: 'UND',
      nombre: 'UNIDAD',
      abreviatura: 'UND',
    } as UnidadMedida;
    const paquete = {
      id: 'unidad-paquete',
      codigo: 'PAQ',
      nombre: 'PAQUETE',
      abreviatura: 'PAQ',
    } as UnidadMedida;
    const find = jest.fn().mockResolvedValue([unidadGenerica, paquete]);
    const save = jest.fn();
    const manager = {
      find,
      save,
      create: jest.fn(),
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).resolveUnidadMedidaForProduct(manager, {
      codigoUnidad: 'UND',
      nombreUnidad: 'PAQUETE',
      abreviaturaUnidad: 'PAQ',
      productName: 'FUNDA ZIPLOC',
      userName: 'IMPORTADOR',
    });

    expect(result).toBe(paquete);
    expect(unidadGenerica).toMatchObject({
      codigo: 'UND',
      nombre: 'UNIDAD',
      abreviatura: 'UND',
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('resuelve GAL como galones aunque el nombre recibido sea UNIDAD', async () => {
    const galones = {
      id: 'unidad-galones',
      codigo: 'GALONES',
      nombre: 'GALONES',
      abreviatura: 'GAL',
    } as UnidadMedida;
    const findOne = jest.fn().mockResolvedValue(galones);
    const save = jest.fn();
    const manager = {
      findOne,
      save,
      create: jest.fn(),
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).resolveUnidadMedidaForProduct(manager, {
      codigoUnidad: 'GAL',
      nombreUnidad: 'UNIDAD',
      abreviaturaUnidad: 'GAL',
      productName: 'DESENGRASANTE PERFORMANCE',
      userName: 'IMPORTADOR',
    });

    expect(result).toBe(galones);
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('crea la unidad únicamente cuando no existe una coincidencia', async () => {
    const createdUnit = {
      codigo: 'CAJ',
      nombre: 'CAJA',
      abreviatura: 'CJ',
    } as UnidadMedida;
    const savedUnit = {
      ...createdUnit,
      id: 'unidad-caja',
    } as UnidadMedida;
    const find = jest.fn().mockResolvedValue([]);
    const create = jest.fn().mockReturnValue(createdUnit);
    const save = jest.fn().mockResolvedValue(savedUnit);
    const manager = {
      find,
      create,
      save,
    } as unknown as EntityManager;

    const result = await asImportLocationResolver(
      buildService(),
    ).resolveUnidadMedidaForProduct(manager, {
      codigoUnidad: 'CAJ',
      nombreUnidad: 'CAJA',
      abreviaturaUnidad: 'CJ',
      productName: 'REPUESTO EN CAJA',
      userName: 'IMPORTADOR',
    });

    expect(result).toBe(savedUnit);
    expect(create).toHaveBeenCalledWith(
      UnidadMedida,
      expect.objectContaining({
        codigo: 'CAJ',
        nombre: 'CAJA',
        abreviatura: 'CJ',
        created_by: 'IMPORTADOR',
        updated_by: 'IMPORTADOR',
      }),
    );
    expect(save).toHaveBeenCalledTimes(1);
  });
});

type InitialStockResolver = {
  getInitialStockByProduct(
    productIds: string[],
    fromDate: Date,
    sucursalId?: string | null,
    warehouseId?: string | null,
  ): Promise<Map<string, number>>;
};

/**
 * Constructor de consultas de mentira: encadena todo y devuelve las filas
 * pedidas al llegar a `getRawMany`.
 */
const stubQueryBuilder = (rows: Record<string, unknown>[]) => {
  const builder: Record<string, any> = {
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  for (const method of [
    'leftJoin',
    'where',
    'andWhere',
    'select',
    'groupBy',
    'orderBy',
    'addOrderBy',
  ]) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  return builder;
};

describe('KardexService stock inicial del rango', () => {
  const PRODUCT = 'producto-perno';

  const buildResolver = (
    stockRows: Record<string, unknown>[],
    movementRows: Record<string, unknown>[],
  ) => {
    const kardexRepo = {
      createQueryBuilder: jest.fn(() => stubQueryBuilder(movementRows)),
    } as unknown as Repository<Kardex>;
    const stockRepo = {
      createQueryBuilder: jest.fn(() => stubQueryBuilder(stockRows)),
    } as unknown as Repository<StockBodega>;

    const service = new KardexService(
      kardexRepo,
      stockRepo,
      emptyRepository<MovimientoInventario>(),
      emptyRepository<MovimientoInventarioDet>(),
      emptyRepository<Producto>(),
      emptyRepository<Bodega>(),
      emptyRepository<Sucursal>(),
      emptyRepository<Linea>(),
      emptyRepository<Categoria>(),
      emptyRepository<UnidadMedida>(),
      { get: jest.fn().mockReturnValue('') } as unknown as ConfigService,
      {} as DataSource,
    );
    return service as unknown as InitialStockResolver;
  };

  it('reconstruye el saldo previo desde el stock real de la bodega', async () => {
    // El caso que rompia: un material sin kardex anterior al rango, con 5 en
    // bodega y una sola salida dentro del rango. Antes arrancaba en cero y el
    // reporte mostraba -1.
    const resolver = buildResolver(
      [{ producto_id: PRODUCT, stock_actual: '5' }],
      [{ producto_id: PRODUCT, entradas: '0', salidas: '1' }],
    );

    const result = await resolver.getInitialStockByProduct(
      [PRODUCT],
      new Date('2026-09-01T00:00:00'),
    );

    expect(result.get(PRODUCT)).toBe(6);
  });

  it('deshace tambien los ingresos posteriores al corte', async () => {
    const resolver = buildResolver(
      [{ producto_id: PRODUCT, stock_actual: '20' }],
      [{ producto_id: PRODUCT, entradas: '15', salidas: '3' }],
    );

    const result = await resolver.getInitialStockByProduct(
      [PRODUCT],
      new Date('2026-09-01T00:00:00'),
    );

    expect(result.get(PRODUCT)).toBe(8);
  });

  it('nunca devuelve una existencia negativa', async () => {
    const resolver = buildResolver(
      [{ producto_id: PRODUCT, stock_actual: '0' }],
      [{ producto_id: PRODUCT, entradas: '10', salidas: '0' }],
    );

    const result = await resolver.getInitialStockByProduct(
      [PRODUCT],
      new Date('2026-09-01T00:00:00'),
    );

    expect(result.get(PRODUCT)).toBe(0);
  });

  it('resuelve el material que ya no tiene fila de stock en la bodega', async () => {
    const resolver = buildResolver(
      [],
      [{ producto_id: PRODUCT, entradas: '0', salidas: '4' }],
    );

    const result = await resolver.getInitialStockByProduct(
      [PRODUCT],
      new Date('2026-09-01T00:00:00'),
    );

    expect(result.get(PRODUCT)).toBe(4);
  });

  it('no consulta nada cuando no hay materiales', async () => {
    const resolver = buildResolver([], []);
    const result = await resolver.getInitialStockByProduct(
      [],
      new Date('2026-09-01T00:00:00'),
    );
    expect(result.size).toBe(0);
  });
});
