import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, ObjectLiteral, Repository } from 'typeorm';
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
    stockActual: number;
    stockNuevo: number;
    stockUsado: number;
  }): { stockActual: number; stockNuevo: number; stockUsado: number };
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

const emptyRepository = <T extends ObjectLiteral>() =>
  ({}) as unknown as Repository<T>;

const buildService = () =>
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
    {} as unknown as DataSource,
  );

const asImportLocationResolver = (service: KardexService) =>
  service as unknown as ImportLocationResolver;

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
      stock_fisico: '0.000000',
    } as StockBodega;

    const total = asImportLocationResolver(
      buildService(),
    ).applyInventoryImportStockTarget(stock, {
      stockActual: 2,
      stockNuevo: 0,
      stockUsado: 2,
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
      stock_fisico: '2.000000',
      stock_min_bodega: '6.000000',
      stock_max_bodega: '12.000000',
      stock_min_global: '12.000000',
      stock_contenedores: '0.000000',
      es_usado: true,
      updated_by: 'IMPORTADOR',
    });
  });

  it('reconcilia el desglose inconsistente usando Stock Actual como total', () => {
    const result = asImportLocationResolver(
      buildService(),
    ).reconcileInventoryStockBreakdown({
      hasStockActual: true,
      hasStockNuevo: true,
      hasStockUsado: true,
      stockActual: 1,
      stockNuevo: 2,
      stockUsado: 1,
    });

    expect(result).toEqual({
      stockActual: 1,
      stockNuevo: 0,
      stockUsado: 1,
    });
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
