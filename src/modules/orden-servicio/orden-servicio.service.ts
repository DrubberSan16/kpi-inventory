import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, ILike, Repository } from 'typeorm';
import {
  MaintenanceEquipo,
  OrdenServicio,
  OrdenServicioDet,
  OrdenServicioEquipo,
  Producto,
  Tercero,
} from '../entities';
import {
  CreateOrdenServicioDto,
  MarkOrdenServicioRealizadoDto,
  OrdenServicioDetalleDto,
  OrdenServicioQueryDto,
  UpdateOrdenServicioDto,
} from './orden-servicio.dto';

type Totals = {
  subtotal: number;
  descuentoTotal: number;
  subtotalConDescuento: number;
  ivaTotal: number;
  total: number;
};

type RequestActorContext = {
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  email?: string | null;
};

@Injectable()
export class OrdenServicioService implements OnModuleInit {
  private readonly logger = new Logger(OrdenServicioService.name);

  constructor(
    @InjectRepository(OrdenServicio)
    private readonly ordenRepo: Repository<OrdenServicio>,
    @InjectRepository(OrdenServicioDet)
    private readonly detalleRepo: Repository<OrdenServicioDet>,
    @InjectRepository(OrdenServicioEquipo)
    private readonly ordenEquipoRepo: Repository<OrdenServicioEquipo>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(Tercero)
    private readonly terceroRepo: Repository<Tercero>,
    @InjectRepository(MaintenanceEquipo)
    private readonly maintenanceEquipoRepo: Repository<MaintenanceEquipo>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private get securityServiceUrl() {
    return String(
      this.configService.get('SECURITY_SERVICE_URL') ||
        this.configService.get('KPI_SECURITY_URL') ||
        '',
    )
      .trim()
      .replace(/\/$/, '');
  }

  private queueTransactionLog(payload: {
    traceId: string;
    description: string;
    createdBy?: string | null;
    status?: string;
  }) {
    void this.writeTransactionLog(payload);
  }

  private async writeTransactionLog(payload: {
    traceId: string;
    description: string;
    createdBy?: string | null;
    status?: string;
  }) {
    if (!this.securityServiceUrl) return;
    try {
      await fetch(`${this.securityServiceUrl}/log-transacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moduleMicroservice: 'kpi_inventory',
          status: payload.status ?? 'SUCCESS',
          typeLog: 'SERVICE_ORDER_FLOW',
          description: `[TRACE:${payload.traceId}] ${payload.description}`,
          createdBy: payload.createdBy ?? null,
        }),
      });
    } catch (error: any) {
      this.logger.warn(
        `No se pudo registrar log transaccional de orden de servicio: ${error?.message ?? 'desconocido'}`,
      );
    }
  }

  async onModuleInit() {
    await this.ensureSchema();
  }

  async findAll(query: OrdenServicioQueryDto) {
    const page = Number(query.page || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit || 10)));
    const where: any = { is_deleted: false };
    if (query.estado) where.estado = this.toText(query.estado).toUpperCase();
    if (query.proveedor_id) where.proveedor_id = query.proveedor_id;

    if (query.search) {
      const search = this.toText(query.search);
      const [byCode, byProvider, byEmitter, byDelivery] = await Promise.all([
        this.ordenRepo.find({
          where: { ...where, codigo: ILike(`%${search}%`) },
          skip: (page - 1) * limit,
          take: limit,
          order: { fecha_emision: 'DESC', created_at: 'DESC' },
        }),
        this.ordenRepo.find({
          where: { ...where, proveedor_nombre: ILike(`%${search}%`) },
          skip: (page - 1) * limit,
          take: limit,
          order: { fecha_emision: 'DESC', created_at: 'DESC' },
        }),
        this.ordenRepo.find({
          where: { ...where, emitido_por_nombre: ILike(`%${search}%`) },
          skip: (page - 1) * limit,
          take: limit,
          order: { fecha_emision: 'DESC', created_at: 'DESC' },
        }),
        this.ordenRepo.find({
          where: { ...where, lugar_entrega: ILike(`%${search}%`) },
          skip: (page - 1) * limit,
          take: limit,
          order: { fecha_emision: 'DESC', created_at: 'DESC' },
        }),
      ]);

      const deduped = new Map<string, OrdenServicio>();
      [...byCode, ...byProvider, ...byEmitter, ...byDelivery].forEach((item) =>
        deduped.set(item.id, item),
      );
      const data = await this.hydrateOrders([...deduped.values()]);
      return {
        data,
        pagination: {
          page,
          limit,
          total: data.length,
          totalPages: Math.max(1, Math.ceil(data.length / limit)),
        },
      };
    }

    const [rows, total] = await this.ordenRepo.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { fecha_emision: 'DESC', created_at: 'DESC' },
    });

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

  async findOne(id: string) {
    const order = await this.ordenRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!order) {
      throw new NotFoundException('La orden de servicio no existe.');
    }
    const [hydrated] = await this.hydrateOrders([order], true);
    return hydrated;
  }

  async create(dto: CreateOrdenServicioDto, actor?: RequestActorContext | null) {
    const traceId = randomUUID();
    const createdBy = this.resolveUserName(dto, actor);
    this.queueTransactionLog({
      traceId,
      createdBy,
      description: 'Inicio de registro de orden de servicio.',
    });
    try {
      const result = await this.dataSource.transaction(async (manager) =>
        this.saveOrder(manager, dto, undefined, actor, traceId),
      );
      this.queueTransactionLog({
        traceId,
        createdBy,
        description: `Orden de servicio ${this.toText((result as any)?.codigo) || 'sin-codigo'} registrada correctamente.`,
      });
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy,
        status: 'ERROR',
        description: `Fallo al registrar orden de servicio: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateOrdenServicioDto,
    actor?: RequestActorContext | null,
  ) {
    const traceId = randomUUID();
    const createdBy = this.resolveUserName(dto, actor);
    this.queueTransactionLog({
      traceId,
      createdBy,
      description: `Inicio de actualizacion de orden de servicio ${id}.`,
    });
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const current = await manager.findOne(OrdenServicio, {
          where: { id, is_deleted: false },
        });
        if (!current) {
          throw new NotFoundException('La orden de servicio no existe.');
        }

        const details = await manager.find(OrdenServicioDet, {
          where: { orden_servicio_id: id, is_deleted: false },
        });
        if (details.length) {
          details.forEach((item) => {
            item.is_deleted = true;
            item.deleted_at = new Date();
            item.deleted_by = this.resolveUserName(dto);
          });
          await manager.save(OrdenServicioDet, details);
        }

        const linkedEquipments = await manager.find(OrdenServicioEquipo, {
          where: { orden_servicio_id: id, is_deleted: false },
        });
        if (linkedEquipments.length) {
          linkedEquipments.forEach((item) => {
            item.is_deleted = true;
            item.deleted_at = new Date();
            item.deleted_by = this.resolveUserName(dto, actor);
          });
          await manager.save(OrdenServicioEquipo, linkedEquipments);
        }

        return this.saveOrder(manager, dto, current, actor, traceId);
      });
      this.queueTransactionLog({
        traceId,
        createdBy,
        description: `Orden de servicio ${this.toText((result as any)?.codigo) || id} actualizada correctamente.`,
      });
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy,
        status: 'ERROR',
        description: `Fallo al actualizar orden de servicio ${id}: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async markServicePerformed(
    id: string,
    dto: MarkOrdenServicioRealizadoDto,
    actor?: RequestActorContext | null,
  ) {
    if (dto.servicio_realizado === false) {
      throw new BadRequestException(
        'La orden solo puede marcarse como servicio realizado.',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(OrdenServicio, {
        where: { id, is_deleted: false },
      });
      if (!current) {
        throw new NotFoundException('La orden de servicio no existe.');
      }

      if (current.servicio_realizado) {
        const [hydrated] = await this.hydrateOrdersWithManager(
          manager,
          [current],
          true,
        );
        return hydrated;
      }

      const linkedEquipments = await manager.find(OrdenServicioEquipo, {
        where: { orden_servicio_id: id, is_deleted: false },
      });
      const actorName = this.resolveActorLabel(actor) ?? this.resolveUserName({}, actor);
      const actorEmail = this.normalizeEmail(actor?.email);
      const performedDate = this.currentAppDateString();

      current.servicio_realizado = true;
      current.servicio_realizado_at = new Date();
      current.servicio_realizado_by = actorName;
      current.servicio_realizado_by_email = actorEmail;
      current.estado = 'SERVICIO_REALIZADO';
      current.updated_by = actorName;
      await manager.save(OrdenServicio, current);

      if (linkedEquipments.length) {
        const equipmentIds = linkedEquipments.map((item) => item.equipo_id);
        const equipmentRows = await manager.find(MaintenanceEquipo, {
          where: equipmentIds.map((equipoId) => ({
            id: equipoId,
            is_deleted: false,
          })),
        });
        for (const equipment of equipmentRows) {
          if (!equipment.es_servicio) continue;
          const intervalValue = this.toNumber(
            equipment.intervalo_mantenimiento_valor,
            0,
          );
          if (!(intervalValue > 0)) continue;
          const intervalUnit = this.normalizeIntervalUnit(
            equipment.intervalo_mantenimiento_unidad,
          );
          equipment.ultimo_servicio_fecha = performedDate;
          equipment.proximo_servicio_fecha = this.addIntervalDateOnly(
            performedDate,
            intervalUnit,
            intervalValue,
          );
          equipment.ultimo_servicio_orden_id = current.id;
          equipment.ultimo_servicio_orden_codigo = current.codigo;
          equipment.updated_by = actorName;
          await manager.save(MaintenanceEquipo, equipment);
        }
        await manager.query(
          `
            UPDATE kpi_maintenance.tb_alerta_mantenimiento
            SET estado = 'CERRADA',
                resolved_at = now(),
                ultima_evaluacion_at = now()
            WHERE is_deleted = false
              AND origen = 'SYSTEM'
              AND estado IN ('ABIERTA', 'EN_PROCESO')
              AND equipo_id = ANY($1::uuid[])
              AND referencia LIKE 'EQUIPO_SERVICIO:%'
          `,
          [equipmentIds],
        );
      }

      const [hydrated] = await this.hydrateOrdersWithManager(
        manager,
        [current],
        true,
      );
      return hydrated;
    });
  }

  async remove(id: string, deletedBy?: string) {
    return this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(OrdenServicio, {
        where: { id, is_deleted: false },
      });
      if (!current) {
        throw new NotFoundException('La orden de servicio no existe.');
      }

      current.is_deleted = true;
      current.deleted_at = new Date();
      current.deleted_by = deletedBy ?? null;
      current.estado = 'ANULADA';
      await manager.save(OrdenServicio, current);

      const details = await manager.find(OrdenServicioDet, {
        where: { orden_servicio_id: id, is_deleted: false },
      });
      if (details.length) {
        details.forEach((item) => {
          item.is_deleted = true;
          item.deleted_at = new Date();
          item.deleted_by = deletedBy ?? null;
        });
        await manager.save(OrdenServicioDet, details);
      }

      const linkedEquipments = await manager.find(OrdenServicioEquipo, {
        where: { orden_servicio_id: id, is_deleted: false },
      });
      if (linkedEquipments.length) {
        linkedEquipments.forEach((item) => {
          item.is_deleted = true;
          item.deleted_at = new Date();
          item.deleted_by = deletedBy ?? null;
        });
        await manager.save(OrdenServicioEquipo, linkedEquipments);
      }

      return {
        message: `Orden de servicio ${current.codigo} eliminada correctamente`,
      };
    });
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
      const linkedEquipments = await manager
        .createQueryBuilder()
        .delete()
        .from(OrdenServicioEquipo)
        .execute();
      const details = await manager
        .createQueryBuilder()
        .delete()
        .from(OrdenServicioDet)
        .execute();
      const orders = await manager
        .createQueryBuilder()
        .delete()
        .from(OrdenServicio)
        .execute();

      return {
        equipos: Number(linkedEquipments.affected || 0),
        detalles: Number(details.affected || 0),
        ordenes: Number(orders.affected || 0),
      };
    });

    return {
      message: `Eliminacion real masiva ejecutada correctamente (${result.ordenes} ordenes de servicio).`,
      affected: result.ordenes,
      details: result,
    };
  }

  private async saveOrder(
    manager: EntityManager,
    dto: CreateOrdenServicioDto,
    current?: OrdenServicio,
    actor?: RequestActorContext | null,
    traceId?: string,
  ) {
    const userName = this.resolveUserName(dto, actor);
    const details = Array.isArray(dto.detalles) ? dto.detalles : [];
    const requestedEquipmentIds = this.normalizeUuidArray(dto.equipo_ids);
    if (!details.length) {
      throw new BadRequestException(
        'Debes agregar al menos un servicio a la orden.',
      );
    }

    const supplierId = this.toText(dto.proveedor_id) || current?.proveedor_id || '';
    if (!supplierId) {
      throw new BadRequestException('Debes seleccionar a quién va dirigida la orden.');
    }

    const supplier = await manager.findOne(Tercero, {
      where: { id: supplierId, is_deleted: false },
    });
    if (!supplier) {
      throw new BadRequestException('El destinatario seleccionado no existe.');
    }

    const emitterUserId =
      this.toText(dto.emitido_por_user_id) || current?.emitido_por_user_id || '';
    const emitterName =
      this.toText(dto.emitido_por_nombre) || current?.emitido_por_nombre || '';
    if (!emitterUserId || !emitterName) {
      throw new BadRequestException('Debes seleccionar quién emite la orden de servicio.');
    }

    const preparedDetails = await this.prepareDetails(manager, details);
    const linkedEquipments = await this.prepareLinkedEquipments(
      manager,
      requestedEquipmentIds,
    );
    const totals = this.calculateTotals(preparedDetails);
    if (traceId) {
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Validacion completada para orden de servicio. Servicios=${preparedDetails.length}, equipos=${linkedEquipments.length}.`,
      });
    }
    const entity =
      current ??
      manager.create(OrdenServicio, {
        codigo: await this.generateCode(manager),
        created_by: userName,
      });

    if (current) {
      entity.codigo = this.toText(dto.codigo) || entity.codigo;
    }
    entity.fecha_emision =
      this.normalizeDateOnly(dto.fecha_emision) ||
      this.normalizeDateOnly(current?.fecha_emision) ||
      this.currentAppDateString();
    entity.proveedor_id = supplier.id;
    entity.proveedor_identificacion = supplier.identificacion ?? null;
    entity.proveedor_nombre =
      supplier.razon_social ?? supplier.nombre_comercial ?? null;
    entity.emitido_por_user_id = emitterUserId;
    entity.emitido_por_nombre = emitterName;
    entity.lugar_entrega =
      this.toText(dto.lugar_entrega) || current?.lugar_entrega || null;
    entity.forma_pago = this.toText(dto.forma_pago) || current?.forma_pago || null;
    entity.observacion = this.toText(dto.observacion) || null;
    entity.moneda = this.toText(dto.moneda) || current?.moneda || 'USD';
    entity.subtotal = this.toFixedText(totals.subtotal, 4);
    entity.descuento_total = this.toFixedText(totals.descuentoTotal, 4);
    entity.subtotal_con_descuento = this.toFixedText(
      totals.subtotalConDescuento,
      4,
    );
    entity.iva_total = this.toFixedText(totals.ivaTotal, 4);
    entity.total = this.toFixedText(totals.total, 4);
    entity.estado =
      current?.estado === 'ANULADA'
        ? 'ANULADA'
        : current?.servicio_realizado
          ? 'SERVICIO_REALIZADO'
          : 'EMITIDA';
    entity.servicio_realizado = Boolean(current?.servicio_realizado);
    entity.servicio_realizado_at = current?.servicio_realizado_at ?? null;
    entity.servicio_realizado_by = current?.servicio_realizado_by ?? null;
    entity.servicio_realizado_by_email =
      current?.servicio_realizado_by_email ?? null;
    entity.updated_by = userName;

    const savedOrder = await manager.save(OrdenServicio, entity);
    if (traceId) {
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Cabecera persistida para orden de servicio ${savedOrder.codigo}.`,
      });
    }
    const detailEntities = preparedDetails.map((detail) =>
      manager.create(OrdenServicioDet, {
        orden_servicio_id: savedOrder.id,
        producto_id: detail.producto.id,
        codigo_producto: detail.producto.codigo,
        nombre_producto: detail.producto.nombre,
        cantidad: this.toFixedText(detail.cantidad, 6),
        costo_unitario: this.toFixedText(detail.costoUnitario, 4),
        descuento: this.toFixedText(detail.descuento, 4),
        porcentaje_descuento: this.toFixedText(detail.porcentajeDescuento, 4),
        iva_porcentaje: this.toFixedText(detail.ivaPorcentaje, 4),
        subtotal: this.toFixedText(detail.subtotal, 4),
        iva_total: this.toFixedText(detail.ivaTotal, 4),
        total: this.toFixedText(detail.total, 4),
        observacion: detail.observacion,
        created_by: current?.created_by ?? userName,
        updated_by: userName,
      }),
    );
    await manager.save(OrdenServicioDet, detailEntities);
    if (linkedEquipments.length) {
      await manager.save(
        OrdenServicioEquipo,
        linkedEquipments.map((equipment) =>
          manager.create(OrdenServicioEquipo, {
            orden_servicio_id: savedOrder.id,
            equipo_id: equipment.id,
            equipo_codigo: equipment.codigo ?? null,
            equipo_nombre:
              equipment.nombre_real ?? equipment.nombre ?? equipment.codigo ?? null,
            created_by: current?.created_by ?? userName,
            updated_by: userName,
          }),
        ),
      );
    }
    if (traceId) {
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Detalle persistido para orden de servicio ${savedOrder.codigo}. Filas=${detailEntities.length}.`,
      });
    }

    const [hydrated] = await this.hydrateOrdersWithManager(
      manager,
      [savedOrder],
      true,
    );
    return hydrated;
  }

  private async hydrateOrders(rows: OrdenServicio[], includeDetails = false) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const [details, linkedEquipments] = await Promise.all([
      this.detalleRepo.find({
        where: ids.map((ordenId) => ({ orden_servicio_id: ordenId, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
      this.ordenEquipoRepo.find({
        where: ids.map((ordenId) => ({ orden_servicio_id: ordenId, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
    ]);
    const detailMap = details.reduce((acc, item) => {
      (acc[item.orden_servicio_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, OrdenServicioDet[]>);
    const equipmentMap = linkedEquipments.reduce((acc, item) => {
      (acc[item.orden_servicio_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, OrdenServicioEquipo[]>);

    return rows.map((item) => ({
      ...item,
      proveedor_label: item.proveedor_nombre || 'Sin destinatario',
      emitido_por_label: item.emitido_por_nombre || 'Sin emisor',
      equipos: equipmentMap[item.id] ?? [],
      equipos_label: (equipmentMap[item.id] ?? [])
        .map((equipment) => equipment.equipo_nombre || equipment.equipo_codigo || equipment.equipo_id)
        .filter(Boolean),
      detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
    }));
  }

  private async hydrateOrdersWithManager(
    manager: EntityManager,
    rows: OrdenServicio[],
    includeDetails = false,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const [details, linkedEquipments] = await Promise.all([
      manager.find(OrdenServicioDet, {
        where: ids.map((ordenId) => ({ orden_servicio_id: ordenId, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
      manager.find(OrdenServicioEquipo, {
        where: ids.map((ordenId) => ({ orden_servicio_id: ordenId, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
    ]);
    const detailMap = details.reduce((acc, item) => {
      (acc[item.orden_servicio_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, OrdenServicioDet[]>);
    const equipmentMap = linkedEquipments.reduce((acc, item) => {
      (acc[item.orden_servicio_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, OrdenServicioEquipo[]>);

    return rows.map((item) => ({
      ...item,
      proveedor_label: item.proveedor_nombre || 'Sin destinatario',
      emitido_por_label: item.emitido_por_nombre || 'Sin emisor',
      equipos: equipmentMap[item.id] ?? [],
      equipos_label: (equipmentMap[item.id] ?? [])
        .map((equipment) => equipment.equipo_nombre || equipment.equipo_codigo || equipment.equipo_id)
        .filter(Boolean),
      detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
    }));
  }

  private async prepareDetails(
    manager: EntityManager,
    details: OrdenServicioDetalleDto[],
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
          'Uno de los servicios seleccionados no existe.',
        );
      }
      if (!product.es_servicio) {
        throw new BadRequestException(
          `El material ${product.nombre} no esta marcado como servicio.`,
        );
      }

      const cantidad = this.toNumber(detail.cantidad, 0);
      if (!(cantidad > 0)) {
        throw new BadRequestException(
          `La cantidad del servicio ${product.nombre} debe ser mayor a cero.`,
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
      const subtotal = Math.max(0, bruto);
      const subtotalConDescuento = Math.max(0, subtotal - descuentoCalculado);
      const ivaTotal = subtotalConDescuento * (ivaPorcentaje / 100);
      const total = subtotalConDescuento + ivaTotal;

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

    return out;
  }

  private calculateTotals(details: Awaited<ReturnType<typeof this.prepareDetails>>) {
    return details.reduce<Totals>(
      (acc, detail) => {
        acc.subtotal += detail.subtotal;
        acc.descuentoTotal += detail.descuento;
        acc.subtotalConDescuento += Math.max(0, detail.subtotal - detail.descuento);
        acc.ivaTotal += detail.ivaTotal;
        acc.total += detail.total;
        return acc;
      },
      {
        subtotal: 0,
        descuentoTotal: 0,
        subtotalConDescuento: 0,
        ivaTotal: 0,
        total: 0,
      },
    );
  }

  private async generateCode(manager: EntityManager) {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtext('kpi_inventory.tb_orden_servicio.codigo')::bigint)`,
    );
    const [{ max_number: maxNumber = 0 } = {}] = await manager.query(`
      SELECT COALESCE(MAX(code_number), 0) AS max_number
      FROM (
        SELECT
          CASE
            WHEN codigo ~ '^JCTI-OS[0-9]+$'
              THEN substring(codigo from '^JCTI-OS([0-9]+)$')::bigint
            WHEN codigo ~ '^RJCTI-[0-9]{4}-[A-Z][0-9]{7}$'
              THEN (
                (ascii(upper(substring(codigo from '^RJCTI-[0-9]{4}-([A-Z])[0-9]{7}$'))) - ascii('A'))::bigint * 9999999
              ) + substring(codigo from '^RJCTI-[0-9]{4}-[A-Z]([0-9]{7})$')::bigint
            ELSE 0
          END AS code_number
        FROM kpi_inventory.tb_orden_servicio
        WHERE is_deleted = false
          AND (
            codigo ~ '^JCTI-OS[0-9]+$'
            OR codigo ~ '^RJCTI-[0-9]{4}-[A-Z][0-9]{7}$'
          )
      ) ranked_codes
    `);
    const nextNumber = Number(maxNumber) + 1;
    return `JCTI-OS${String(nextNumber).padStart(6, '0')}`;
  }

  private resolveUserName(
    dto: Partial<CreateOrdenServicioDto | UpdateOrdenServicioDto>,
    actor?: RequestActorContext | null,
  ) {
    return (
      this.toText(dto.updated_by) ||
      this.toText(dto.created_by) ||
      this.resolveActorLabel(actor) ||
      'SYSTEM'
    );
  }

  private resolveActorLabel(actor?: RequestActorContext | null) {
    return (
      this.toText(actor?.displayName) ||
      this.toText(actor?.username) ||
      null
    );
  }

  private normalizeEmail(value: unknown) {
    const normalized = this.toText(value).toLowerCase();
    return normalized || null;
  }

  private normalizeUuidArray(values: unknown) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map((item) => this.toText(item)).filter(Boolean))];
  }

  private normalizeIntervalUnit(value: unknown) {
    const raw = this.toText(value).toUpperCase();
    if (['SEMANA', 'SEMANAS', 'WEEK', 'WEEKS'].includes(raw)) return 'SEMANAS';
    if (['ANIO', 'ANIOS', 'AÑO', 'AÑOS', 'YEAR', 'YEARS'].includes(raw)) {
      return 'ANIOS';
    }
    return 'DIAS';
  }

  private addIntervalDateOnly(
    dateInput: string,
    intervalUnit: string,
    intervalValue: number,
  ) {
    const base = new Date(`${dateInput}T00:00:00`);
    const value = Math.max(0, Math.round(this.toNumber(intervalValue, 0)));
    const unit = this.normalizeIntervalUnit(intervalUnit);
    if (!value || Number.isNaN(base.getTime())) return dateInput;
    if (unit === 'SEMANAS') {
      base.setDate(base.getDate() + value * 7);
    } else if (unit === 'ANIOS') {
      base.setFullYear(base.getFullYear() + value);
    } else {
      base.setDate(base.getDate() + value);
    }
    return base.toISOString().slice(0, 10);
  }

  private async prepareLinkedEquipments(
    manager: EntityManager,
    equipmentIds: string[],
  ) {
    if (!equipmentIds.length) return [];
    const equipments = await manager.find(MaintenanceEquipo, {
      where: equipmentIds.map((equipoId) => ({
        id: equipoId,
        is_deleted: false,
      })),
    });
    const foundIds = new Set(equipments.map((item) => item.id));
    const missing = equipmentIds.filter((item) => !foundIds.has(item));
    if (missing.length) {
      throw new BadRequestException(
        'Uno de los equipos seleccionados para la orden de servicio no existe.',
      );
    }
    return equipments;
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

  private normalizeDateOnly(value: unknown) {
    const text = this.toText(value);
    if (!text) return '';
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    return match?.[1] ?? '';
  }

  private currentAppDateString() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Guayaquil',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const year = parts.find((item) => item.type === 'year')?.value ?? '';
    const month = parts.find((item) => item.type === 'month')?.value ?? '';
    const day = parts.find((item) => item.type === 'day')?.value ?? '';
    return `${year}-${month}-${day}`;
  }

  private async ensureSchema() {
    await this.dataSource.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS kpi_inventory.tb_orden_servicio (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL DEFAULT 'ACTIVE',
        created_at timestamp without time zone NOT NULL DEFAULT now(),
        updated_at timestamp without time zone NOT NULL DEFAULT now(),
        created_by text NULL,
        updated_by text NULL,
        is_deleted boolean NOT NULL DEFAULT false,
        deleted_at timestamp without time zone NULL,
        deleted_by text NULL,
        codigo varchar(40) NOT NULL,
        fecha_emision date NOT NULL DEFAULT CURRENT_DATE,
        proveedor_id uuid NULL,
        proveedor_identificacion varchar(30) NULL,
        proveedor_nombre varchar(200) NULL,
        emitido_por_user_id varchar(80) NULL,
        emitido_por_nombre varchar(200) NULL,
        lugar_entrega varchar(200) NULL,
        forma_pago text NULL,
        observacion text NULL,
        moneda varchar(10) NOT NULL DEFAULT 'USD',
        subtotal numeric(18,4) NOT NULL DEFAULT 0,
        descuento_total numeric(18,4) NOT NULL DEFAULT 0,
        subtotal_con_descuento numeric(18,4) NOT NULL DEFAULT 0,
        iva_total numeric(18,4) NOT NULL DEFAULT 0,
        total numeric(18,4) NOT NULL DEFAULT 0,
        estado text NOT NULL DEFAULT 'EMITIDA',
        servicio_realizado boolean NOT NULL DEFAULT false,
        servicio_realizado_at timestamp without time zone NULL,
        servicio_realizado_by varchar(200) NULL,
        servicio_realizado_by_email varchar(200) NULL
      )
    `);
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS kpi_inventory.tb_orden_servicio_det (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL DEFAULT 'ACTIVE',
        created_at timestamp without time zone NOT NULL DEFAULT now(),
        updated_at timestamp without time zone NOT NULL DEFAULT now(),
        created_by text NULL,
        updated_by text NULL,
        is_deleted boolean NOT NULL DEFAULT false,
        deleted_at timestamp without time zone NULL,
        deleted_by text NULL,
        orden_servicio_id uuid NOT NULL,
        producto_id uuid NOT NULL,
        codigo_producto varchar(60) NULL,
        nombre_producto varchar(200) NOT NULL,
        cantidad numeric(18,6) NOT NULL DEFAULT 0,
        costo_unitario numeric(14,4) NOT NULL DEFAULT 0,
        descuento numeric(18,4) NOT NULL DEFAULT 0,
        porcentaje_descuento numeric(8,4) NOT NULL DEFAULT 0,
        iva_porcentaje numeric(8,4) NOT NULL DEFAULT 15,
        subtotal numeric(18,4) NOT NULL DEFAULT 0,
        iva_total numeric(18,4) NOT NULL DEFAULT 0,
        total numeric(18,4) NOT NULL DEFAULT 0,
        observacion text NULL
      )
    `);
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS kpi_inventory.tb_orden_servicio_equipo (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL DEFAULT 'ACTIVE',
        created_at timestamp without time zone NOT NULL DEFAULT now(),
        updated_at timestamp without time zone NOT NULL DEFAULT now(),
        created_by text NULL,
        updated_by text NULL,
        is_deleted boolean NOT NULL DEFAULT false,
        deleted_at timestamp without time zone NULL,
        deleted_by text NULL,
        orden_servicio_id uuid NOT NULL,
        equipo_id uuid NOT NULL,
        equipo_codigo varchar(60) NULL,
        equipo_nombre varchar(200) NULL
      )
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_orden_servicio_codigo
      ON kpi_inventory.tb_orden_servicio (codigo)
      WHERE is_deleted = false
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_orden_servicio_proveedor
      ON kpi_inventory.tb_orden_servicio (proveedor_id)
      WHERE is_deleted = false
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_orden_servicio_det_orden
      ON kpi_inventory.tb_orden_servicio_det (orden_servicio_id)
      WHERE is_deleted = false
    `);
    await this.dataSource.query(`
      CREATE INDEX IF NOT EXISTS idx_tb_orden_servicio_equipo_orden
      ON kpi_inventory.tb_orden_servicio_equipo (orden_servicio_id)
      WHERE is_deleted = false
    `);
    await this.dataSource.query(`
      ALTER TABLE kpi_inventory.tb_orden_servicio
      ADD COLUMN IF NOT EXISTS servicio_realizado boolean NOT NULL DEFAULT false
    `);
    await this.dataSource.query(`
      ALTER TABLE kpi_inventory.tb_orden_servicio
      ADD COLUMN IF NOT EXISTS servicio_realizado_at timestamp without time zone NULL
    `);
    await this.dataSource.query(`
      ALTER TABLE kpi_inventory.tb_orden_servicio
      ADD COLUMN IF NOT EXISTS servicio_realizado_by varchar(200) NULL
    `);
    await this.dataSource.query(`
      ALTER TABLE kpi_inventory.tb_orden_servicio
      ADD COLUMN IF NOT EXISTS servicio_realizado_by_email varchar(200) NULL
    `);
    await this.dataSource.query(`
      ALTER TABLE kpi_inventory.tb_orden_servicio
      ALTER COLUMN fecha_emision TYPE date
      USING (
        CASE
          WHEN fecha_emision IS NULL THEN NULL
          ELSE (
            CASE
              WHEN EXTRACT(HOUR FROM CAST(fecha_emision AS timestamp)) = 19
               AND EXTRACT(MINUTE FROM CAST(fecha_emision AS timestamp)) = 0
               AND FLOOR(EXTRACT(SECOND FROM CAST(fecha_emision AS timestamp))) = 0
                THEN (CAST(fecha_emision AS timestamp) + INTERVAL '5 hours')::date
              ELSE CAST(fecha_emision AS timestamp)::date
            END
          )
        END
      )
    `);
    await this.dataSource.query(`
      ALTER TABLE kpi_inventory.tb_orden_servicio
      ALTER COLUMN fecha_emision SET DEFAULT CURRENT_DATE
    `);
  }
}
