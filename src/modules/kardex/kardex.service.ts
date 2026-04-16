import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
import * as XLSX from 'xlsx';
import { Kardex } from '../entities/kardex.entity';
import { StockBodega } from '../entities/stock-bodega.entity';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { Producto } from '../entities/producto.entity';
import { Bodega } from '../entities/bodega.entity';
import { Sucursal } from '../entities/sucursal.entity';
import { Linea } from '../entities/linea.entity';
import { Categoria } from '../entities/categoria.entity';
import { Marca } from '../entities/marca.entity';
import { UnidadMedida } from '../entities/unidad-medida.entity';
import { OrdenCompra } from '../entities/orden-compra.entity';
import { TransferenciaBodega } from '../entities/transferencia-bodega.entity';
import { TransferenciaBodegaDet } from '../entities/transferencia-bodega-det.entity';

type MovementType = 'INGRESO' | 'SALIDA';

type ManualMovementPayload = {
  tipo_movimiento?: string;
  bodega_id?: string;
  producto_id?: string;
  cantidad?: string | number;
  observacion?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
};

type MovementDocumentDetailPayload = {
  producto_id?: string;
  cantidad?: string | number;
  observacion?: string | null;
};

type MovementDocumentPayload = {
  tipo_movimiento?: string;
  fecha_movimiento?: string | Date | null;
  bodega_id?: string;
  referencia?: string | null;
  observacion?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  detalles?: MovementDocumentDetailPayload[];
};

type ImportInventorySummary = {
  procesados: number;
  omitidos: number;
  creados: number;
  actualizados: number;
  ingresos: number;
  salidas: number;
  errores: string[];
};

type InventoryImportProgress = {
  currentIndex: number;
  totalRows: number;
  currentStep: string;
};

type InventoryImportResult = ImportInventorySummary & {
  hoja: string;
  total_filas: number;
};

type InventoryImportJobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

type InventoryImportJobState = {
  id: string;
  status: InventoryImportJobStatus;
  progress: number;
  source_file_name: string | null;
  stored_file_name: string | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  current_step: string | null;
  current_index: number;
  total_rows: number;
  summary: InventoryImportResult | null;
  error_message: string | null;
};

@Injectable()
export class KardexService extends CrudService<Kardex> {
  private readonly logger = new Logger(KardexService.name);
  private readonly importJobs = new Map<string, InventoryImportJobState>();
  private readonly importRoot: string;

  constructor(
    @InjectRepository(Kardex)
    repository: Repository<Kardex>,
    @InjectRepository(StockBodega)
    private readonly stockRepo: Repository<StockBodega>,
    @InjectRepository(MovimientoInventario)
    private readonly movimientoRepo: Repository<MovimientoInventario>,
    @InjectRepository(MovimientoInventarioDet)
    private readonly movimientoDetRepo: Repository<MovimientoInventarioDet>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
    @InjectRepository(Sucursal)
    private readonly sucursalRepo: Repository<Sucursal>,
    @InjectRepository(Linea)
    private readonly lineaRepo: Repository<Linea>,
    @InjectRepository(Categoria)
    private readonly categoriaRepo: Repository<Categoria>,
    @InjectRepository(UnidadMedida)
    private readonly unidadRepo: Repository<UnidadMedida>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super(repository);
    const configuredImportRoot = String(
      this.configService.get('INVENTORY_IMPORT_DIR') || '',
    ).trim();
    this.importRoot =
      configuredImportRoot || join(process.cwd(), 'storage', 'inventory-imports');
  }

  async findAllPaginated(
    page = 1,
    limit = 10,
    search?: string,
    sucursalId?: string | null,
  ) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = String(search ?? '').trim();

    const qb = this.repository
      .createQueryBuilder('kardex')
      .leftJoin(
        Bodega,
        'bodega',
        'bodega.id = kardex.bodega_id AND bodega.is_deleted = false',
      )
      .leftJoin(
        Producto,
        'producto',
        'producto.id = kardex.producto_id AND producto.is_deleted = false',
      )
      .where('kardex.is_deleted = false');

    if (sucursalId) {
      qb.andWhere('bodega.sucursal_id = :sucursalId', { sucursalId });
    }

    if (normalizedSearch) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('producto.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('producto.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('bodega.nombre ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('bodega.codigo ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('kardex.tipo_movimiento ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(kardex.observacion, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            });
        }),
      );
    }

    const [data, total] = await qb
      .orderBy('kardex.fecha', 'DESC')
      .addOrderBy('kardex.created_at', 'DESC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getManyAndCount();

    return {
      data,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  async getMaterialSummary(params?: {
    desde?: string | null;
    hasta?: string | null;
    search?: string | null;
  }, sucursalId?: string | null) {
    const range = this.resolveSummaryRange(params?.desde, params?.hasta);
    const search = this.toText(params?.search);

    const qb = this.repository
      .createQueryBuilder('kardex')
      .leftJoin(
        Bodega,
        'bodega',
        'bodega.id = kardex.bodega_id AND bodega.is_deleted = false',
      )
      .leftJoin(
        Producto,
        'producto',
        'producto.id = kardex.producto_id AND producto.is_deleted = false',
      )
      .leftJoin(
        Linea,
        'linea',
        'linea.id = producto.linea_id AND linea.is_deleted = false',
      )
      .leftJoin(
        Categoria,
        'categoria',
        'categoria.id = producto.categoria_id AND categoria.is_deleted = false',
      )
      .leftJoin(
        UnidadMedida,
        'unidad',
        'unidad.id = producto.unidad_medida_id AND unidad.is_deleted = false',
      )
      .leftJoin(
        MovimientoInventario,
        'movimiento',
        'movimiento.id = kardex.movimiento_id AND movimiento.is_deleted = false',
      )
      .leftJoin(
        TransferenciaBodegaDet,
        'transfer_det',
        '(transfer_det.kardex_ingreso_id = kardex.id OR transfer_det.kardex_salida_id = kardex.id) AND transfer_det.is_deleted = false',
      )
      .leftJoin(
        TransferenciaBodega,
        'transferencia',
        'transferencia.id = transfer_det.transferencia_bodega_id AND transferencia.is_deleted = false',
      )
      .where('kardex.is_deleted = false')
      .andWhere('kardex.fecha BETWEEN :fromDate AND :toDate', {
        fromDate: range.from,
        toDate: range.to,
      });

    if (sucursalId) {
      qb.andWhere('bodega.sucursal_id = :sucursalId', { sucursalId });
    }

    if (search) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('producto.nombre ILIKE :search', { search: `%${search}%` })
            .orWhere('producto.codigo ILIKE :search', { search: `%${search}%` })
            .orWhere('COALESCE(movimiento.numero_documento, \'\') ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('COALESCE(movimiento.referencia, \'\') ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('COALESCE(transferencia.codigo, \'\') ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('COALESCE(bodega.nombre, \'\') ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('COALESCE(bodega.codigo, \'\') ILIKE :search', {
              search: `%${search}%`,
            });
        }),
      );
    }

    const rows = await qb
      .select([
        'kardex.id AS kardex_id',
        'kardex.fecha AS fecha',
        'kardex.created_at AS created_at',
        'kardex.producto_id AS producto_id',
        'kardex.bodega_id AS bodega_id',
        'kardex.tipo_movimiento AS tipo_movimiento',
        'kardex.entrada_cantidad AS entrada_cantidad',
        'kardex.salida_cantidad AS salida_cantidad',
        'kardex.saldo_cantidad AS saldo_cantidad',
        'kardex.observacion AS kardex_observacion',
        'producto.codigo AS producto_codigo',
        'producto.nombre AS producto_nombre',
        'linea.codigo AS linea_codigo',
        'linea.nombre AS linea_nombre',
        'categoria.nombre AS categoria_nombre',
        'unidad.nombre AS unidad_nombre',
        'bodega.codigo AS bodega_codigo',
        'bodega.nombre AS bodega_nombre',
        'movimiento.numero_documento AS movimiento_numero_documento',
        'movimiento.referencia AS movimiento_referencia',
        'movimiento.tipo_documento AS movimiento_tipo_documento',
        'movimiento.observacion AS movimiento_observacion',
        'transferencia.codigo AS transferencia_codigo',
      ])
      .orderBy('COALESCE(producto.nombre, \'\')', 'ASC')
      .addOrderBy('COALESCE(producto.codigo, \'\')', 'ASC')
      .addOrderBy('kardex.fecha', 'ASC')
      .addOrderBy('kardex.created_at', 'ASC')
      .getRawMany<Record<string, unknown>>();

    if (!rows.length) {
      return {
        range: {
          desde: this.formatDateOnly(range.from),
          hasta: this.formatDateOnly(range.to),
        },
        totals: {
          materiales: 0,
          movimientos: 0,
          entradas: 0,
          salidas: 0,
        },
        groups: [],
      };
    }

    const productIds = [...new Set(rows.map((row) => this.toText(row.producto_id)).filter(Boolean))];
    const initialStockByProduct = await this.getInitialStockByProduct(
      productIds,
      range.from,
      sucursalId,
    );

    const groupsMap = new Map<string, Record<string, unknown>>();
    let totalEntradas = 0;
    let totalSalidas = 0;
    let totalMovimientos = 0;

    for (const row of rows) {
      const productoId = this.toText(row.producto_id);
      if (!productoId) continue;

      const entrada = this.toNumber(row.entrada_cantidad, 0);
      const salida = this.toNumber(row.salida_cantidad, 0);
      const lineLabel = [this.toText(row.linea_codigo), this.toText(row.linea_nombre)]
        .filter(Boolean)
        .join(' - ');
      const bodegaLabel = [this.toText(row.bodega_codigo), this.toText(row.bodega_nombre)]
        .filter(Boolean)
        .join(' - ');

      if (!groupsMap.has(productoId)) {
        groupsMap.set(productoId, {
          producto_id: productoId,
          producto_codigo: this.toText(row.producto_codigo),
          producto_nombre: this.toText(row.producto_nombre),
          linea_label: lineLabel,
          categoria_label: this.toText(row.categoria_nombre),
          unidad_label: this.toText(row.unidad_nombre),
          stock_inicial: initialStockByProduct.get(productoId) ?? 0,
          entradas: 0,
          salidas: 0,
          stock_final: initialStockByProduct.get(productoId) ?? 0,
          movimientos_count: 0,
          movimientos: [] as Record<string, unknown>[],
        });
      }

      const group = groupsMap.get(productoId)!;
      const currentEntries = this.toNumber(group.entradas, 0) + entrada;
      const currentExits = this.toNumber(group.salidas, 0) + salida;
      const initialStock = this.toNumber(group.stock_inicial, 0);
      group.entradas = currentEntries;
      group.salidas = currentExits;
      group.stock_final = initialStock + currentEntries - currentExits;
      group.movimientos_count = this.toNumber(group.movimientos_count, 0) + 1;
      (group.movimientos as Record<string, unknown>[]).push({
        id: this.toText(row.kardex_id),
        fecha_emision: row.fecha,
        fecha_creacion: row.created_at,
        documento: this.resolveDocumentCode(row),
        referencia: this.toText(row.movimiento_referencia) || this.toText(row.transferencia_codigo),
        concepto: this.resolveMovementConcept(row),
        descripcion:
          this.toText(row.movimiento_observacion) ||
          this.toText(row.kardex_observacion) ||
          bodegaLabel ||
          'Movimiento de inventario',
        bodega: bodegaLabel || 'Sin bodega',
        entrada,
        salida,
        stock: this.toNumber(row.saldo_cantidad, 0),
      });

      totalEntradas += entrada;
      totalSalidas += salida;
      totalMovimientos += 1;
    }

    const groups = [...groupsMap.values()]
      .map((group) => ({
        ...group,
        stock_inicial: this.toNumber(group.stock_inicial, 0),
        entradas: this.toNumber(group.entradas, 0),
        salidas: this.toNumber(group.salidas, 0),
        stock_final: this.toNumber(group.stock_final, 0),
        movimientos_count: this.toNumber(group.movimientos_count, 0),
      }))
      .sort((a: any, b: any) =>
        `${this.toText(a.producto_codigo)}|${this.toText(a.producto_nombre)}`.localeCompare(
          `${this.toText(b.producto_codigo)}|${this.toText(b.producto_nombre)}`,
        ),
      );

    return {
      range: {
        desde: this.formatDateOnly(range.from),
        hasta: this.formatDateOnly(range.to),
      },
      totals: {
        materiales: groups.length,
        movimientos: totalMovimientos,
        entradas: totalEntradas,
        salidas: totalSalidas,
      },
      groups,
    };
  }

  async getMovementDocuments(
    page = 1,
    limit = 10,
    search?: string | null,
    tipoMovimiento?: string | null,
    sucursalId?: string | null,
  ) {
    const safePage = Number.isFinite(+page) && +page > 0 ? +page : 1;
    const safeLimit =
      Number.isFinite(+limit) && +limit > 0 ? Math.min(+limit, 100) : 10;
    const normalizedSearch = this.toText(search);
    const normalizedType = this.normalizeMovementType(tipoMovimiento);

    const qb = this.movimientoRepo
      .createQueryBuilder('movimiento')
      .leftJoin(
        Bodega,
        'bodega_origen',
        'bodega_origen.id = movimiento.bodega_origen_id AND bodega_origen.is_deleted = false',
      )
      .leftJoin(
        Bodega,
        'bodega_destino',
        'bodega_destino.id = movimiento.bodega_destino_id AND bodega_destino.is_deleted = false',
      )
      .where('movimiento.is_deleted = false')
      .andWhere('movimiento.tipo_movimiento IN (:...movementTypes)', {
        movementTypes: ['INGRESO', 'SALIDA'],
      })
      .andWhere(
        "(COALESCE(movimiento.numero_documento, '') <> '' OR COALESCE(movimiento.referencia, '') <> '')",
      );

    if (sucursalId) {
      qb.andWhere(
        new Brackets((scopeQb) => {
          scopeQb
            .where('bodega_origen.sucursal_id = :sucursalId', { sucursalId })
            .orWhere('bodega_destino.sucursal_id = :sucursalId', {
              sucursalId,
            });
        }),
      );
    }

    if (normalizedType) {
      qb.andWhere('movimiento.tipo_movimiento = :normalizedType', {
        normalizedType,
      });
    }

    if (normalizedSearch) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('COALESCE(movimiento.numero_documento, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(movimiento.referencia, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(movimiento.observacion, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(bodega_origen.nombre, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(bodega_origen.codigo, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(bodega_destino.nombre, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere('COALESCE(bodega_destino.codigo, \'\') ILIKE :search', {
              search: `%${normalizedSearch}%`,
            })
            .orWhere(
              `EXISTS (
                SELECT 1
                FROM kpi_inventory.tb_movimiento_inventario_det det
                LEFT JOIN kpi_inventory.tb_producto prod
                  ON prod.id = det.producto_id
                 AND prod.is_deleted = false
                WHERE det.movimiento_id = movimiento.id
                  AND det.is_deleted = false
                  AND (
                    COALESCE(prod.nombre, '') ILIKE :search
                    OR COALESCE(prod.codigo, '') ILIKE :search
                  )
              )`,
              { search: `%${normalizedSearch}%` },
            );
        }),
      );
    }

    const [rows, total] = await qb
      .orderBy('movimiento.fecha_movimiento', 'DESC')
      .addOrderBy('movimiento.created_at', 'DESC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getManyAndCount();

    return {
      data: await this.hydrateMovementDocuments(rows),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      },
    };
  }

  async getMovementDocument(id: string, sucursalId?: string | null) {
    const movement = await this.movimientoRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!movement) {
      throw new NotFoundException('El documento de bodega no existe.');
    }

    const warehouses = [
      this.toText(movement.bodega_origen_id),
      this.toText(movement.bodega_destino_id),
    ].filter(Boolean);

    if (sucursalId && warehouses.length) {
      const scoped = await this.bodegaRepo.find({
        where: warehouses.map((warehouseId) => ({
          id: warehouseId,
          sucursal_id: sucursalId,
          is_deleted: false,
        })),
      });
      if (!scoped.length) {
        throw new NotFoundException('El documento de bodega no existe.');
      }
    }

    const [hydrated] = await this.hydrateMovementDocuments([movement]);
    return hydrated ?? null;
  }

  async createMovementDocument(payload: MovementDocumentPayload) {
    const tipo = this.normalizeMovementType(payload.tipo_movimiento);
    const bodegaId = this.toText(payload.bodega_id);
    const detalles = Array.isArray(payload.detalles) ? payload.detalles : [];
    const userName =
      this.toText(payload.updated_by) || this.toText(payload.created_by) || 'SYSTEM';

    if (!tipo) {
      throw new BadRequestException(
        'El tipo de movimiento debe ser INGRESO o SALIDA.',
      );
    }
    if (!bodegaId) {
      throw new BadRequestException('La bodega es obligatoria.');
    }
    if (!detalles.length) {
      throw new BadRequestException(
        'Debes agregar al menos un material al documento.',
      );
    }

    const fechaMovimiento = this.parseDateBoundary(
      this.toText(payload.fecha_movimiento),
      'start',
    ) ?? new Date();

    return this.dataSource.transaction(async (manager) => {
      const bodega = await manager.findOne(Bodega, {
        where: { id: bodegaId, is_deleted: false },
      });
      if (!bodega) {
        throw new NotFoundException('La bodega seleccionada no existe.');
      }

      const numeroDocumento = await this.generateMovementDocumentCode(
        manager,
        tipo === 'INGRESO' ? 'IB' : 'EB',
      );
      const movimiento = await manager.save(
        MovimientoInventario,
        manager.create(MovimientoInventario, {
          status: 'ACTIVE',
          tipo_movimiento: tipo,
          fecha_movimiento: fechaMovimiento,
          tipo_documento:
            tipo === 'INGRESO' ? 'INGRESO_BODEGA' : 'EGRESO_BODEGA',
          numero_documento: numeroDocumento,
          referencia: this.toText(payload.referencia) || null,
          observacion: this.toText(payload.observacion) || null,
          bodega_origen_id: tipo === 'SALIDA' ? bodega.id : null,
          bodega_destino_id: tipo === 'INGRESO' ? bodega.id : null,
          tipo_cambio: '1',
          total_costos: '0.0000',
          estado: 'CONFIRMADO',
          created_by: userName,
          updated_by: userName,
        }),
      );

      let totalCost = 0;
      const changedStockIds = new Set<string>();

      for (const detail of detalles) {
        const productoId = this.toText(detail?.producto_id);
        const cantidad = this.toNumber(detail?.cantidad, 0);
        if (!productoId) {
          throw new BadRequestException(
            'Todos los materiales del detalle deben estar seleccionados.',
          );
        }
        if (!(cantidad > 0)) {
          throw new BadRequestException(
            'La cantidad de cada material debe ser mayor a cero.',
          );
        }

        const producto = await manager.findOne(Producto, {
          where: { id: productoId, is_deleted: false },
        });
        if (!producto) {
          throw new NotFoundException('Uno de los materiales no existe.');
        }

        const stockRow = await this.getOrCreateStockRow(manager, {
          bodegaId: bodega.id,
          productoId: producto.id,
          costoPromedio: this.toNumber(
            producto.costo_promedio ?? producto.ultimo_costo,
            0,
          ),
          userName,
        });
        const stockAnterior = this.toNumber(stockRow.stock_actual, 0);
        if (tipo === 'SALIDA' && stockAnterior < cantidad) {
          throw new BadRequestException(
            `Stock insuficiente para ${producto.nombre}. Disponible ${stockAnterior.toFixed(
              2,
            )}, requerido ${cantidad.toFixed(2)}.`,
          );
        }

        const costoUnitario = this.resolveProductoUnitCost(producto, stockRow);
        const subtotal = cantidad * costoUnitario;
        const stockNuevo =
          tipo === 'INGRESO' ? stockAnterior + cantidad : stockAnterior - cantidad;

        stockRow.stock_actual = this.toFixedText(stockNuevo, 6);
        stockRow.costo_promedio_bodega = this.toFixedText(costoUnitario, 4);
        stockRow.updated_by = userName;
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);

        const movimientoDet = await manager.save(
          MovimientoInventarioDet,
          manager.create(MovimientoInventarioDet, {
            status: 'ACTIVE',
            movimiento_id: movimiento.id,
            producto_id: producto.id,
            unidad_medida_id: producto.unidad_medida_id ?? null,
            cantidad: this.toFixedText(cantidad, 6),
            costo_unitario: this.toFixedText(costoUnitario, 4),
            subtotal_costo: this.toFixedText(subtotal, 4),
            observacion: this.toText(detail?.observacion) || null,
            created_by: userName,
            updated_by: userName,
          }),
        );

        await manager.save(
          Kardex,
          manager.create(Kardex, {
            status: 'ACTIVE',
            fecha: fechaMovimiento,
            bodega_id: bodega.id,
            producto_id: producto.id,
            movimiento_id: movimiento.id,
            movimiento_det_id: movimientoDet.id,
            tipo_movimiento: tipo,
            entrada_cantidad: this.toFixedText(tipo === 'INGRESO' ? cantidad : 0, 6),
            salida_cantidad: this.toFixedText(tipo === 'SALIDA' ? cantidad : 0, 6),
            costo_unitario: this.toFixedText(costoUnitario, 4),
            costo_total: this.toFixedText(subtotal, 4),
            saldo_cantidad: this.toFixedText(stockNuevo, 6),
            saldo_costo_promedio: this.toFixedText(costoUnitario, 4),
            saldo_valorizado: this.toFixedText(stockNuevo * costoUnitario, 4),
            observacion:
              this.toText(detail?.observacion) ||
              this.toText(payload.observacion) ||
              `${tipo} de bodega`,
            created_by: userName,
            updated_by: userName,
          }),
        );

        totalCost += subtotal;
      }

      movimiento.total_costos = this.toFixedText(totalCost, 4);
      movimiento.updated_by = userName;
      await manager.save(MovimientoInventario, movimiento);

      await this.notifyMaintenanceRecalculationForStocks(
        changedStockIds,
        'document',
      );
      const [hydrated] = await this.hydrateMovementDocuments([movimiento]);
      return hydrated ?? null;
    });
  }

  private resolveSummaryRange(desde?: string | null, hasta?: string | null) {
    const now = new Date();
    const fallbackFrom = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );
    const fallbackTo = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );
    const from = this.parseDateBoundary(desde, 'start') ?? fallbackFrom;
    const to = this.parseDateBoundary(hasta, 'end') ?? fallbackTo;
    if (from > to) {
      throw new BadRequestException(
        'La fecha desde no puede ser mayor a la fecha hasta.',
      );
    }
    return { from, to };
  }

  private parseDateBoundary(
    value: string | null | undefined,
    boundary: 'start' | 'end',
  ) {
    const raw = this.toText(value);
    if (!raw) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]) - 1;
      const day = Number(match[3]);
      return boundary === 'start'
        ? new Date(year, month, day, 0, 0, 0, 0)
        : new Date(year, month, day, 23, 59, 59, 999);
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    if (boundary === 'start') {
      parsed.setHours(0, 0, 0, 0);
    } else {
      parsed.setHours(23, 59, 59, 999);
    }
    return parsed;
  }

  private formatDateOnly(value: Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async getInitialStockByProduct(
    productIds: string[],
    fromDate: Date,
    sucursalId?: string | null,
  ) {
    const out = new Map<string, number>();
    if (!productIds.length) return out;

    const qb = this.repository
      .createQueryBuilder('kardex')
      .distinctOn(['kardex.producto_id', 'kardex.bodega_id'])
      .leftJoin(
        Bodega,
        'bodega',
        'bodega.id = kardex.bodega_id AND bodega.is_deleted = false',
      )
      .where('kardex.is_deleted = false')
      .andWhere('kardex.producto_id IN (:...productIds)', { productIds })
      .andWhere('kardex.fecha < :fromDate', { fromDate });

    if (sucursalId) {
      qb.andWhere('bodega.sucursal_id = :sucursalId', { sucursalId });
    }

    const rows = await qb
      .select([
        'kardex.producto_id AS producto_id',
        'kardex.bodega_id AS bodega_id',
        'kardex.saldo_cantidad AS saldo_cantidad',
      ])
      .orderBy('kardex.producto_id', 'ASC')
      .addOrderBy('kardex.bodega_id', 'ASC')
      .addOrderBy('kardex.fecha', 'DESC')
      .addOrderBy('kardex.created_at', 'DESC')
      .getRawMany<Record<string, unknown>>();

    for (const row of rows) {
      const productId = this.toText(row.producto_id);
      if (!productId) continue;
      out.set(productId, (out.get(productId) ?? 0) + this.toNumber(row.saldo_cantidad, 0));
    }
    return out;
  }

  private async hydrateMovementDocuments(rows: MovimientoInventario[]) {
    if (!rows.length) return [];

    const movementIds = rows.map((item) => item.id);
    const warehouseIds = [
      ...new Set(
        rows
          .flatMap((item) => [item.bodega_origen_id, item.bodega_destino_id])
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    const [details, warehouses] = await Promise.all([
      this.movimientoDetRepo.find({
        where: movementIds.map((movimientoId) => ({
          movimiento_id: movimientoId,
          is_deleted: false,
        })),
        order: { created_at: 'ASC' },
      }),
      warehouseIds.length
        ? this.bodegaRepo.find({
            where: warehouseIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as Bodega[]),
    ]);

    const productIds = [...new Set(details.map((item) => item.producto_id).filter(Boolean))];
    const unitIds = [
      ...new Set(
        details
          .map((item) => item.unidad_medida_id)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const [products, units] = await Promise.all([
      productIds.length
        ? this.productoRepo.find({
            where: productIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as Producto[]),
      unitIds.length
        ? this.unidadRepo.find({
            where: unitIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as UnidadMedida[]),
    ]);

    const detailMap = details.reduce((acc, item) => {
      (acc[item.movimiento_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, MovimientoInventarioDet[]>);
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const productMap = new Map(products.map((item) => [item.id, item]));
    const unitMap = new Map(units.map((item) => [item.id, item]));

    return rows.map((item) => {
      const sourceWarehouse = item.bodega_origen_id
        ? warehouseMap.get(item.bodega_origen_id)
        : null;
      const destinationWarehouse = item.bodega_destino_id
        ? warehouseMap.get(item.bodega_destino_id)
        : null;
      const detailRows = (detailMap[item.id] ?? []).map((detail) => {
        const product = productMap.get(detail.producto_id);
        const unit = detail.unidad_medida_id
          ? unitMap.get(detail.unidad_medida_id)
          : null;
        return {
          id: detail.id,
          producto_id: detail.producto_id,
          producto_codigo: this.toText(product?.codigo),
          producto_nombre: this.toText(product?.nombre),
          unidad_label: this.toText(unit?.nombre),
          cantidad: this.toNumber(detail.cantidad, 0),
          costo_unitario: this.toNumber(detail.costo_unitario, 0),
          subtotal_costo: this.toNumber(detail.subtotal_costo, 0),
          observacion: this.toText(detail.observacion) || null,
        };
      });
      return {
        ...item,
        tipo_documento_label: this.resolveDocumentTypeLabel(item),
        bodega_label: this.resolveDocumentWarehouseLabel(
          item,
          sourceWarehouse,
          destinationWarehouse,
        ),
        total_items: detailRows.length,
        total_cantidad: detailRows.reduce(
          (sum, detail) => sum + this.toNumber(detail.cantidad, 0),
          0,
        ),
        detalles: detailRows,
      };
    });
  }

  private resolveDocumentTypeLabel(item: MovimientoInventario) {
    const documentNumber = this.toText(item.numero_documento).toUpperCase();
    if (documentNumber.startsWith('IB-')) return 'Ingreso de bodega';
    if (documentNumber.startsWith('EB-')) return 'Egreso de bodega';
    if (String(item.tipo_movimiento || '').toUpperCase() === 'INGRESO') {
      return 'Ingreso de bodega';
    }
    if (String(item.tipo_movimiento || '').toUpperCase() === 'SALIDA') {
      return 'Egreso de bodega';
    }
    return 'Documento de bodega';
  }

  private resolveDocumentWarehouseLabel(
    item: MovimientoInventario,
    sourceWarehouse?: Bodega | null,
    destinationWarehouse?: Bodega | null,
  ) {
    const target =
      String(item.tipo_movimiento || '').toUpperCase() === 'INGRESO'
        ? destinationWarehouse
        : sourceWarehouse;
    if (!target) return 'Sin bodega';
    return [this.toText(target.codigo), this.toText(target.nombre)]
      .filter(Boolean)
      .join(' - ');
  }

  private async generateMovementDocumentCode(
    manager: EntityManager,
    prefix: 'IB' | 'EB',
  ) {
    const movementRows = await manager.find(MovimientoInventario, {
      where: { is_deleted: false },
      select: { numero_documento: true } as any,
      take: 500,
      order: { created_at: 'DESC' } as any,
    });
    const orderRows =
      prefix === 'IB'
        ? await manager.find(OrdenCompra, {
            where: { is_deleted: false },
            select: { referencia: true } as any,
            take: 500,
            order: { created_at: 'DESC' } as any,
          })
        : [];
    const values = [
      ...movementRows.map((item: any) => this.toText(item?.numero_documento)),
      ...orderRows.map((item: any) => this.toText(item?.referencia)),
    ];
    const maxNumber = values.reduce((max, current) => {
      const match = new RegExp(`^${prefix}-(\\d{8})$`, 'i').exec(current);
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);
    return `${prefix}-${String(maxNumber + 1).padStart(8, '0')}`;
  }

  private resolveDocumentCode(row: Record<string, unknown>) {
    const directDocument = this.toText(row.movimiento_numero_documento);
    if (directDocument) return directDocument;
    const tipo = this.normalizeMovementType(row.tipo_movimiento);
    if (tipo === 'INGRESO') return 'IB-SIN CODIGO';
    if (tipo === 'SALIDA') return 'EB-SIN CODIGO';
    return 'SIN CODIGO';
  }

  private resolveMovementConcept(row: Record<string, unknown>) {
    const tipoDocumento = this.toText(row.movimiento_tipo_documento).toUpperCase();
    const tipo = this.normalizeMovementType(row.tipo_movimiento);
    const referencia = this.toText(row.movimiento_referencia).toUpperCase();
    if (tipoDocumento === 'INGRESO_BODEGA') {
      if (referencia.startsWith('TB-')) return 'IN-TRANSFERENCIAS';
      if (referencia.startsWith('OC-') || referencia.startsWith('IB-')) {
        return 'IN-BODEGA';
      }
      return 'IN-BODEGA';
    }
    if (tipoDocumento === 'EGRESO_BODEGA') {
      if (referencia.startsWith('TB-')) return 'EG-TRANSFERENCIAS';
      return 'EG-BODEGA';
    }
    if (tipoDocumento === 'TRANSFERENCIA_BODEGA') {
      return tipo === 'INGRESO' ? 'IN-TRANSFERENCIAS' : 'EG-TRANSFERENCIAS';
    }
    if (tipoDocumento === 'ORDEN_COMPRA') {
      return 'IN-ORDEN_COMPRA';
    }
    if (tipo === 'INGRESO') return 'IN-MANUAL';
    if (tipo === 'SALIDA') return 'EG-MANUAL';
    return 'MOVIMIENTO';
  }

  async registerManualMovement(payload: ManualMovementPayload) {
    return this.createMovementDocument({
      tipo_movimiento: payload.tipo_movimiento,
      bodega_id: payload.bodega_id,
      observacion: payload.observacion,
      created_by: payload.created_by,
      updated_by: payload.updated_by,
      detalles: [
        {
          producto_id: payload.producto_id,
          cantidad: payload.cantidad,
          observacion: payload.observacion,
        },
      ],
    });
  }

  async importInventoryWorkbook(
    buffer: Buffer,
    options?: {
      requestedBy?: string | null;
      originalName?: string | null;
      mimeType?: string | null;
      onProgress?: (progress: InventoryImportProgress) => Promise<void> | void;
    },
  ) {
    const workbook = this.readInventoryWorkbook(buffer, options);
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new BadRequestException(
        'El archivo no contiene hojas válidas para importar.',
      );
    }

    const sheet = workbook.Sheets[firstSheetName];
    if (!sheet) {
      throw new BadRequestException('No se pudo leer la hoja principal del Excel.');
    }

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
    });

    if (!rows.length) {
      throw new BadRequestException('El archivo no contiene filas de datos.');
    }

    const summary: ImportInventorySummary = {
      procesados: 0,
      omitidos: 0,
      creados: 0,
      actualizados: 0,
      ingresos: 0,
      salidas: 0,
      errores: [],
    };

    const userName = this.toText(options?.requestedBy) || 'SYSTEM';
    const changedStockIds = new Set<string>();

    await options?.onProgress?.({
      currentIndex: 0,
      totalRows: rows.length,
      currentStep: `Preparando ${rows.length} fila(s) para importar.`,
    });

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];

      try {
        const processed = await this.importInventoryRowNormalized(
          row,
          userName,
          summary,
          changedStockIds,
        );
        if (processed) summary.procesados += 1;
        else summary.omitidos += 1;
      } catch (error: any) {
        summary.errores.push(
          `Fila ${index + 2}: ${error?.message ?? 'No se pudo importar.'}`,
        );
      }

      await options?.onProgress?.({
        currentIndex: index + 1,
        totalRows: rows.length,
        currentStep: `Procesando fila ${index + 2} de ${rows.length + 1}.`,
      });
    }

    await this.notifyMaintenanceRecalculationForStocks(changedStockIds, 'import');

    return {
      ...summary,
      hoja: firstSheetName,
      total_filas: rows.length,
    };
  }

  async startInventoryImport(
    file: {
      buffer?: Buffer;
      originalname?: string | null;
      mimetype?: string | null;
    },
    options?: {
      requestedBy?: string | null;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        'Debes adjuntar un archivo CSV o Excel válido.',
      );
    }

    const jobId = randomUUID();
    const sourceFileName =
      this.toText(file.originalname) || `inventario-${jobId}.csv`;
    const storedFileName = sourceFileName.replace(/[\\/:*?"<>|]+/g, '_');
    const targetDir = join(this.importRoot, jobId);
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, storedFileName), file.buffer);

    const job: InventoryImportJobState = {
      id: jobId,
      status: 'QUEUED',
      progress: 0,
      source_file_name: sourceFileName,
      stored_file_name: storedFileName,
      requested_by: this.toText(options?.requestedBy) || 'SYSTEM',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      current_step: 'Archivo recibido. Esperando procesamiento.',
      current_index: 0,
      total_rows: 0,
      summary: null,
      error_message: null,
    };

    this.importJobs.set(jobId, job);
    void this.notifyMaintenanceImportLifecycle('started', jobId);

    setImmediate(() => {
      void this.runInventoryImportJob(jobId, file.buffer!, {
        requestedBy: options?.requestedBy,
        originalName: file.originalname,
        mimeType: file.mimetype,
      });
    });

    return job;
  }

  getInventoryImportJob(jobId: string) {
    const job = this.importJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('La carga de inventario solicitada no existe.');
    }
    return job;
  }

  getActiveInventoryImportSummary() {
    const activeJobs = [...this.importJobs.values()]
      .filter((job) => ['QUEUED', 'PROCESSING'].includes(job.status))
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

    return {
      active: activeJobs.length > 0,
      total_jobs: activeJobs.length,
      jobs: activeJobs.map((job) => ({
        id: job.id,
        status: job.status,
        progress: job.progress,
        source_file_name: job.source_file_name,
        requested_by: job.requested_by,
        created_at: job.created_at,
        started_at: job.started_at,
        current_step: job.current_step,
        current_index: job.current_index,
        total_rows: job.total_rows,
      })),
    };
  }

  getImportTemplateBuffer() {
    const headers = [
      'Cod. Sucursal',
      'Sucursal',
      'Cod. Bodega',
      'Bodega',
      'Cod. Línea',
      'Linea',
      'Tipo',
      'Categoria',
      'Reg. Sanitario',
      'Marca',
      'Cod. Item',
      'Item',
      'Sección',
      'Nivel',
      'Último costo',
      'Costo promedio',
      'Precio',
      '% UTILIDAD',
      '% TC',
      'VALOR TC',
      'Tipo de unidad',
      'Por contenedores',
      'Stock',
      'Stock min. bodega',
      'Stock max. bodega',
      'Stock contenedores',
      'Stock minimo',
    ];

    const sample = {
      'Cod. Sucursal': 'SUC-001',
      Sucursal: 'Matriz',
      'Cod. Bodega': 'BOD-001',
      Bodega: 'Bodega Principal',
      'Cod. Línea': 'SUM',
      Linea: 'MANTENIMIENTO',
      Tipo: 'Mercadería',
      Categoria: 'HERRAMIENTAS',
      'Reg. Sanitario': '',
      Marca: 'GULF',
      'Cod. Item': '175',
      Item: 'PROBADOR DE TIERRA DIGITAL',
      'Sección': 'MATERIAL VARIOS',
      Nivel: '',
      'Último costo': 25.5,
      'Costo promedio': 25.5,
      Precio: 35,
      '% UTILIDAD': 37.25,
      '% TC': 0,
      'VALOR TC': 0,
      'Tipo de unidad': 'UNIDAD',
      'Por contenedores': 'N',
      Stock: 80,
      'Stock min. bodega': 5,
      'Stock max. bodega': 10000,
      'Stock contenedores': 0,
      'Stock minimo': 5,
      Costo: 2040,
    };

    const worksheet = XLSX.utils.json_to_sheet([sample], {
      header: headers,
      skipHeader: false,
    });

    worksheet['!cols'] = headers.map((header) => ({
      wch: Math.max(header.length + 2, 18),
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'INVENTARIO');

    return XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
  }

  private normalizeMovementType(value: unknown): MovementType | null {
    const raw = this.toText(value).toUpperCase();
    if (raw === 'INGRESO') return 'INGRESO';
    if (raw === 'SALIDA') return 'SALIDA';
    return null;
  }

  private toNumber(value: unknown, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    const normalizedText = this.toText(value).replace(/\s+/g, '');
    if (!normalizedText) return fallback;

    const hasComma = normalizedText.includes(',');
    const hasDot = normalizedText.includes('.');
    let raw = normalizedText;

    if (hasComma && hasDot) {
      const lastComma = normalizedText.lastIndexOf(',');
      const lastDot = normalizedText.lastIndexOf('.');
      raw =
        lastComma > lastDot
          ? normalizedText.replace(/\./g, '').replace(/,/g, '.')
          : normalizedText.replace(/,/g, '');
    } else if (hasComma) {
      raw = normalizedText.replace(/,/g, '.');
    }

    raw = raw.replace(/[^0-9.-]/g, '');
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private toText(value: unknown) {
    return this.repairText(String(value ?? ''));
  }

  private toFixedText(value: number, decimals: number) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '0';
  }

  private resolveProductoUnitCost(producto: Producto, stock?: StockBodega | null) {
    const productCost = this.toNumber(
      producto.costo_promedio ?? producto.ultimo_costo,
      0,
    );
    if (productCost > 0) return productCost;

    const stockCost = this.toNumber(stock?.costo_promedio_bodega, 0);
    if (stockCost > 0) return stockCost;

    return 0;
  }

  private normalizeHeader(value: string) {
    return this.repairText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private rowValue(row: Record<string, unknown>, headers: string[]) {
    const keys = Object.keys(row);
    for (const header of headers) {
      const match = keys.find(
        (key) => this.normalizeHeader(key) === this.normalizeHeader(header),
      );
      if (match) return row[match];
    }
    return null;
  }

  private buildCodeFromLabel(value: string, prefix: string) {
    const normalized = this.repairText(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const compact = normalized.slice(0, 24) || 'GENERAL';
    return `${prefix}_${compact}`;
  }

  private mojibakeScore(value: string) {
    if (!value) return 0;
    const matches = value.match(/Ã.|Â.|â.|�/g);
    return matches?.length ?? 0;
  }

  private repairText(value: string) {
    let text = String(value ?? '').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
    if (!text) return '';

    const candidates = [text];
    try {
      candidates.push(Buffer.from(text, 'latin1').toString('utf8').trim());
    } catch {
      /* noop */
    }

    const best = candidates
      .filter(Boolean)
      .sort((a, b) => this.mojibakeScore(a) - this.mojibakeScore(b))[0];

    return String(best || text).trim();
  }

  private decodeDelimitedText(buffer: Buffer) {
    const utf8 = this.repairText(buffer.toString('utf8'));
    const latin1 = this.repairText(buffer.toString('latin1'));
    return this.mojibakeScore(utf8) <= this.mojibakeScore(latin1)
      ? utf8
      : latin1;
  }

  private readInventoryWorkbook(
    buffer: Buffer,
    options?: { originalName?: string | null; mimeType?: string | null },
  ) {
    const originalName = this.toText(options?.originalName).toLowerCase();
    const mimeType = this.toText(options?.mimeType).toLowerCase();
    const isCsv =
      originalName.endsWith('.csv') ||
      mimeType.includes('csv') ||
      mimeType.includes('text/plain');

    if (isCsv) {
      const csvText = this.decodeDelimitedText(buffer);
      return XLSX.read(csvText, {
        type: 'string',
        raw: false,
      });
    }

    return XLSX.read(buffer, { type: 'buffer', raw: false });
  }

  private resolveInventoryUnitCost(args: {
    costoPromedio: number;
    ultimoCosto: number;
    costoTotal: number;
    stockObjetivo: number;
  }) {
    if (args.costoPromedio > 0) return args.costoPromedio;
    if (args.ultimoCosto > 0) return args.ultimoCosto;
    if (args.costoTotal > 0 && args.stockObjetivo > 0) {
      return args.costoTotal / args.stockObjetivo;
    }
    return 0;
  }

  private async runInventoryImportJob(
    jobId: string,
    buffer: Buffer,
    options?: {
      requestedBy?: string | null;
      originalName?: string | null;
      mimeType?: string | null;
    },
  ) {
    const job = this.importJobs.get(jobId);
    if (!job) return;

    job.status = 'PROCESSING';
    job.progress = 5;
    job.started_at = new Date().toISOString();
    job.current_step = 'Leyendo archivo y preparando importación.';
    job.error_message = null;

    try {
      const summary = await this.importInventoryWorkbook(buffer, {
        ...options,
        onProgress: async ({ currentIndex, totalRows, currentStep }) => {
          const currentJob = this.importJobs.get(jobId);
          if (!currentJob) return;
          currentJob.current_index = currentIndex;
          currentJob.total_rows = totalRows;
          currentJob.current_step = currentStep;
          const completion =
            totalRows > 0 ? Math.round((currentIndex / totalRows) * 90) : 0;
          currentJob.progress = Math.min(95, Math.max(10, completion));
        },
      });

      job.status = 'COMPLETED';
      job.progress = 100;
      job.finished_at = new Date().toISOString();
      job.current_step = 'Importación finalizada correctamente.';
      job.summary = summary;
      job.current_index = summary.total_filas;
      job.total_rows = summary.total_filas;
      job.error_message = null;
      this.logger.log(
        `Carga de inventario completada. Job=${jobId} Archivo=${job.source_file_name} Procesados=${summary.procesados} Errores=${summary.errores.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = 'FAILED';
      job.progress = 100;
      job.finished_at = new Date().toISOString();
      job.current_step = 'La importación finalizó con error.';
      job.error_message = message;
      this.logger.error(
        `Carga de inventario fallida. Job=${jobId} Archivo=${job.source_file_name}: ${message}`,
      );
      await this.notifyMaintenanceImportLifecycle('failed', jobId);
    }
  }

  private async getOrCreateStockRow(
    manager: EntityManager,
    args: {
      bodegaId: string;
      productoId: string;
      costoPromedio: number;
      userName: string;
    },
  ) {
    const existing = await manager.findOne(StockBodega, {
      where: {
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        is_deleted: false,
      },
    });

    if (existing) return existing;

    return manager.save(
      StockBodega,
      manager.create(StockBodega, {
        status: 'ACTIVE',
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        stock_actual: '0.000000',
        stock_min_bodega: '0.000000',
        stock_max_bodega: '0.000000',
        stock_min_global: '0.000000',
        stock_contenedores: '0.000000',
        costo_promedio_bodega: this.toFixedText(args.costoPromedio, 4),
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );
  }

  private async createMovementArtifacts(
    manager: EntityManager,
    args: {
      tipo: MovementType;
      bodegaId: string;
      productoId: string;
      cantidad: number;
      costoUnitario: number;
      stockNuevo: number;
      observacion: string;
      userName: string;
    },
  ) {
    const subtotal = args.cantidad * args.costoUnitario;
    const now = new Date();
    const numeroDocumento = await this.generateMovementDocumentCode(
      manager,
      args.tipo === 'INGRESO' ? 'IB' : 'EB',
    );

    const movimiento = await manager.save(
      MovimientoInventario,
      manager.create(MovimientoInventario, {
        status: 'ACTIVE',
        tipo_movimiento: args.tipo,
        fecha_movimiento: now,
        tipo_documento:
          args.tipo === 'INGRESO' ? 'INGRESO_BODEGA' : 'EGRESO_BODEGA',
        numero_documento: numeroDocumento,
        tipo_cambio: '1',
        total_costos: this.toFixedText(subtotal, 4),
        estado: 'CONFIRMADO',
        observacion: args.observacion,
        bodega_origen_id: args.tipo === 'SALIDA' ? args.bodegaId : null,
        bodega_destino_id: args.tipo === 'INGRESO' ? args.bodegaId : null,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    const detalle = await manager.save(
      MovimientoInventarioDet,
      manager.create(MovimientoInventarioDet, {
        status: 'ACTIVE',
        movimiento_id: movimiento.id,
        producto_id: args.productoId,
        cantidad: this.toFixedText(args.cantidad, 6),
        costo_unitario: this.toFixedText(args.costoUnitario, 4),
        subtotal_costo: this.toFixedText(subtotal, 4),
        observacion: args.observacion,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    const kardex = await manager.save(
      Kardex,
      manager.create(Kardex, {
        status: 'ACTIVE',
        fecha: now,
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        movimiento_id: movimiento.id,
        movimiento_det_id: detalle.id,
        tipo_movimiento: args.tipo,
        entrada_cantidad: this.toFixedText(
          args.tipo === 'INGRESO' ? args.cantidad : 0,
          6,
        ),
        salida_cantidad: this.toFixedText(
          args.tipo === 'SALIDA' ? args.cantidad : 0,
          6,
        ),
        costo_unitario: this.toFixedText(args.costoUnitario, 4),
        costo_total: this.toFixedText(subtotal, 4),
        saldo_cantidad: this.toFixedText(args.stockNuevo, 6),
        saldo_costo_promedio: this.toFixedText(args.costoUnitario, 4),
        saldo_valorizado: this.toFixedText(
          args.stockNuevo * args.costoUnitario,
          4,
        ),
        observacion: args.observacion,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    return { movimiento, detalle, kardex };
  }

  private async importInventoryRow(
    row: Record<string, unknown>,
    userName: string,
    summary: ImportInventorySummary,
    changedStockIds: Set<string>,
  ) {
    const codSucursal = this.toText(this.rowValue(row, ['Cod. Sucursal']));
    const nomSucursal = this.toText(this.rowValue(row, ['Sucursal']));
    const codBodega = this.toText(this.rowValue(row, ['Cod. Bodega']));
    const nomBodega = this.toText(this.rowValue(row, ['Bodega']));
    const nomLinea = this.toText(this.rowValue(row, ['Linea']));
    const nomCategoria = this.toText(this.rowValue(row, ['Categoria']));
    const codItem = this.toText(this.rowValue(row, ['Cod. Item'])).replace(
      /^'+/,
      '',
    );
    const nomItem = this.toText(this.rowValue(row, ['Item']));
    const costoPromedio = this.toNumber(
      this.rowValue(row, ['Costo promedio', 'Costo']),
      0,
    );
    const precio = this.toNumber(this.rowValue(row, ['Precio']), 0);
    const utilidad = this.toNumber(
      this.rowValue(row, ['% UTILIDAD', '% utilidad', 'Utilidad']),
      0,
    );
    const tipoUnidad = this.toText(this.rowValue(row, ['Tipo de unidad']));
    const porContenedoresRaw = this.toText(
      this.rowValue(row, ['Por contenedores']),
    ).toUpperCase();
    const stockObjetivo = this.toNumber(this.rowValue(row, ['Stock']), 0);
    const stockMinBodega = this.toNumber(
      this.rowValue(row, ['Stock min. bodega', 'Stock min bodega']),
      0,
    );
    const stockMaxBodega = this.toNumber(
      this.rowValue(row, ['Stock max. bodega', 'Stock max bodega']),
      0,
    );
    const stockContenedores = this.toNumber(
      this.rowValue(row, ['Stock contenedores']),
      0,
    );
    const stockMinimo = this.toNumber(
      this.rowValue(row, ['Stock minimo', 'Stock mínimo']),
      0,
    );

    if (!codSucursal || !codBodega || !codItem || !nomItem) {
      return false;
    }

    const porContenedores = ['S', 'SI', 'TRUE', '1'].includes(
      porContenedoresRaw,
    );

    const result = await this.dataSource.transaction(async (manager) => {
      let sucursal = await manager.findOne(Sucursal, {
        where: { codigo: codSucursal, is_deleted: false },
      });
      if (!sucursal) {
        sucursal = await manager.save(
          Sucursal,
          manager.create(Sucursal, {
            status: 'ACTIVE',
            codigo: codSucursal,
            nombre: nomSucursal || codSucursal,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let bodega = await manager.findOne(Bodega, {
        where: {
          codigo: codBodega,
          sucursal_id: sucursal.id,
          is_deleted: false,
        },
      });
      if (!bodega) {
        bodega = await manager.save(
          Bodega,
          manager.create(Bodega, {
            status: 'ACTIVE',
            sucursal_id: sucursal.id,
            codigo: codBodega,
            nombre: nomBodega || codBodega,
            es_principal: false,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const lineaNombre = nomLinea || 'GENERAL';
      const lineaCodigo = this.buildCodeFromLabel(lineaNombre, 'LIN');
      let linea = await manager.findOne(Linea, {
        where: [{ codigo: lineaCodigo, is_deleted: false }, { nombre: lineaNombre, is_deleted: false }],
      });
      if (!linea) {
        linea = await manager.save(
          Linea,
          manager.create(Linea, {
            status: 'ACTIVE',
            codigo: lineaCodigo,
            nombre: lineaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const categoriaNombre = nomCategoria || 'GENERAL';
      const categoriaCodigo = this.buildCodeFromLabel(categoriaNombre, 'CAT');
      let categoria = await manager.findOne(Categoria, {
        where: [
          { codigo: categoriaCodigo, is_deleted: false },
          { nombre: categoriaNombre, is_deleted: false },
        ],
      });
      if (!categoria) {
        categoria = await manager.save(
          Categoria,
          manager.create(Categoria, {
            status: 'ACTIVE',
            codigo: categoriaCodigo,
            nombre: categoriaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const unidadNombre = tipoUnidad || 'UNIDAD';
      const unidadCodigo = this.buildCodeFromLabel(unidadNombre, 'UM');
      let unidad = await manager.findOne(UnidadMedida, {
        where: [
          { codigo: unidadCodigo, is_deleted: false },
          { nombre: unidadNombre, is_deleted: false },
        ],
      });
      if (!unidad) {
        unidad = await manager.save(
          UnidadMedida,
          manager.create(UnidadMedida, {
            status: 'ACTIVE',
            codigo: unidadCodigo,
            nombre: unidadNombre,
            es_base: true,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let producto = await manager.findOne(Producto, {
        where: { codigo: codItem, is_deleted: false },
      });
      if (!producto) {
        producto = await manager.save(
          Producto,
          manager.create(Producto, {
            status: 'ACTIVE',
            codigo: codItem,
            nombre: nomItem,
            linea_id: linea.id,
            categoria_id: categoria.id,
            unidad_medida_id: unidad.id,
            por_contenedores: porContenedores,
            es_servicio: false,
            requiere_lote: false,
            requiere_serie: false,
            ultimo_costo: this.toFixedText(costoPromedio, 4),
            costo_promedio: this.toFixedText(costoPromedio, 4),
            precio_venta: this.toFixedText(precio, 4),
            porcentaje_utilidad: this.toFixedText(utilidad, 4),
            created_by: userName,
            updated_by: userName,
          }),
        );
        summary.creados += 1;
      } else {
        producto.nombre = nomItem;
        producto.linea_id = linea.id;
        producto.categoria_id = categoria.id;
        producto.unidad_medida_id = unidad.id;
        producto.por_contenedores = porContenedores;
        producto.ultimo_costo = this.toFixedText(costoPromedio, 4);
        producto.costo_promedio = this.toFixedText(costoPromedio, 4);
        producto.precio_venta = this.toFixedText(precio, 4);
        producto.porcentaje_utilidad = this.toFixedText(utilidad, 4);
        producto.updated_by = userName;
        await manager.save(Producto, producto);
        summary.actualizados += 1;
      }

      const stockRow = await this.getOrCreateStockRow(manager, {
        bodegaId: bodega.id,
        productoId: producto.id,
        costoPromedio,
        userName,
      });
      const stockAnterior = this.toNumber(stockRow.stock_actual, 0);
      const delta = stockObjetivo - stockAnterior;

      stockRow.stock_min_bodega = this.toFixedText(stockMinBodega, 6);
      stockRow.stock_max_bodega = this.toFixedText(stockMaxBodega, 6);
      stockRow.stock_min_global = this.toFixedText(stockMinimo, 6);
      stockRow.stock_contenedores = this.toFixedText(stockContenedores, 6);
      stockRow.costo_promedio_bodega = this.toFixedText(costoPromedio, 4);
      stockRow.updated_by = userName;

      if (delta !== 0) {
        const tipo = delta > 0 ? 'INGRESO' : 'SALIDA';
        const stockNuevo = stockAnterior + delta;
        stockRow.stock_actual = this.toFixedText(stockNuevo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);

        await this.createMovementArtifacts(manager, {
          tipo,
          bodegaId: bodega.id,
          productoId: producto.id,
          cantidad: Math.abs(delta),
          costoUnitario: costoPromedio,
          stockNuevo,
          observacion: 'Ajuste por carga masiva XLSX',
          userName,
        });

        if (delta > 0) summary.ingresos += 1;
        else summary.salidas += 1;
      } else {
        stockRow.stock_actual = this.toFixedText(stockObjetivo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);
      }

      return true;
    });

    return result;
  }

  private async importInventoryRowNormalized(
    row: Record<string, unknown>,
    userName: string,
    summary: ImportInventorySummary,
    changedStockIds: Set<string>,
  ) {
    const codSucursal = this.toText(this.rowValue(row, ['Cod. Sucursal']));
    const nomSucursal = this.toText(this.rowValue(row, ['Sucursal']));
    const codBodega = this.toText(this.rowValue(row, ['Cod. Bodega']));
    const nomBodega = this.toText(this.rowValue(row, ['Bodega']));
    const codLinea = this.toText(
      this.rowValue(row, ['Cod. Línea', 'Cod. Linea']),
    );
    const nomLinea = this.toText(this.rowValue(row, ['Línea', 'Linea']));
    const tipoProducto = this.toText(this.rowValue(row, ['Tipo']));
    const nomCategoria = this.toText(
      this.rowValue(row, ['Categoría', 'Categoria']),
    );
    const registroSanitario = this.toText(
      this.rowValue(row, [
        'Reg. Sanitario',
        'Reg Sanitario',
        'Registro sanitario',
      ]),
    );
    const marcaNombre = this.toText(this.rowValue(row, ['Marca']));
    const codItem = this.toText(
      this.rowValue(row, ['Cod. Ítem', 'Cod. Item']),
    ).replace(/^['"]+/, '');
    const nomItem = this.toText(this.rowValue(row, ['Ítem', 'Item']));
    const seccion = this.toText(this.rowValue(row, ['Sección', 'Seccion']));
    const nivel = this.toText(this.rowValue(row, ['Nivel']));
    const ultimoCosto = this.toNumber(
      this.rowValue(row, ['Último costo', 'Ultimo costo']),
      0,
    );
    const costoPromedioOrigen = this.toNumber(
      this.rowValue(row, ['Costo promedio']),
      0,
    );
    const costoTotal = this.toNumber(this.rowValue(row, ['Costo']), 0);
    const precio = this.toNumber(this.rowValue(row, ['Precio']), 0);
    const utilidad = this.toNumber(
      this.rowValue(row, ['% UTILIDAD', '% utilidad', 'Utilidad']),
      0,
    );
    const tipoUnidad = this.toText(this.rowValue(row, ['Tipo de unidad']));
    const porContenedoresRaw = this.toText(
      this.rowValue(row, ['Por contenedores']),
    ).toUpperCase();
    const stockObjetivo = this.toNumber(this.rowValue(row, ['Stock']), 0);
    const stockMinBodega = this.toNumber(
      this.rowValue(row, ['Stock min. bodega', 'Stock min bodega']),
      0,
    );
    const stockMaxBodega = this.toNumber(
      this.rowValue(row, ['Stock max. bodega', 'Stock max bodega']),
      0,
    );
    const stockContenedores = this.toNumber(
      this.rowValue(row, ['Stock contenedores']),
      0,
    );
    const stockMinimo = this.toNumber(
      this.rowValue(row, ['Stock minimo', 'Stock mínimo']),
      0,
    );

    if (!codSucursal || !codBodega || !codItem || !nomItem) {
      return false;
    }

    const porContenedores = ['S', 'SI', 'TRUE', '1'].includes(
      porContenedoresRaw,
    );
    const descripcion =
      [tipoProducto, seccion, nivel].filter(Boolean).join(' / ') || null;
    const costoUnitario = this.resolveInventoryUnitCost({
      costoPromedio: costoPromedioOrigen,
      ultimoCosto,
      costoTotal,
      stockObjetivo,
    });
    const normalizedStockMinGlobal = stockMinimo > 0 ? stockMinimo : 2;
    const normalizedStockMinBodega =
      stockMinBodega > 0 ? stockMinBodega : normalizedStockMinGlobal;
    const normalizedStockMaxBodega =
      stockMaxBodega > 0 ? stockMaxBodega : 10000;

    return this.dataSource.transaction(async (manager) => {
      let sucursal = await manager.findOne(Sucursal, {
        where: { codigo: codSucursal, is_deleted: false },
      });
      if (!sucursal) {
        sucursal = await manager.save(
          Sucursal,
          manager.create(Sucursal, {
            status: 'ACTIVE',
            codigo: codSucursal,
            nombre: nomSucursal || codSucursal,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let bodega = await manager.findOne(Bodega, {
        where: {
          codigo: codBodega,
          sucursal_id: sucursal.id,
          is_deleted: false,
        },
      });
      if (!bodega) {
        bodega = await manager.save(
          Bodega,
          manager.create(Bodega, {
            status: 'ACTIVE',
            sucursal_id: sucursal.id,
            codigo: codBodega,
            nombre: nomBodega || codBodega,
            es_principal: false,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const lineaNombre = nomLinea || 'GENERAL';
      const lineaCodigo = codLinea || this.buildCodeFromLabel(lineaNombre, 'LIN');
      let linea = await manager.findOne(Linea, {
        where: [
          { codigo: lineaCodigo, is_deleted: false },
          { nombre: lineaNombre, is_deleted: false },
        ],
      });
      if (!linea) {
        linea = await manager.save(
          Linea,
          manager.create(Linea, {
            status: 'ACTIVE',
            codigo: lineaCodigo,
            nombre: lineaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      const categoriaNombre = nomCategoria || 'GENERAL';
      const categoriaCodigo = this.buildCodeFromLabel(categoriaNombre, 'CAT');
      let categoria = await manager.findOne(Categoria, {
        where: [
          { codigo: categoriaCodigo, is_deleted: false },
          { nombre: categoriaNombre, is_deleted: false },
        ],
      });
      if (!categoria) {
        categoria = await manager.save(
          Categoria,
          manager.create(Categoria, {
            status: 'ACTIVE',
            codigo: categoriaCodigo,
            nombre: categoriaNombre,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let marca: Marca | null = null;
      if (marcaNombre) {
        marca =
          (await manager.findOne(Marca, {
            where: { nombre: marcaNombre, is_deleted: false },
          })) ?? null;
        if (!marca) {
          marca = await manager.save(
            Marca,
            manager.create(Marca, {
              status: 'ACTIVE',
              nombre: marcaNombre,
              created_by: userName,
              updated_by: userName,
            }),
          );
        }
      }

      const unidadNombre = tipoUnidad || 'UNIDAD';
      const unidadCodigo = this.buildCodeFromLabel(unidadNombre, 'UM');
      let unidad = await manager.findOne(UnidadMedida, {
        where: [
          { codigo: unidadCodigo, is_deleted: false },
          { nombre: unidadNombre, is_deleted: false },
        ],
      });
      if (!unidad) {
        unidad = await manager.save(
          UnidadMedida,
          manager.create(UnidadMedida, {
            status: 'ACTIVE',
            codigo: unidadCodigo,
            nombre: unidadNombre,
            es_base: true,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      let producto = await manager.findOne(Producto, {
        where: { codigo: codItem, is_deleted: false },
      });
      if (!producto) {
        producto = await manager.save(
          Producto,
          manager.create(Producto, {
            status: 'ACTIVE',
            codigo: codItem,
            nombre: nomItem,
            descripcion,
            linea_id: linea.id,
            categoria_id: categoria.id,
            marca_id: marca?.id ?? null,
            registro_sanitario: registroSanitario || null,
            unidad_medida_id: unidad.id,
            por_contenedores: porContenedores,
            es_servicio: false,
            requiere_lote: false,
            requiere_serie: false,
            ultimo_costo: this.toFixedText(ultimoCosto || costoUnitario, 4),
            costo_promedio: this.toFixedText(costoUnitario, 4),
            precio_venta: this.toFixedText(precio, 4),
            porcentaje_utilidad: this.toFixedText(utilidad, 4),
            created_by: userName,
            updated_by: userName,
          }),
        );
        summary.creados += 1;
      } else {
        producto.nombre = nomItem;
        producto.descripcion = descripcion ?? producto.descripcion ?? null;
        producto.linea_id = linea.id;
        producto.categoria_id = categoria.id;
        producto.marca_id = marca?.id ?? null;
        producto.registro_sanitario = registroSanitario || null;
        producto.unidad_medida_id = unidad.id;
        producto.por_contenedores = porContenedores;
        producto.ultimo_costo = this.toFixedText(ultimoCosto || costoUnitario, 4);
        producto.costo_promedio = this.toFixedText(costoUnitario, 4);
        producto.precio_venta = this.toFixedText(precio, 4);
        producto.porcentaje_utilidad = this.toFixedText(utilidad, 4);
        producto.updated_by = userName;
        await manager.save(Producto, producto);
        summary.actualizados += 1;
      }

      const stockRow = await this.getOrCreateStockRow(manager, {
        bodegaId: bodega.id,
        productoId: producto.id,
        costoPromedio: costoUnitario,
        userName,
      });
      const stockAnterior = this.toNumber(stockRow.stock_actual, 0);
      const delta = stockObjetivo - stockAnterior;

      stockRow.stock_min_bodega = this.toFixedText(normalizedStockMinBodega, 6);
      stockRow.stock_max_bodega = this.toFixedText(normalizedStockMaxBodega, 6);
      stockRow.stock_min_global = this.toFixedText(normalizedStockMinGlobal, 6);
      stockRow.stock_contenedores = this.toFixedText(stockContenedores, 6);
      stockRow.costo_promedio_bodega = this.toFixedText(costoUnitario, 4);
      stockRow.updated_by = userName;

      if (delta !== 0) {
        const tipo = delta > 0 ? 'INGRESO' : 'SALIDA';
        const stockNuevo = stockAnterior + delta;
        stockRow.stock_actual = this.toFixedText(stockNuevo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);

        await this.createMovementArtifacts(manager, {
          tipo,
          bodegaId: bodega.id,
          productoId: producto.id,
          cantidad: Math.abs(delta),
          costoUnitario,
          stockNuevo,
          observacion: 'Ajuste por carga masiva CSV/XLSX',
          userName,
        });

        if (delta > 0) summary.ingresos += 1;
        else summary.salidas += 1;
      } else {
        stockRow.stock_actual = this.toFixedText(stockObjetivo, 6);
        await manager.save(StockBodega, stockRow);
        changedStockIds.add(stockRow.id);
      }

      return true;
    });
  }

  private getMaintenanceRecalcUrl() {
    const baseUrl = String(
      this.configService.get('KPI_MAINTENANCE_URL') ||
        this.configService.get('MAINTENANCE_SERVICE_URL') ||
        this.configService.get('KPI_MAINTENANCE_INTERNAL_URL') ||
        '',
    )
      .trim()
      .replace(/\/$/, '');

    if (!baseUrl) return null;
    if (baseUrl.endsWith('/alertas/recalcular')) return baseUrl;
    return `${baseUrl}/alertas/recalcular`;
  }

  private async notifyMaintenanceRecalculationForStocks(
    stockIds: Iterable<string>,
    source: string,
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    const stockIdList = [...new Set([...stockIds].filter(Boolean))];
    if (!stockIdList.length) return;

    if (source === 'import') {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'inventory-kardex-import-completed',
            stock_count: stockIdList.length,
          }),
        });

        if (!response.ok) {
          this.logger.warn(
            `No se pudo disparar el recálculo de alertas (import:bulk). HTTP ${response.status}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Error notificando recálculo de alertas desde kardex (import:bulk): ${message}`,
        );
      }
      return;
    }

    for (const stockId of stockIdList) {
      if (!stockId) continue;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: `inventory-kardex-${source}`,
            stock_id: stockId,
          }),
        });

        if (!response.ok) {
          this.logger.warn(
            `No se pudo disparar el recálculo de alertas (${source}:${stockId}). HTTP ${response.status}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Error notificando recálculo de alertas desde kardex (${source}:${stockId}): ${message}`,
        );
      }
    }
  }

  private async notifyMaintenanceImportLifecycle(
    stage: 'started' | 'failed',
    jobId: string,
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: `inventory-kardex-import-${stage}`,
          job_id: jobId,
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `No se pudo notificar el ciclo de importación (${stage}:${jobId}). HTTP ${response.status}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Error notificando ciclo de importación (${stage}:${jobId}): ${message}`,
      );
    }
  }
}
