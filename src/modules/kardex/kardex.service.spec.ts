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
      "COALESCE(movimiento.numero_documento, '') ILIKE :search",
      params,
    );
    expect(orWhere).toHaveBeenCalledWith(
      "COALESCE(kardex.observacion, '') ILIKE :search",
      params,
    );
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
  it('marca de forma conservadora los movimientos manuales históricos', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = buildService({ query } as unknown as DataSource);

    await service.onModuleInit();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("SET origen_documento = 'KARDEX_MANUAL'");
    expect(query.mock.calls[1][0]).toContain('work_order_id IS NULL');
    expect(query.mock.calls[1][0]).toContain('tb_transferencia_bodega transferencia');
    expect(query.mock.calls[1][0]).toContain('tb_orden_compra orden_compra');
  });

  it('revierte el stock y desactiva los documentos generados desde Kardex', async () => {
    const movement = {
      id: 'movimiento-1',
      origen_documento: 'KARDEX_MANUAL',
      tipo_movimiento: 'SALIDA',
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
      findOne: jest.fn().mockResolvedValue({
        id: 'movimiento-transferencia',
        origen_documento: 'TRANSFERENCIA_BODEGA',
      }),
    };
    const service = buildService({
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
