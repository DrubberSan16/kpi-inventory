import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, ILike, Repository } from 'typeorm';
import {
  OrdenServicio,
  OrdenServicioDet,
  Producto,
  Tercero,
} from '../entities';
import {
  CreateOrdenServicioDto,
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

@Injectable()
export class OrdenServicioService implements OnModuleInit {
  constructor(
    @InjectRepository(OrdenServicio)
    private readonly ordenRepo: Repository<OrdenServicio>,
    @InjectRepository(OrdenServicioDet)
    private readonly detalleRepo: Repository<OrdenServicioDet>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(Tercero)
    private readonly terceroRepo: Repository<Tercero>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

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

  async create(dto: CreateOrdenServicioDto) {
    return this.dataSource.transaction(async (manager) =>
      this.saveOrder(manager, dto),
    );
  }

  async update(id: string, dto: UpdateOrdenServicioDto) {
    return this.dataSource.transaction(async (manager) => {
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

      return this.saveOrder(manager, dto, current);
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

      return {
        message: `Orden de servicio ${current.codigo} eliminada correctamente`,
      };
    });
  }

  private async saveOrder(
    manager: EntityManager,
    dto: CreateOrdenServicioDto,
    current?: OrdenServicio,
  ) {
    const userName = this.resolveUserName(dto);
    const details = Array.isArray(dto.detalles) ? dto.detalles : [];
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
    const totals = this.calculateTotals(preparedDetails);
    const entity =
      current ??
      manager.create(OrdenServicio, {
        codigo: await this.generateCode(manager),
        created_by: userName,
      });

    entity.codigo = this.toText(dto.codigo) || entity.codigo;
    entity.fecha_emision = dto.fecha_emision
      ? new Date(dto.fecha_emision)
      : current?.fecha_emision ?? new Date();
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
    entity.estado = current?.estado === 'ANULADA' ? 'ANULADA' : 'EMITIDA';
    entity.updated_by = userName;

    const savedOrder = await manager.save(OrdenServicio, entity);
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
    const details = await this.detalleRepo.find({
      where: ids.map((ordenId) => ({ orden_servicio_id: ordenId, is_deleted: false })),
      order: { created_at: 'ASC' },
    });
    const detailMap = details.reduce((acc, item) => {
      (acc[item.orden_servicio_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, OrdenServicioDet[]>);

    return rows.map((item) => ({
      ...item,
      proveedor_label: item.proveedor_nombre || 'Sin destinatario',
      emitido_por_label: item.emitido_por_nombre || 'Sin emisor',
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
    const details = await manager.find(OrdenServicioDet, {
      where: ids.map((ordenId) => ({ orden_servicio_id: ordenId, is_deleted: false })),
      order: { created_at: 'ASC' },
    });
    const detailMap = details.reduce((acc, item) => {
      (acc[item.orden_servicio_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, OrdenServicioDet[]>);

    return rows.map((item) => ({
      ...item,
      proveedor_label: item.proveedor_nombre || 'Sin destinatario',
      emitido_por_label: item.emitido_por_nombre || 'Sin emisor',
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
    const year = new Date().getFullYear();
    const rows = await manager.find(OrdenServicio, {
      where: { is_deleted: false } as any,
      select: { codigo: true } as any,
      take: 500,
      order: { created_at: 'DESC' } as any,
    });
    const maxNumber = rows.reduce((max, item: any) => {
      const match = new RegExp(`^RJCTI-${year}-(\\d{6})$`, 'i').exec(
        String(item?.codigo || '').trim(),
      );
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);
    return `RJCTI-${year}-${String(maxNumber + 1).padStart(6, '0')}`;
  }

  private resolveUserName(dto: CreateOrdenServicioDto | UpdateOrdenServicioDto) {
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
        fecha_emision timestamp without time zone NOT NULL DEFAULT now(),
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
        estado text NOT NULL DEFAULT 'EMITIDA'
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
  }
}
