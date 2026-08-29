import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Brackets, DataSource, EntityManager, In, Not, Repository } from 'typeorm';
import {
  Bodega,
  OrdenCompra,
  OrdenCompraDet,
  Producto,
  Tercero,
} from '../entities';
import {
  CreateOrdenCompraDto,
  OrdenCompraDetalleDto,
  OrdenCompraQueryDto,
  UpdateOrdenCompraDto,
} from './orden-compra.dto';
import { TransferenciaBodega } from '../entities/transferencia-bodega.entity';
import { isAdministrativeManagementRoleName } from '../../common/utils/administrative-role.util';
import { buildAnnulmentInfo } from '../../common/http/annulled-records.util';
import { buildSecurityServiceHeaders } from '../../common/http/internal-service.util';

type Totals = {
  subtotal: number;
  descuentoTotal: number;
  ivaTotal: number;
  total: number;
};

type DocumentAnnulmentActor = {
  username?: string | null;
  displayName?: string | null;
  roleName?: string | null;
};

@Injectable()
export class OrdenCompraService {
  private readonly logger = new Logger(OrdenCompraService.name);

  constructor(
    @InjectRepository(OrdenCompra)
    private readonly ordenRepo: Repository<OrdenCompra>,
    @InjectRepository(OrdenCompraDet)
    private readonly detalleRepo: Repository<OrdenCompraDet>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(Tercero)
    private readonly terceroRepo: Repository<Tercero>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
    @InjectRepository(TransferenciaBodega)
    private readonly transferenciaRepo: Repository<TransferenciaBodega>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private assertCanAnnul(actor?: DocumentAnnulmentActor | null) {
    if (isAdministrativeManagementRoleName(actor?.roleName)) return;
    throw new ForbiddenException(
      'Solo Administrador, Super Administrador o Gerente General pueden anular documentos.',
    );
  }

  private resolveAnnulmentActorName(actor?: DocumentAnnulmentActor | null) {
    return this.toText(actor?.displayName) || this.toText(actor?.username) || 'SYSTEM';
  }

  private get securityServiceUrl() {
    return String(
      this.configService.get('SECURITY_SERVICE_URL') ||
        this.configService.get('KPI_SECURITY_URL') ||
        '',
    )
      .trim()
      .replace(/\/$/, '');
  }

  private get internalServiceToken() {
    return String(
      this.configService.get('INTERNAL_SERVICE_TOKEN') || '',
    ).trim();
  }

  /** Endpoint publicado por el controlador; se guarda en el log transaccional. */
  private readonly logEndpoint = '/kpi_inventory/ordenes-compra';

  private queueTransactionLog(payload: {
    traceId: string;
    typeLog: string;
    description: string;
    createdBy?: string | null;
    status?: string;
    requestMethod?: string | null;
    requestUrl?: string | null;
    requestPayload?: unknown;
  }) {
    void this.writeTransactionLog(payload);
  }

  private async writeTransactionLog(payload: {
    traceId: string;
    typeLog: string;
    description: string;
    createdBy?: string | null;
    status?: string;
    requestMethod?: string | null;
    requestUrl?: string | null;
    requestPayload?: unknown;
  }) {
    if (!this.securityServiceUrl) return;
    try {
      const url = `${this.securityServiceUrl}/log-transacts`;
      const response = await fetch(url, {
        method: 'POST',
        headers: buildSecurityServiceHeaders({
          url,
          securityServiceUrl: this.securityServiceUrl,
          internalServiceToken: this.internalServiceToken,
          json: true,
        }),
        body: JSON.stringify({
          moduleMicroservice: 'kpi_inventory',
          status: payload.status ?? 'SUCCESS',
          typeLog: payload.typeLog,
          description: `[TRACE:${payload.traceId}] ${payload.description}`,
          createdBy: payload.createdBy ?? null,
          requestMethod: payload.requestMethod ?? null,
          requestUrl: payload.requestUrl ?? null,
          requestPayload: payload.requestPayload ?? null,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }
    } catch (error: any) {
      this.logger.warn(
        `No se pudo registrar log transaccional de orden de compra: ${error?.message ?? 'desconocido'}`,
      );
    }
  }

  private async getWarehouseIdsBySucursal(sucursalId?: string | null) {
    if (!sucursalId) return null;
    const rows = await this.bodegaRepo.find({
      where: { sucursal_id: sucursalId, is_deleted: false } as any,
      select: { id: true } as any,
    });
    return rows.map((item) => item.id);
  }

  async findAll(
    query: OrdenCompraQueryDto,
    sucursalId?: string | null,
    includeAnnulled = false,
  ) {
    const page = Number(query.page || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit || 10)));
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);
    if (warehouseIds && !warehouseIds.length) {
      return {
        data: [],
        pagination: { page, limit, total: 0, totalPages: 1 },
      };
    }
    const qb = this.ordenRepo
      .createQueryBuilder('orden')
      .where('orden.is_deleted = false');

    if (!includeAnnulled) {
      qb.andWhere(
        "UPPER(TRIM(COALESCE(orden.estado, ''))) NOT IN ('ANULADA', 'ANULADO', 'CANCELADA', 'CANCELADO', 'VOID', 'VOIDED')",
      );
    }

    if (warehouseIds) {
      qb.andWhere('orden.bodega_destino_id IN (:...warehouseIds)', {
        warehouseIds,
      });
    }
    if (query.bodega_destino_id) {
      qb.andWhere('orden.bodega_destino_id = :bodegaDestinoId', {
        bodegaDestinoId: query.bodega_destino_id,
      });
    }
    if (query.estado) {
      qb.andWhere("UPPER(TRIM(COALESCE(orden.estado, ''))) = :estado", {
        estado: this.toText(query.estado).toUpperCase(),
      });
    }
    if (query.proveedor_id) {
      qb.andWhere('orden.proveedor_id = :proveedorId', {
        proveedorId: query.proveedor_id,
      });
    }
    if (query.desde) {
      qb.andWhere('DATE(orden.fecha_emision) >= :desde', { desde: query.desde });
    }
    if (query.hasta) {
      qb.andWhere('DATE(orden.fecha_emision) <= :hasta', { hasta: query.hasta });
    }
    const search = this.toText(query.search);
    if (search) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('orden.codigo ILIKE :search', { search: `%${search}%` })
            .orWhere("COALESCE(orden.proveedor_nombre, '') ILIKE :search", {
              search: `%${search}%`,
            })
            .orWhere("COALESCE(orden.referencia, '') ILIKE :search", {
              search: `%${search}%`,
            });
        }),
      );
    }

    const [rows, total] = await qb
      .orderBy('orden.created_at', 'DESC')
      .addOrderBy('orden.fecha_emision', 'DESC')
      .addOrderBy('orden.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return {
      data: await this.hydrateOrders(rows),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findPendingForTransfer(sucursalId?: string | null) {
    const where: any = { is_deleted: false, estado: 'EMITIDA' };
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);
    if (warehouseIds && !warehouseIds.length) return [];
    if (warehouseIds) where.bodega_destino_id = In(warehouseIds);

    const rows = await this.ordenRepo.find({
      where,
      order: { created_at: 'DESC', fecha_emision: 'DESC' },
    });
    const activeTransfers = await this.transferenciaRepo.find({
      where: { is_deleted: false, estado: Not('ANULADA') },
      select: { orden_compra_id: true } as any,
    });
    const transferredIds = new Set(
      activeTransfers.map((item) => String(item.orden_compra_id || '')),
    );
    const pending = rows.filter((item) => !transferredIds.has(item.id));
    return this.hydrateOrders(pending, true);
  }

  async findOne(id: string, sucursalId?: string | null) {
    const order = await this.ordenRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!order) {
      throw new NotFoundException('La orden de compra no existe.');
    }
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);
    if (warehouseIds && !warehouseIds.includes(String(order.bodega_destino_id || ''))) {
      throw new NotFoundException('La orden de compra no existe.');
    }
    const [hydrated] = await this.hydrateOrders([order], true);
    return hydrated;
  }

  async create(dto: CreateOrdenCompraDto) {
    const traceId = randomUUID();
    const createdBy = this.resolveUserName(dto);
    this.queueTransactionLog({
      traceId,
      typeLog: 'PURCHASE_ORDER_FLOW',
      createdBy,
      description: 'Inicio de registro de orden de compra.',
    });
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        return this.saveOrder(manager, dto, undefined, traceId);
      });
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy,
        description: `Orden de compra ${this.toText((result as any)?.codigo) || 'sin-codigo'} registrada correctamente.`,
      });
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy,
        status: 'ERROR',
        requestMethod: 'POST',
        requestUrl: this.logEndpoint,
        requestPayload: dto,
        description: `Fallo al registrar orden de compra: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async update(id: string, dto: UpdateOrdenCompraDto) {
    const traceId = randomUUID();
    const createdBy = this.resolveUserName(dto);
    this.queueTransactionLog({
      traceId,
      typeLog: 'PURCHASE_ORDER_FLOW',
      createdBy,
      description: `Inicio de actualizacion de orden de compra ${id}.`,
    });
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const current = await manager.findOne(OrdenCompra, {
          where: { id, is_deleted: false },
        });
        if (!current) {
          throw new NotFoundException('La orden de compra no existe.');
        }
        if (String(current.estado || '').trim().toUpperCase() === 'ANULADA') {
          throw new BadRequestException('La orden de compra esta anulada y no se puede modificar.');
        }

        const transfer = await manager.findOne(TransferenciaBodega, {
          where: { orden_compra_id: id, is_deleted: false },
        });
        if (transfer && String(transfer.estado || '').trim().toUpperCase() !== 'ANULADA') {
          throw new BadRequestException(
            'La orden ya tiene una transferencia registrada y no se puede modificar.',
          );
        }

        const details = await manager.find(OrdenCompraDet, {
          where: { orden_compra_id: id, is_deleted: false },
        });
        if (details.length) {
          details.forEach((item) => {
            item.is_deleted = true;
            item.deleted_at = new Date();
            item.deleted_by = this.resolveUserName(dto);
          });
          await manager.save(OrdenCompraDet, details);
        }

        return this.saveOrder(manager, dto, current, traceId);
      });
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy,
        description: `Orden de compra ${this.toText((result as any)?.codigo) || id} actualizada correctamente.`,
      });
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy,
        status: 'ERROR',
        requestMethod: 'PATCH',
        requestUrl: `${this.logEndpoint}/${id}`,
        requestPayload: dto,
        description: `Fallo al actualizar orden de compra ${id}: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async annul(id: string, actor?: DocumentAnnulmentActor | null) {
    this.assertCanAnnul(actor);
    const annulledBy = this.resolveAnnulmentActorName(actor);
    const traceId = randomUUID();
    this.queueTransactionLog({
      traceId,
      typeLog: 'PURCHASE_ORDER_FLOW',
      createdBy: annulledBy,
      description: `Inicio de anulacion de orden de compra ${id}.`,
    });
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const current = await manager.findOne(OrdenCompra, {
          where: { id, is_deleted: false },
        });
        if (!current) {
          throw new NotFoundException('La orden de compra no existe.');
        }
        if (String(current.estado || '').trim().toUpperCase() === 'ANULADA') {
          const [hydrated] = await this.hydrateOrdersWithManager(
            manager,
            [current],
            true,
          );
          return hydrated;
        }
        const transfer = await manager.findOne(TransferenciaBodega, {
          where: { orden_compra_id: id, is_deleted: false },
        });
        if (transfer && String(transfer.estado || '').trim().toUpperCase() !== 'ANULADA') {
          throw new BadRequestException(
            'La orden ya tiene una transferencia activa y no se puede anular.',
          );
        }

        current.estado = 'ANULADA';
        current.updated_by = annulledBy;
        await manager.save(OrdenCompra, current);
        const [hydrated] = await this.hydrateOrdersWithManager(
          manager,
          [current],
          true,
        );
        return hydrated;
      });
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy: annulledBy,
        description: `Orden de compra ${id} anulada correctamente.`,
      });
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy: annulledBy,
        status: 'ERROR',
        requestMethod: 'PATCH',
        requestUrl: `${this.logEndpoint}/${id}/anular`,
        requestPayload: { id, annulledBy },
        description: `Fallo al anular orden de compra ${id}: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async remove(id: string, actor?: DocumentAnnulmentActor | null) {
    return this.annul(id, actor);
  }

  private isSuperAdministratorRoleName(roleName?: string): boolean {
    const normalized = String(roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();
    return [
      'SUPER ADMINISTRADOR',
      'SUPERADMINISTRADOR',
      'SUPER_ADMINISTRADOR',
      'SUPER ADMIN',
    ].includes(normalized);
  }

  private assertCanPurge(roleName?: string) {
    if (this.isSuperAdministratorRoleName(roleName)) return;
    throw new ForbiddenException(
      'Solo el Super Administrador puede ejecutar eliminacion real masiva.',
    );
  }

  async purgeAll(roleName?: string) {
    this.assertCanPurge(roleName);
    const result = await this.dataSource.transaction(async (manager) => {
      const detachedTransfers = await manager
        .createQueryBuilder()
        .update(TransferenciaBodega)
        .set({ orden_compra_id: null })
        .where('orden_compra_id IS NOT NULL')
        .execute();
      const details = await manager
        .createQueryBuilder()
        .delete()
        .from(OrdenCompraDet)
        .execute();
      const orders = await manager
        .createQueryBuilder()
        .delete()
        .from(OrdenCompra)
        .execute();

      return {
        detached_transferencias: Number(detachedTransfers.affected || 0),
        detalles: Number(details.affected || 0),
        ordenes: Number(orders.affected || 0),
      };
    });

    return {
      message: `Eliminacion real masiva ejecutada correctamente (${result.ordenes} ordenes de compra).`,
      affected: result.ordenes,
      details: result,
    };
  }

  private async saveOrder(
    manager: EntityManager,
    dto: CreateOrdenCompraDto,
    current?: OrdenCompra,
    traceId?: string,
  ) {
    const userName = this.resolveUserName(dto);
    const details = Array.isArray(dto.detalles) ? dto.detalles : [];
    if (!details.length) {
      throw new BadRequestException(
        'Debes agregar al menos un material a la orden de compra.',
      );
    }

    const warehouseId =
      this.toText(dto.bodega_destino_id) ||
      current?.bodega_destino_id ||
      (await this.resolveDefaultPurchaseWarehouseId(manager));
    if (!warehouseId) {
      throw new BadRequestException(
        'No existe una bodega configurada como default para compras.',
      );
    }

    const warehouse = await manager.findOne(Bodega, {
      where: { id: warehouseId, is_deleted: false },
    });
    if (!warehouse) {
      throw new BadRequestException('La bodega seleccionada no existe.');
    }

    const supplier = dto.proveedor_id
      ? await manager.findOne(Tercero, {
          where: { id: dto.proveedor_id, is_deleted: false },
        })
      : null;

    if (dto.proveedor_id && !supplier) {
      throw new BadRequestException('El proveedor seleccionado no existe.');
    }

    const preparedDetails = await this.prepareDetails(manager, details, warehouseId);
    const totals = this.calculateTotals(preparedDetails);
    if (traceId) {
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy: userName,
        description: `Validacion completada para orden de compra. Materiales=${preparedDetails.length}.`,
      });
    }

    const entity =
      current ??
      manager.create(OrdenCompra, {
        codigo: await this.generateCode(manager),
        created_by: userName,
      });

    if (current) {
      entity.codigo = this.toText(dto.codigo) || entity.codigo;
    }
    entity.fecha_emision = dto.fecha_emision
      ? new Date(dto.fecha_emision)
      : current?.fecha_emision ?? new Date();
    entity.fecha_requerida = this.toText(dto.fecha_requerida) || null;
    entity.proveedor_id = supplier?.id ?? null;
    entity.proveedor_identificacion = supplier?.identificacion ?? null;
    entity.proveedor_nombre =
      supplier?.razon_social ??
      (this.toText(current?.proveedor_nombre) || null);
    entity.bodega_destino_id = warehouse.id;
    entity.vendedor =
      this.toText(dto.vendedor) || current?.vendedor || warehouse.nombre || null;
    entity.condicion_pago =
      this.toText(dto.condicion_pago) || current?.condicion_pago || null;
    entity.referencia =
      this.toText(dto.referencia) || current?.referencia || (await this.generateReference(manager));
    entity.observacion = this.toText(dto.observacion) || null;
    entity.moneda = this.toText(dto.moneda) || current?.moneda || 'USD';
    entity.tipo_cambio = this.toFixedText(
      this.toNumber(dto.tipo_cambio, this.toNumber(current?.tipo_cambio, 1) || 1),
      6,
    );
    entity.subtotal = this.toFixedText(totals.subtotal, 4);
    entity.descuento_total = this.toFixedText(totals.descuentoTotal, 4);
    entity.iva_total = this.toFixedText(totals.ivaTotal, 4);
    entity.total = this.toFixedText(totals.total, 4);
    entity.estado = current?.estado === 'TRANSFERIDA' ? 'TRANSFERIDA' : 'EMITIDA';
    entity.updated_by = userName;

    const savedOrder = await manager.save(OrdenCompra, entity);
    if (traceId) {
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy: userName,
        description: `Cabecera persistida para orden de compra ${savedOrder.codigo}.`,
      });
    }

    const detailEntities = preparedDetails.map((detail) =>
      manager.create(OrdenCompraDet, {
        orden_compra_id: savedOrder.id,
        producto_id: detail.producto.id,
        codigo_producto: detail.producto.codigo,
        nombre_producto: detail.producto.nombre,
        cantidad: this.toFixedText(detail.cantidad, 6),
        cantidad_preaprobada: this.toFixedText(detail.cantidad, 6),
        cantidad_transferida: '0.000000',
        costo_unitario: this.toFixedText(detail.costoUnitario, 4),
        descuento: this.toFixedText(detail.descuento, 4),
        porcentaje_descuento: this.toFixedText(detail.porcentajeDescuento, 4),
        iva_porcentaje: this.toFixedText(detail.ivaPorcentaje, 4),
        subtotal: this.toFixedText(detail.subtotal, 4),
        iva_total: this.toFixedText(detail.ivaTotal, 4),
        total: this.toFixedText(detail.total, 4),
        observacion: detail.observacion,
        bodega_destino_id: warehouse.id,
        created_by: current?.created_by ?? userName,
        updated_by: userName,
      }),
    );
    await manager.save(OrdenCompraDet, detailEntities);
    if (traceId) {
      this.queueTransactionLog({
        traceId,
        typeLog: 'PURCHASE_ORDER_FLOW',
        createdBy: userName,
        description: `Detalle persistido para orden de compra ${savedOrder.codigo}. Filas=${detailEntities.length}.`,
      });
    }

    const [hydrated] = await this.hydrateOrdersWithManager(manager, [savedOrder], true);
    return hydrated;
  }

  private async hydrateOrders(rows: OrdenCompra[], includeDetails = false) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const [details, warehouses, transfers] = await Promise.all([
      this.detalleRepo.find({
        where: ids.map((ordenId) => ({ orden_compra_id: ordenId, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
      this.bodegaRepo.find({
        where: ids
          .map((id) => rows.find((item) => item.id === id)?.bodega_destino_id)
          .filter((value): value is string => Boolean(value))
          .map((bodegaId) => ({ id: bodegaId, is_deleted: false })),
      }),
      this.transferenciaRepo.find({
        where: ids.map((ordenId) => ({
          orden_compra_id: ordenId,
          is_deleted: false,
          estado: Not('ANULADA'),
        })),
      }),
    ]);

    const detailMap = details.reduce((acc, item) => {
      const cantidadPreaprobada = this.toNumber(
        item.cantidad_preaprobada,
        this.toNumber(item.cantidad, 0),
      );
      const cantidadTransferida = this.toNumber(item.cantidad_transferida, 0);
      const cantidadDisponible = Math.max(
        0,
        cantidadPreaprobada - cantidadTransferida,
      );
      (acc[item.orden_compra_id] ??= []).push({
        ...item,
        cantidad_preaprobada: this.toFixedText(cantidadPreaprobada, 6),
        cantidad_transferida: this.toFixedText(cantidadTransferida, 6),
        cantidad_preaprobada_disponible: this.toFixedText(
          cantidadDisponible,
          6,
        ),
      });
      return acc;
    }, {} as Record<string, any[]>);
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const transferMap = new Map(transfers.map((item) => [item.orden_compra_id, item]));

    return rows.map((item) => {
      const warehouse = item.bodega_destino_id
        ? warehouseMap.get(item.bodega_destino_id)
        : null;
      const transfer = transferMap.get(item.id);
      return {
        ...item,
        ...buildAnnulmentInfo(item),
        proveedor_label: item.proveedor_nombre || 'Sin proveedor',
        bodega_label: warehouse
          ? `${warehouse.codigo || ''} - ${warehouse.nombre || ''}`.trim()
          : 'Sin bodega',
        transferencia_id: transfer?.id ?? null,
        transferencia_codigo: transfer?.codigo ?? null,
        tiene_transferencia: Boolean(transfer),
        detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
      };
    });
  }

  private async hydrateOrdersWithManager(
    manager: EntityManager,
    rows: OrdenCompra[],
    includeDetails = false,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const [details, warehouses, transfers] = await Promise.all([
      manager.find(OrdenCompraDet, {
        where: ids.map((ordenId) => ({ orden_compra_id: ordenId, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
      manager.find(Bodega, {
        where: ids
          .map((id) => rows.find((item) => item.id === id)?.bodega_destino_id)
          .filter((value): value is string => Boolean(value))
          .map((bodegaId) => ({ id: bodegaId, is_deleted: false })),
      }),
      manager.find(TransferenciaBodega, {
        where: ids.map((ordenId) => ({
          orden_compra_id: ordenId,
          is_deleted: false,
          estado: Not('ANULADA'),
        })),
      }),
    ]);

    const detailMap = details.reduce((acc, item) => {
      const cantidadPreaprobada = this.toNumber(
        item.cantidad_preaprobada,
        this.toNumber(item.cantidad, 0),
      );
      const cantidadTransferida = this.toNumber(item.cantidad_transferida, 0);
      const cantidadDisponible = Math.max(
        0,
        cantidadPreaprobada - cantidadTransferida,
      );
      (acc[item.orden_compra_id] ??= []).push({
        ...item,
        cantidad_preaprobada: this.toFixedText(cantidadPreaprobada, 6),
        cantidad_transferida: this.toFixedText(cantidadTransferida, 6),
        cantidad_preaprobada_disponible: this.toFixedText(
          cantidadDisponible,
          6,
        ),
      });
      return acc;
    }, {} as Record<string, any[]>);
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const transferMap = new Map(transfers.map((item) => [item.orden_compra_id, item]));

    return rows.map((item) => {
      const warehouse = item.bodega_destino_id
        ? warehouseMap.get(item.bodega_destino_id)
        : null;
      const transfer = transferMap.get(item.id);
      return {
        ...item,
        ...buildAnnulmentInfo(item),
        proveedor_label: item.proveedor_nombre || 'Sin proveedor',
        bodega_label: warehouse
          ? `${warehouse.codigo || ''} - ${warehouse.nombre || ''}`.trim()
          : 'Sin bodega',
        transferencia_id: transfer?.id ?? null,
        transferencia_codigo: transfer?.codigo ?? null,
        tiene_transferencia: Boolean(transfer),
        detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
      };
    });
  }

  private async prepareDetails(
    manager: EntityManager,
    details: OrdenCompraDetalleDto[],
    warehouseId: string,
  ) {
    const out: Array<{
      producto: Producto;
      cantidad: number;
      costoUnitario: number;
      descuento: number;
      porcentajeDescuento: number;
      ivaPorcentaje: number;
      subtotal: number;
      ivaTotal: number;
      total: number;
      observacion: string | null;
    }> = [];

    for (const detail of details) {
      const product = await manager.findOne(Producto, {
        where: { id: detail.producto_id, is_deleted: false },
      });
      if (!product) {
        throw new BadRequestException(
          'Uno de los materiales seleccionados no existe.',
        );
      }
      if (product.es_servicio) {
        throw new BadRequestException(
          `El material ${product.nombre} esta marcado como servicio y no puede usarse en una orden de compra.`,
        );
      }

      const cantidad = this.toNumber(detail.cantidad, 0);
      if (!(cantidad > 0)) {
        throw new BadRequestException(
          `La cantidad del material ${product.nombre} debe ser mayor a cero.`,
        );
      }

      const costoUnitario = this.toNumber(
        detail.costo_unitario,
        this.toNumber(product.costo_promedio ?? product.ultimo_costo, 0),
      );
      const descuento = this.toNumber(detail.descuento, 0);
      const porcentajeDescuento = this.toNumber(detail.porcentaje_descuento, 0);
      const ivaPorcentaje = this.toNumber(detail.iva_porcentaje, 15);

      const bruto = cantidad * costoUnitario;
      const descuentoCalculado =
        descuento > 0 ? descuento : bruto * (porcentajeDescuento / 100);
      const subtotal = Math.max(0, bruto - descuentoCalculado);
      const ivaTotal = subtotal * (ivaPorcentaje / 100);
      const total = subtotal + ivaTotal;

      out.push({
        producto: product,
        cantidad,
        costoUnitario,
        descuento: descuentoCalculado,
        porcentajeDescuento,
        ivaPorcentaje,
        subtotal,
        ivaTotal,
        total,
        observacion: this.toText(detail.observacion) || null,
      });
    }

    if (!warehouseId) {
      throw new BadRequestException(
        'No se pudo resolver la bodega destino de la orden de compra.',
      );
    }

    return out;
  }

  private calculateTotals(details: Awaited<ReturnType<typeof this.prepareDetails>>) {
    return details.reduce<Totals>(
      (acc, detail) => {
        acc.subtotal += detail.subtotal;
        acc.descuentoTotal += detail.descuento;
        acc.ivaTotal += detail.ivaTotal;
        acc.total += detail.total;
        return acc;
      },
      { subtotal: 0, descuentoTotal: 0, ivaTotal: 0, total: 0 },
    );
  }

  private async resolveDefaultPurchaseWarehouseId(manager: EntityManager) {
    const warehouse =
      (await manager.findOne(Bodega, {
        where: { is_deleted: false, es_default_compra: true },
      })) ||
      (await manager.findOne(Bodega, {
        where: { is_deleted: false, es_principal: true },
      })) ||
      (await manager.findOne(Bodega, {
        where: { is_deleted: false },
        order: { created_at: 'ASC' },
      }));
    return warehouse?.id || null;
  }

  private async generateCode(manager: EntityManager) {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtext('kpi_inventory.tb_orden_compra.codigo')::bigint)`,
    );
    const [{ max_number: maxNumber = 0 } = {}] = await manager.query(`
      SELECT COALESCE(MAX(code_number), 0) AS max_number
      FROM (
        SELECT
          CASE
            WHEN codigo ~ '^JCTI-OC[0-9]+$'
              THEN substring(codigo from '^JCTI-OC([0-9]+)$')::bigint
            WHEN codigo ~ '^OC-[A-Z][0-9]{5}$'
              THEN (
                (ascii(upper(substring(codigo from '^OC-([A-Z])[0-9]{5}$'))) - ascii('A'))::bigint * 99999
              ) + substring(codigo from '^OC-[A-Z]([0-9]{5})$')::bigint
            ELSE 0
          END AS code_number
        FROM kpi_inventory.tb_orden_compra
        WHERE is_deleted = false
          AND (
            codigo ~ '^JCTI-OC[0-9]+$'
            OR codigo ~ '^OC-[A-Z][0-9]{5}$'
          )
      ) ranked_codes
    `);
    const nextNumber = Number(maxNumber) + 1;
    return `JCTI-OC${String(nextNumber).padStart(6, '0')}`;
  }

  private async generateReference(manager: EntityManager) {
    const rows = await manager.find(OrdenCompra, {
      where: { is_deleted: false } as any,
      select: { referencia: true } as any,
      take: 200,
      order: { created_at: 'DESC' } as any,
    });
    const maxNumber = rows.reduce((max, item: any) => {
      const match = /^IB-(\d{8})$/i.exec(String(item?.referencia || '').trim());
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);
    return `IB-${String(maxNumber + 1).padStart(8, '0')}`;
  }

  private resolveUserName(dto: CreateOrdenCompraDto | UpdateOrdenCompraDto) {
    return this.toText(dto.updated_by) || this.toText(dto.created_by) || 'SYSTEM';
  }

  private toText(value: unknown) {
    return String(value ?? '').trim();
  }

  private toNumber(value: unknown, fallback = 0) {
    const raw = Number(value);
    return Number.isFinite(raw) ? raw : fallback;
  }

  private toFixedText(value: number, decimals: number) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '0';
  }
}
