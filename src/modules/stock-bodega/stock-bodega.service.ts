import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DeepPartial,
  Repository,
  Brackets,
  DataSource,
  QueryFailedError,
  EntityManager,
} from 'typeorm';
import { CrudService } from '../../common/crud/crud.service';
import { Bodega } from '../entities/bodega.entity';
import { Kardex } from '../entities/kardex.entity';
import { MovimientoInventario } from '../entities/movimiento-inventario.entity';
import { MovimientoInventarioDet } from '../entities/movimiento-inventario-det.entity';
import { Producto } from '../entities/producto.entity';
import { StockBodega } from '../entities/stock-bodega.entity';
import { StockBodegaQueryDto } from './stock-bodega-query.dto';

type StockMovementType = 'INGRESO' | 'SALIDA';
type StockMaterialCondition = 'NUEVO' | 'USADO';

@Injectable()
export class StockBodegaService
  extends CrudService<StockBodega>
  implements OnModuleInit
{
  private readonly logger = new Logger(StockBodegaService.name);
  private readonly closedWorkOrderStatuses = [
    'CANCELLED',
    'CANCELED',
    'ANULADA',
    'ANULADO',
    'VOID',
    'VOIDED',
    'CLOSED',
    'CERRADA',
    'CERRADO',
    'DONE',
    'COMPLETED',
  ];

  constructor(
    @InjectRepository(StockBodega) repository: Repository<StockBodega>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    super(repository);
  }

  async onModuleInit() {
    await this.ensureSchema();
  }

  async create(payload: DeepPartial<StockBodega>) {
    const preparedPayload = this.normalizeStockPayload(payload);
    await this.ensureUniqueWarehouseProductStock(preparedPayload);

    try {
      const created = await this.dataSource.transaction(async (manager) => {
        const stockRepo = manager.getRepository(StockBodega);
        const createdRow = await stockRepo.save(
          stockRepo.create(preparedPayload),
        );
        await this.createStockAdjustmentArtifacts(manager, {
          previous: null,
          current: createdRow,
          payload,
        });
        return createdRow;
      });
      void this.notifyMaintenanceAlertRecalculation('create', created.id);
      return created;
    } catch (error) {
      throw await this.normalizeStockWriteError(error, preparedPayload);
    }
  }

  async update(id: string, payload: DeepPartial<StockBodega>) {
    const current = await this.findOne(id);
    const preparedPayload = this.normalizeStockPayload(payload, current);
    await this.ensureUniqueWarehouseProductStock(
      preparedPayload,
      id,
      current,
    );

    try {
      const updated = await this.dataSource.transaction(async (manager) => {
        const stockRepo = manager.getRepository(StockBodega);
        const currentInTx = await stockRepo.findOne({
          where: { id, is_deleted: false },
        });
        if (!currentInTx) {
          throw new NotFoundException(`Registro ${id} no encontrado`);
        }
        const previousSnapshot = stockRepo.create({ ...currentInTx });
        const merged = stockRepo.merge(currentInTx, preparedPayload);
        const updatedRow = await stockRepo.save(merged);
        await this.createStockAdjustmentArtifacts(manager, {
          previous: previousSnapshot,
          current: updatedRow,
          payload,
        });
        return updatedRow;
      });
      void this.notifyMaintenanceAlertRecalculation('update', id);
      return updated;
    } catch (error) {
      throw await this.normalizeStockWriteError(
        error,
        preparedPayload,
        id,
        current,
      );
    }
  }

  async remove(id: string, deletedBy?: string) {
    const removed = await super.remove(id, deletedBy);
    void this.notifyMaintenanceAlertRecalculation('remove', id);
    return removed;
  }

  async findAllPaginated(query: StockBodegaQueryDto, sucursalId?: string | null) {
    const page = Number.isFinite(Number(query.page)) && Number(query.page) > 0
      ? Number(query.page)
      : 1;
    const limit = Number.isFinite(Number(query.limit)) && Number(query.limit) > 0
      ? Math.min(Number(query.limit), 100)
      : 20;
    const search = String(query.search || '').trim();
    const warehouseId = String(query.bodega_id || '').trim();
    const closedStatusSql = this.closedWorkOrderStatuses
      .map((status) => `'${status.replace(/'/g, "''")}'`)
      .join(', ');
    const activeReservationSql = `COALESCE((
      SELECT SUM(COALESCE(reserva.cantidad, 0))
      FROM kpi_inventory.tb_reserva_stock reserva
      INNER JOIN kpi_process.tb_work_order work_order
        ON work_order.id = reserva.work_order_id
       AND work_order.is_deleted = false
      WHERE reserva.is_deleted = false
        AND UPPER(TRIM(COALESCE(reserva.estado, ''))) = 'RESERVADO'
        AND reserva.producto_id = stock.producto_id
        AND reserva.bodega_id = stock.bodega_id
        AND UPPER(TRIM(COALESCE(work_order.status_workflow, 'PLANNED'))) NOT IN (${closedStatusSql})
    ), 0)`;

    const baseQuery = this.repository
      .createQueryBuilder('stock')
      .leftJoin(
        Producto,
        'producto',
        'producto.id = stock.producto_id AND producto.is_deleted = false',
      )
      .leftJoin(
        Bodega,
        'bodega',
        'bodega.id = stock.bodega_id AND bodega.is_deleted = false',
      )
      .where('stock.is_deleted = false');

    if (sucursalId) {
      baseQuery.andWhere('bodega.sucursal_id = :sucursalId', { sucursalId });
    }

    if (warehouseId) {
      baseQuery.andWhere('stock.bodega_id = :warehouseId', { warehouseId });
    }

    if (typeof query.es_aceite === 'boolean') {
      baseQuery.andWhere('COALESCE(producto.es_aceite, false) = :oilOnly', {
        oilOnly: query.es_aceite,
      });
    }

    if (search) {
      baseQuery.andWhere(
        new Brackets((qb) => {
          qb.where('producto.nombre ILIKE :search', { search: `%${search}%` })
            .orWhere('producto.codigo ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('bodega.nombre ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('bodega.codigo ILIKE :search', {
              search: `%${search}%`,
            });
        }),
      );
    }

    const total = await baseQuery.clone().getCount();
    const { entities, raw } = await baseQuery
      .clone()
      .select('stock')
      .addSelect(
        `TRIM(CONCAT(COALESCE(producto.codigo || ' - ', ''), COALESCE(producto.nombre, 'Sin material')))`,
        'producto_label',
      )
      .addSelect(
        `TRIM(CONCAT(COALESCE(bodega.codigo || ' - ', ''), COALESCE(bodega.nombre, 'Sin bodega')))`,
        'bodega_label',
      )
      .addSelect('COALESCE(producto.es_aceite, false)', 'producto_es_aceite')
      .addSelect(
        `COALESCE(stock.stock_actual, 0) - COALESCE(stock.stock_fisico, 0)`,
        'stock_diferencia',
      )
      .addSelect(activeReservationSql, 'cantidad_reservada_activa')
      .addSelect(
        `GREATEST(COALESCE(stock.stock_actual, 0) - ${activeReservationSql}, 0)`,
        'stock_disponible',
      )
      .orderBy('stock.updated_at', 'DESC')
      .addOrderBy('stock.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getRawAndEntities();

    const data = entities.map((item, index) => ({
      ...item,
      producto_label: raw[index]?.producto_label ?? null,
      bodega_label: raw[index]?.bodega_label ?? null,
      es_aceite: Boolean(raw[index]?.producto_es_aceite ?? false),
      diferencia: Number(raw[index]?.stock_diferencia ?? 0),
      cantidad_reservada_activa: Number(
        raw[index]?.cantidad_reservada_activa ?? 0,
      ),
      stock_disponible: Number(
        raw[index]?.stock_disponible ?? item.stock_actual ?? 0,
      ),
    }));

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
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

  private async notifyMaintenanceAlertRecalculation(
    action: 'create' | 'update' | 'remove',
    stockId: string,
  ) {
    const url = this.getMaintenanceRecalcUrl();
    if (!url) return;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: `inventory-stock-${action}`,
          stock_id: stockId,
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `No se pudo disparar el recálculo de alertas (${action}:${stockId}). HTTP ${response.status}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Error notificando recálculo de alertas desde inventario (${action}:${stockId}): ${message}`,
      );
    }
  }

  private async ensureUniqueWarehouseProductStock(
    payload: DeepPartial<StockBodega>,
    currentId?: string,
    current?: StockBodega | null,
  ) {
    const productoId = this.firstNonEmptyString(
      payload.producto_id,
      current?.producto_id,
    );
    const bodegaId = this.firstNonEmptyString(
      payload.bodega_id,
      current?.bodega_id,
    );

    if (!productoId || !bodegaId) return;

    const qb = this.repository
      .createQueryBuilder('stock')
      .where('stock.is_deleted = false')
      .andWhere('stock.producto_id = :productoId', { productoId })
      .andWhere('stock.bodega_id = :bodegaId', { bodegaId });

    if (currentId) {
      qb.andWhere('stock.id <> :currentId', { currentId });
    }

    const existing = await qb.getOne();
    if (!existing) return;

    throw await this.buildWarehouseProductStockConflict(
      productoId,
      bodegaId,
      existing.id,
    );
  }

  private async normalizeStockWriteError(
    error: unknown,
    payload: DeepPartial<StockBodega>,
    currentId?: string,
    current?: StockBodega | null,
  ) {
    if (!this.isWarehouseProductUniqueError(error)) {
      return error;
    }

    const productoId = this.firstNonEmptyString(
      payload.producto_id,
      current?.producto_id,
    );
    const bodegaId = this.firstNonEmptyString(
      payload.bodega_id,
      current?.bodega_id,
    );

    return this.buildWarehouseProductStockConflict(
      productoId,
      bodegaId,
      currentId,
    );
  }

  private isWarehouseProductUniqueError(error: unknown) {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = (error as any)?.driverError ?? {};
    const code = String(driverError?.code || '');
    const constraint = String(driverError?.constraint || '').toLowerCase();
    const detail = String(driverError?.detail || '').toLowerCase();
    const message = String((error as any)?.message || '').toLowerCase();

    if (code !== '23505') return false;
    return (
      constraint.includes('stock_bodega') ||
      detail.includes('producto_id') ||
      detail.includes('bodega_id') ||
      message.includes('producto_id') ||
      message.includes('bodega_id')
    );
  }

  private async buildWarehouseProductStockConflict(
    productoId?: string | null,
    bodegaId?: string | null,
    existingStockId?: string | null,
  ) {
    const [producto, bodega] = await Promise.all([
      productoId
        ? this.dataSource.getRepository(Producto).findOne({
            where: { id: productoId, is_deleted: false },
          })
        : Promise.resolve(null),
      bodegaId
        ? this.dataSource.getRepository(Bodega).findOne({
            where: { id: bodegaId, is_deleted: false },
          })
        : Promise.resolve(null),
    ]);
    const productoLabel = this.buildProductLabel(producto, productoId);
    const bodegaLabel = this.buildWarehouseLabel(bodega, bodegaId);

    return new ConflictException({
      message: `Ya existe un registro de stock para el material ${productoLabel} en la bodega ${bodegaLabel}. Edita el registro existente en lugar de crear uno duplicado.`,
      duplicate: {
        stock_id: existingStockId ?? null,
        producto_id: productoId ?? null,
        producto_label: productoLabel,
        bodega_id: bodegaId ?? null,
        bodega_label: bodegaLabel,
      },
    });
  }

  private buildProductLabel(
    producto?: Producto | null,
    fallback?: string | null,
  ) {
    return (
      [producto?.codigo, producto?.nombre]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join(' - ') ||
      String(fallback || 'seleccionado').trim() ||
      'seleccionado'
    );
  }

  private buildWarehouseLabel(
    bodega?: Bodega | null,
    fallback?: string | null,
  ) {
    return (
      [bodega?.codigo, bodega?.nombre]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join(' - ') ||
      String(fallback || 'seleccionada').trim() ||
      'seleccionada'
    );
  }

  private firstNonEmptyString(...values: unknown[]) {
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      if (normalized) return normalized;
    }
    return null;
  }

  private async createStockAdjustmentArtifacts(
    manager: EntityManager,
    args: {
      previous?: StockBodega | null;
      current: StockBodega;
      payload?: DeepPartial<StockBodega>;
    },
  ) {
    const previousTotal = this.toNumeric(args.previous?.stock_actual, 0);
    const currentTotal = this.toNumeric(args.current.stock_actual, 0);
    const delta = Number((currentTotal - previousTotal).toFixed(6));
    if (Math.abs(delta) < 0.000001) return null;

    if (currentTotal < -0.000001) {
      throw new BadRequestException('El stock actual no puede ser negativo.');
    }

    const productoId = this.firstNonEmptyString(args.current.producto_id);
    const bodegaId = this.firstNonEmptyString(args.current.bodega_id);
    if (!productoId || !bodegaId) return null;

    const producto = await manager.findOne(Producto, {
      where: { id: productoId, is_deleted: false },
    });
    const bodega = await manager.findOne(Bodega, {
      where: { id: bodegaId, is_deleted: false },
    });
    if (!producto || !bodega) return null;

    const tipo: StockMovementType = delta > 0 ? 'INGRESO' : 'SALIDA';
    const cantidad = Math.abs(delta);
    const condicionMaterial = this.resolveStockAdjustmentCondition(
      args.previous,
      args.current,
      tipo,
    );
    const costoUnitario = this.resolveStockAdjustmentUnitCost(
      args.current,
      producto,
    );
    const userName =
      this.firstNonEmptyString(
        (args.payload as any)?.updated_by,
        (args.payload as any)?.created_by,
        args.current.updated_by,
        args.current.created_by,
      ) ?? 'SYSTEM';
    const observacion =
      this.firstNonEmptyString((args.payload as any)?.observacion) ??
      `Ajuste de stock por bodega (${previousTotal.toFixed(2)} -> ${currentTotal.toFixed(2)})`;

    return this.createMovementArtifacts(manager, {
      tipo,
      bodegaId,
      productoId,
      cantidad,
      costoUnitario,
      saldoCantidad: currentTotal,
      condicionMaterial,
      observacion,
      userName,
    });
  }

  private resolveStockAdjustmentCondition(
    previous: StockBodega | null | undefined,
    current: StockBodega,
    tipo: StockMovementType,
  ): StockMaterialCondition {
    const previousNuevo = this.toNumeric(
      previous?.stock_nuevo,
      this.toNumeric(previous?.stock_actual, 0) - this.toNumeric(previous?.stock_usado, 0),
    );
    const previousUsado = this.toNumeric(previous?.stock_usado, 0);
    const currentNuevo = this.toNumeric(
      current.stock_nuevo,
      this.toNumeric(current.stock_actual, 0) - this.toNumeric(current.stock_usado, 0),
    );
    const currentUsado = this.toNumeric(current.stock_usado, 0);
    const nuevoDelta = Number((currentNuevo - previousNuevo).toFixed(6));
    const usadoDelta = Number((currentUsado - previousUsado).toFixed(6));

    if (tipo === 'INGRESO') {
      return usadoDelta > 0 && usadoDelta >= nuevoDelta ? 'USADO' : 'NUEVO';
    }
    return usadoDelta < 0 && Math.abs(usadoDelta) >= Math.abs(nuevoDelta)
      ? 'USADO'
      : 'NUEVO';
  }

  private resolveStockAdjustmentUnitCost(
    stock: StockBodega,
    producto?: Producto | null,
  ) {
    const stockCost = this.toNumeric(stock.costo_promedio_bodega, 0);
    if (stockCost > 0) return stockCost;

    const productCost = this.toNumeric(
      producto?.costo_promedio ?? producto?.ultimo_costo,
      0,
    );
    return productCost > 0 ? productCost : 0;
  }

  private async generateMovementDocumentCode(
    manager: EntityManager,
    prefix: 'IB' | 'EB',
  ) {
    const rows = await manager.find(MovimientoInventario, {
      where: { is_deleted: false },
      select: { numero_documento: true } as any,
      take: 500,
      order: { created_at: 'DESC' } as any,
    });
    const maxNumber = rows.reduce((max, current: any) => {
      const match = new RegExp(`^${prefix}-(\\d{8})$`, 'i').exec(
        String(current?.numero_documento || '').trim(),
      );
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);
    return `${prefix}-${String(maxNumber + 1).padStart(8, '0')}`;
  }

  private async createMovementArtifacts(
    manager: EntityManager,
    args: {
      tipo: StockMovementType;
      bodegaId: string;
      productoId: string;
      cantidad: number;
      costoUnitario: number;
      saldoCantidad: number;
      condicionMaterial: StockMaterialCondition;
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
        condicion_material: args.condicionMaterial,
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
        condicion_material: args.condicionMaterial,
        costo_unitario: this.toFixedText(args.costoUnitario, 4),
        costo_total: this.toFixedText(subtotal, 4),
        saldo_cantidad: this.toFixedText(args.saldoCantidad, 6),
        saldo_costo_promedio: this.toFixedText(args.costoUnitario, 4),
        saldo_valorizado: this.toFixedText(
          args.saldoCantidad * args.costoUnitario,
          4,
        ),
        observacion: args.observacion,
        created_by: args.userName,
        updated_by: args.userName,
      }),
    );

    return { movimiento, detalle, kardex };
  }

  private normalizeStockPayload(
    payload: DeepPartial<StockBodega>,
    current?: StockBodega | null,
  ): DeepPartial<StockBodega> {
    const stockActual = this.toDecimalText(
      Object.prototype.hasOwnProperty.call(payload, 'stock_actual')
        ? payload.stock_actual
        : current?.stock_actual,
      current?.stock_actual ?? '0',
    );
    const hasStockNuevo = Object.prototype.hasOwnProperty.call(
      payload,
      'stock_nuevo',
    );
    const hasStockUsado = Object.prototype.hasOwnProperty.call(
      payload,
      'stock_usado',
    );
    const hasStockActual = Object.prototype.hasOwnProperty.call(
      payload,
      'stock_actual',
    );
    const esUsado = this.toBoolean(
      Object.prototype.hasOwnProperty.call(payload, 'es_usado')
        ? payload.es_usado
        : current?.es_usado,
    );
    const stockUsado = esUsado
      ? this.toDecimalText(
          hasStockUsado ? payload.stock_usado : current?.stock_usado,
          current?.stock_usado ?? '0',
        )
      : '0';
    const stockNuevo = this.resolveStockNuevoText({
      payload,
      current,
      hasStockNuevo,
      hasStockActual,
      stockActual,
      stockUsado,
    });
    const stockActualTotal = this.toDecimalText(
      this.toNumeric(stockNuevo) + this.toNumeric(stockUsado),
      stockActual,
    );
    if (
      this.toNumeric(stockNuevo, 0) < 0 ||
      this.toNumeric(stockUsado, 0) < 0 ||
      this.toNumeric(stockActualTotal, 0) < 0
    ) {
      throw new BadRequestException(
        'El stock nuevo, usado y total no pueden ser negativos.',
      );
    }
    const hasPhysicalStock = Object.prototype.hasOwnProperty.call(
      payload,
      'stock_fisico',
    );
    const stockFisico = this.toDecimalText(
      hasPhysicalStock ? payload.stock_fisico : current?.stock_fisico,
      current?.stock_fisico ?? stockActual,
    );

    return {
      ...payload,
      stock_actual: stockActualTotal,
      stock_nuevo: stockNuevo,
      stock_usado: stockUsado,
      stock_fisico: stockFisico,
      es_usado: esUsado,
    };
  }

  private resolveStockNuevoText(args: {
    payload: DeepPartial<StockBodega>;
    current?: StockBodega | null;
    hasStockNuevo: boolean;
    hasStockActual: boolean;
    stockActual: string;
    stockUsado: string;
  }) {
    if (args.hasStockNuevo) {
      return this.toDecimalText(args.payload.stock_nuevo, '0');
    }

    if (args.hasStockActual && !args.current?.stock_nuevo) {
      return this.toDecimalText(
        Math.max(
          this.toNumeric(args.stockActual) - this.toNumeric(args.stockUsado),
          0,
        ),
        '0',
      );
    }

    return this.toDecimalText(
      args.current?.stock_nuevo ?? args.current?.stock_actual,
      args.stockActual,
    );
  }

  private toDecimalText(value: unknown, fallback = '0') {
    if (value === null || value === undefined || value === '') return fallback;
    const normalized = String(value).replace(',', '.').trim();
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) return fallback;
    return numeric.toString();
  }

  private toNumeric(value: unknown, fallback = 0) {
    const normalized = String(value ?? '').replace(',', '.').trim();
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private toFixedText(value: number, decimals: number) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '0';
  }

  private toBoolean(value: unknown) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    return ['true', '1', 'si', 'sí', 's', 'yes', 'y', 'on'].includes(
      normalized,
    );
  }

  private async ensureSchema() {
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_stock_bodega
      ADD COLUMN IF NOT EXISTS stock_fisico numeric(18, 6) NOT NULL DEFAULT 0
    `);
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_stock_bodega
      ADD COLUMN IF NOT EXISTS es_usado boolean NOT NULL DEFAULT false
    `);
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_stock_bodega
      ADD COLUMN IF NOT EXISTS stock_nuevo numeric(18, 6) NOT NULL DEFAULT 0
    `);
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_stock_bodega
      ADD COLUMN IF NOT EXISTS stock_usado numeric(18, 6) NOT NULL DEFAULT 0
    `);
    await this.dataSource.query(`
      UPDATE kpi_inventory.tb_stock_bodega
      SET stock_nuevo = COALESCE(stock_actual, 0)
      WHERE COALESCE(stock_nuevo, 0) = 0
        AND COALESCE(stock_usado, 0) = 0
        AND COALESCE(stock_actual, 0) <> 0
    `);
    await this.dataSource.query(`
      UPDATE kpi_inventory.tb_stock_bodega
      SET stock_usado = 0
      WHERE COALESCE(es_usado, false) = false
        AND COALESCE(stock_usado, 0) <> 0
    `);
    await this.dataSource.query(`
      UPDATE kpi_inventory.tb_stock_bodega
      SET stock_actual = COALESCE(stock_nuevo, 0) + COALESCE(stock_usado, 0)
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_stock_bodega_es_usado
      ON kpi_inventory.tb_stock_bodega (es_usado)
      WHERE is_deleted = false
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_stock_bodega_stock_usado
      ON kpi_inventory.tb_stock_bodega (stock_usado)
      WHERE is_deleted = false AND COALESCE(es_usado, false) = true
    `);
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_movimiento_inventario_det
      ADD COLUMN IF NOT EXISTS condicion_material varchar(12) NOT NULL DEFAULT 'NUEVO'
    `);
    await this.dataSource.query(`
      ALTER TABLE IF EXISTS kpi_inventory.tb_kardex
      ADD COLUMN IF NOT EXISTS condicion_material varchar(12) NOT NULL DEFAULT 'NUEVO'
    `);
  }
}
