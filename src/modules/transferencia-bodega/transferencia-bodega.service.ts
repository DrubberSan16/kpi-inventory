import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, ILike, Repository } from 'typeorm';
import {
  Bodega,
  Kardex,
  MovimientoInventario,
  MovimientoInventarioDet,
  OrdenCompra,
  OrdenCompraDet,
  Producto,
  StockBodega,
  TransferenciaBodega,
  TransferenciaBodegaDet,
} from '../entities';
import {
  CreateTransferenciaBodegaDto,
  TransferenciaBodegaDetalleDto,
  TransferenciaBodegaQueryDto,
} from './transferencia-bodega.dto';

@Injectable()
export class TransferenciaBodegaService {
  private readonly logger = new Logger(TransferenciaBodegaService.name);

  constructor(
    @InjectRepository(TransferenciaBodega)
    private readonly transferenciaRepo: Repository<TransferenciaBodega>,
    @InjectRepository(TransferenciaBodegaDet)
    private readonly transferenciaDetRepo: Repository<TransferenciaBodegaDet>,
    @InjectRepository(OrdenCompra)
    private readonly ordenRepo: Repository<OrdenCompra>,
    @InjectRepository(OrdenCompraDet)
    private readonly ordenDetRepo: Repository<OrdenCompraDet>,
    @InjectRepository(Bodega)
    private readonly bodegaRepo: Repository<Bodega>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(StockBodega)
    private readonly stockRepo: Repository<StockBodega>,
    @InjectRepository(MovimientoInventario)
    private readonly movimientoRepo: Repository<MovimientoInventario>,
    @InjectRepository(MovimientoInventarioDet)
    private readonly movimientoDetRepo: Repository<MovimientoInventarioDet>,
    @InjectRepository(Kardex)
    private readonly kardexRepo: Repository<Kardex>,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findAll(query: TransferenciaBodegaQueryDto) {
    const page = Number(query.page || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit || 10)));
    const where: any = { is_deleted: false };
    if (query.search) {
      const search = this.toText(query.search);
      const [byCode, byObs] = await Promise.all([
        this.transferenciaRepo.find({
          where: { ...where, codigo: ILike(`%${search}%`) },
          skip: (page - 1) * limit,
          take: limit,
          order: { fecha_transferencia: 'DESC', created_at: 'DESC' },
        }),
        this.transferenciaRepo.find({
          where: { ...where, observacion: ILike(`%${search}%`) },
          skip: (page - 1) * limit,
          take: limit,
          order: { fecha_transferencia: 'DESC', created_at: 'DESC' },
        }),
      ]);
      const deduped = new Map<string, TransferenciaBodega>();
      [...byCode, ...byObs].forEach((item) => deduped.set(item.id, item));
      const data = await this.hydrateTransfers([...deduped.values()], false);
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

    const [rows, total] = await this.transferenciaRepo.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { fecha_transferencia: 'DESC', created_at: 'DESC' },
    });
    return {
      data: await this.hydrateTransfers(rows, false),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async findOne(id: string) {
    const transfer = await this.transferenciaRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!transfer) {
      throw new NotFoundException('La transferencia no existe.');
    }
    const [hydrated] = await this.hydrateTransfers([transfer], true);
    return hydrated;
  }

  async create(dto: CreateTransferenciaBodegaDto) {
    return this.dataSource.transaction(async (manager) => {
      const userName = this.resolveUserName(dto);
      const order = await manager.findOne(OrdenCompra, {
        where: { id: dto.orden_compra_id, is_deleted: false },
      });
      if (!order) {
        throw new NotFoundException('La orden de compra seleccionada no existe.');
      }
      if (String(order.estado || '').toUpperCase() === 'TRANSFERIDA') {
        throw new BadRequestException(
          'La orden de compra ya fue transferida.',
        );
      }
      const existingTransfer = await manager.findOne(TransferenciaBodega, {
        where: { orden_compra_id: order.id, is_deleted: false },
      });
      if (existingTransfer) {
        throw new BadRequestException(
          'La orden de compra ya tiene una transferencia registrada.',
        );
      }

      const sourceWarehouseId = this.toText(order.bodega_destino_id);
      if (!sourceWarehouseId) {
        throw new BadRequestException(
          'La orden de compra no tiene una bodega origen configurada.',
        );
      }
      const destinationWarehouseId = this.toText(dto.bodega_destino_id);
      if (!destinationWarehouseId) {
        throw new BadRequestException('La bodega destino es obligatoria.');
      }
      if (sourceWarehouseId === destinationWarehouseId) {
        throw new BadRequestException(
          'La bodega destino debe ser distinta a la bodega origen.',
        );
      }

      const [sourceWarehouse, destinationWarehouse] = await Promise.all([
        manager.findOne(Bodega, {
          where: { id: sourceWarehouseId, is_deleted: false },
        }),
        manager.findOne(Bodega, {
          where: { id: destinationWarehouseId, is_deleted: false },
        }),
      ]);
      if (!sourceWarehouse || !destinationWarehouse) {
        throw new BadRequestException(
          'No se pudo resolver la bodega origen o destino de la transferencia.',
        );
      }

      const orderDetails = await manager.find(OrdenCompraDet, {
        where: { orden_compra_id: order.id, is_deleted: false },
        order: { created_at: 'ASC' },
      });
      if (!orderDetails.length) {
        throw new BadRequestException(
          'La orden de compra no tiene materiales para transferir.',
        );
      }

      const requestedDetails = this.prepareTransferDetails(
        dto.detalles,
        orderDetails,
      );
      const code = await this.generateCode(manager, 'TRB');
      const fechaTransferencia = dto.fecha_transferencia
        ? new Date(dto.fecha_transferencia)
        : new Date();

      const movementOut = await manager.save(
        MovimientoInventario,
        manager.create(MovimientoInventario, {
          tipo_movimiento: 'SALIDA',
          fecha_movimiento: fechaTransferencia,
          tipo_documento: 'TRANSFERENCIA_BODEGA',
          numero_documento: code,
          referencia: order.codigo,
          observacion: this.toText(dto.observacion) || `Transferencia ${code}`,
          bodega_origen_id: sourceWarehouse.id,
          tipo_cambio: '1',
          total_costos: '0.0000',
          estado: 'CONFIRMADO',
          created_by: userName,
          updated_by: userName,
        }),
      );

      const movementIn = await manager.save(
        MovimientoInventario,
        manager.create(MovimientoInventario, {
          tipo_movimiento: 'INGRESO',
          fecha_movimiento: fechaTransferencia,
          tipo_documento: 'TRANSFERENCIA_BODEGA',
          numero_documento: code,
          referencia: order.codigo,
          observacion: this.toText(dto.observacion) || `Transferencia ${code}`,
          bodega_destino_id: destinationWarehouse.id,
          tipo_cambio: '1',
          total_costos: '0.0000',
          estado: 'CONFIRMADO',
          created_by: userName,
          updated_by: userName,
        }),
      );

      const transfer = await manager.save(
        TransferenciaBodega,
        manager.create(TransferenciaBodega, {
          codigo: code,
          orden_compra_id: order.id,
          bodega_origen_id: sourceWarehouse.id,
          bodega_destino_id: destinationWarehouse.id,
          fecha_transferencia: fechaTransferencia,
          observacion: this.toText(dto.observacion) || null,
          estado: 'COMPLETADA',
          total_items: requestedDetails.length,
          total_cantidad: this.toFixedText(
            requestedDetails.reduce(
              (sum, item) => sum + this.toNumber(item.cantidad, 0),
              0,
            ),
            6,
          ),
          movimiento_salida_id: movementOut.id,
          movimiento_ingreso_id: movementIn.id,
          created_by: userName,
          updated_by: userName,
        }),
      );

      const changedStockIds = new Set<string>();
      let totalCost = 0;
      const transferDetailEntities: TransferenciaBodegaDet[] = [];

      for (const detail of requestedDetails) {
        const orderDetail = detail.orderDetail;
        const product = await manager.findOne(Producto, {
          where: { id: orderDetail.producto_id, is_deleted: false },
        });
        if (!product) {
          throw new BadRequestException(
            `El material ${orderDetail.nombre_producto} no existe.`,
          );
        }

        const quantity = this.toNumber(detail.cantidad, 0);
        if (!(quantity > 0)) {
          throw new BadRequestException(
            `La cantidad a transferir de ${orderDetail.nombre_producto} debe ser mayor a cero.`,
          );
        }

        const sourceStock = await this.getOrCreateStockRow(manager, {
          bodegaId: sourceWarehouse.id,
          productoId: product.id,
          costoPromedio: this.toNumber(
            orderDetail.costo_unitario,
            this.toNumber(product.costo_promedio ?? product.ultimo_costo, 0),
          ),
          userName,
        });
        const currentSourceStock = this.toNumber(sourceStock.stock_actual, 0);
        if (currentSourceStock < quantity) {
          throw new BadRequestException(
            `Stock insuficiente en ${sourceWarehouse.nombre} para ${product.nombre}. Disponible ${currentSourceStock.toFixed(
              2,
            )}, requerido ${quantity.toFixed(2)}.`,
          );
        }

        const unitCost = this.resolveUnitCost(orderDetail, product, sourceStock);
        const subtotal = quantity * unitCost;
        totalCost += subtotal;

        sourceStock.stock_actual = this.toFixedText(
          currentSourceStock - quantity,
          6,
        );
        sourceStock.updated_by = userName;
        await manager.save(StockBodega, sourceStock);
        changedStockIds.add(sourceStock.id);

        const destStock = await this.getOrCreateStockRow(manager, {
          bodegaId: destinationWarehouse.id,
          productoId: product.id,
          costoPromedio: unitCost,
          userName,
        });
        const currentDestStock = this.toNumber(destStock.stock_actual, 0);
        destStock.stock_actual = this.toFixedText(currentDestStock + quantity, 6);
        destStock.costo_promedio_bodega = this.toFixedText(unitCost, 4);
        destStock.updated_by = userName;
        await manager.save(StockBodega, destStock);
        changedStockIds.add(destStock.id);

        const outDet = await manager.save(
          MovimientoInventarioDet,
          manager.create(MovimientoInventarioDet, {
            movimiento_id: movementOut.id,
            producto_id: product.id,
            cantidad: this.toFixedText(quantity, 6),
            costo_unitario: this.toFixedText(unitCost, 4),
            subtotal_costo: this.toFixedText(subtotal, 4),
            observacion:
              this.toText(detail.observacion) ||
              this.toText(dto.observacion) ||
              `Salida por transferencia ${code}`,
            created_by: userName,
            updated_by: userName,
          }),
        );

        const inDet = await manager.save(
          MovimientoInventarioDet,
          manager.create(MovimientoInventarioDet, {
            movimiento_id: movementIn.id,
            producto_id: product.id,
            cantidad: this.toFixedText(quantity, 6),
            costo_unitario: this.toFixedText(unitCost, 4),
            subtotal_costo: this.toFixedText(subtotal, 4),
            observacion:
              this.toText(detail.observacion) ||
              this.toText(dto.observacion) ||
              `Ingreso por transferencia ${code}`,
            created_by: userName,
            updated_by: userName,
          }),
        );

        const kardexOut = await manager.save(
          Kardex,
          manager.create(Kardex, {
            fecha: fechaTransferencia,
            bodega_id: sourceWarehouse.id,
            producto_id: product.id,
            movimiento_id: movementOut.id,
            movimiento_det_id: outDet.id,
            tipo_movimiento: 'SALIDA',
            entrada_cantidad: '0.000000',
            salida_cantidad: this.toFixedText(quantity, 6),
            costo_unitario: this.toFixedText(unitCost, 4),
            costo_total: this.toFixedText(subtotal, 4),
            saldo_cantidad: sourceStock.stock_actual,
            saldo_costo_promedio: this.toFixedText(unitCost, 4),
            saldo_valorizado: this.toFixedText(
              this.toNumber(sourceStock.stock_actual, 0) * unitCost,
              4,
            ),
            observacion:
              this.toText(detail.observacion) ||
              this.toText(dto.observacion) ||
              `Salida por transferencia ${code}`,
            created_by: userName,
            updated_by: userName,
          }),
        );

        const kardexIn = await manager.save(
          Kardex,
          manager.create(Kardex, {
            fecha: fechaTransferencia,
            bodega_id: destinationWarehouse.id,
            producto_id: product.id,
            movimiento_id: movementIn.id,
            movimiento_det_id: inDet.id,
            tipo_movimiento: 'INGRESO',
            entrada_cantidad: this.toFixedText(quantity, 6),
            salida_cantidad: '0.000000',
            costo_unitario: this.toFixedText(unitCost, 4),
            costo_total: this.toFixedText(subtotal, 4),
            saldo_cantidad: destStock.stock_actual,
            saldo_costo_promedio: this.toFixedText(unitCost, 4),
            saldo_valorizado: this.toFixedText(
              this.toNumber(destStock.stock_actual, 0) * unitCost,
              4,
            ),
            observacion:
              this.toText(detail.observacion) ||
              this.toText(dto.observacion) ||
              `Ingreso por transferencia ${code}`,
            created_by: userName,
            updated_by: userName,
          }),
        );

        transferDetailEntities.push(
          manager.create(TransferenciaBodegaDet, {
            transferencia_bodega_id: transfer.id,
            orden_compra_det_id: orderDetail.id,
            producto_id: product.id,
            codigo_producto: orderDetail.codigo_producto,
            nombre_producto: orderDetail.nombre_producto,
            cantidad: this.toFixedText(quantity, 6),
            costo_unitario: this.toFixedText(unitCost, 4),
            subtotal: this.toFixedText(subtotal, 4),
            bodega_origen_id: sourceWarehouse.id,
            bodega_destino_id: destinationWarehouse.id,
            kardex_salida_id: kardexOut.id,
            kardex_ingreso_id: kardexIn.id,
            movimiento_salida_det_id: outDet.id,
            movimiento_ingreso_det_id: inDet.id,
            observacion: this.toText(detail.observacion) || null,
            created_by: userName,
            updated_by: userName,
          }),
        );
      }

      movementOut.total_costos = this.toFixedText(totalCost, 4);
      movementOut.updated_by = userName;
      movementIn.total_costos = this.toFixedText(totalCost, 4);
      movementIn.updated_by = userName;
      await manager.save(MovimientoInventario, [movementOut, movementIn]);
      await manager.save(TransferenciaBodegaDet, transferDetailEntities);

      transfer.total_items = transferDetailEntities.length;
      transfer.total_cantidad = this.toFixedText(
        transferDetailEntities.reduce(
          (sum, item) => sum + this.toNumber(item.cantidad, 0),
          0,
        ),
        6,
      );
      transfer.updated_by = userName;
      await manager.save(TransferenciaBodega, transfer);

      order.estado = 'TRANSFERIDA';
      order.updated_by = userName;
      await manager.save(OrdenCompra, order);

      await this.notifyMaintenanceRecalculationForStocks(changedStockIds, 'transfer');
      return this.findOne(transfer.id);
    });
  }

  private async hydrateTransfers(
    rows: TransferenciaBodega[],
    includeDetails: boolean,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const orderIds = rows.map((item) => item.orden_compra_id);
    const warehouseIds = rows.flatMap((item) => [
      item.bodega_origen_id,
      item.bodega_destino_id,
    ]);
    const [details, orders, warehouses] = await Promise.all([
      this.transferenciaDetRepo.find({
        where: ids.map((id) => ({ transferencia_bodega_id: id, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
      this.ordenRepo.find({
        where: orderIds.map((id) => ({ id, is_deleted: false })),
      }),
      this.bodegaRepo.find({
        where: [...new Set(warehouseIds.filter(Boolean))].map((id) => ({
          id,
          is_deleted: false,
        })),
      }),
    ]);
    const detailMap = details.reduce((acc, item) => {
      (acc[item.transferencia_bodega_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, TransferenciaBodegaDet[]>);
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));

    return rows.map((item) => {
      const source = warehouseMap.get(item.bodega_origen_id);
      const destination = warehouseMap.get(item.bodega_destino_id);
      const order = orderMap.get(item.orden_compra_id);
      return {
        ...item,
        orden_compra_codigo: order?.codigo ?? null,
        orden_compra_proveedor: order?.proveedor_nombre ?? null,
        bodega_origen_label: source
          ? `${source.codigo || ''} - ${source.nombre || ''}`.trim()
          : 'Sin bodega',
        bodega_destino_label: destination
          ? `${destination.codigo || ''} - ${destination.nombre || ''}`.trim()
          : 'Sin bodega',
        detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
      };
    });
  }

  private prepareTransferDetails(
    dtoDetails: TransferenciaBodegaDetalleDto[] | undefined,
    orderDetails: OrdenCompraDet[],
  ) {
    if (!dtoDetails?.length) {
      return orderDetails.map((item) => ({
        orderDetail: item,
        cantidad: this.toNumber(item.cantidad, 0),
        observacion: item.observacion,
      }));
    }

    return dtoDetails.map((detail) => {
      const orderDetail =
        orderDetails.find((item) => item.id === detail.orden_compra_det_id) ||
        orderDetails.find((item) => item.producto_id === detail.producto_id);
      if (!orderDetail) {
        throw new BadRequestException(
          'Uno de los materiales seleccionados no pertenece a la orden de compra.',
        );
      }
      const quantity = this.toNumber(detail.cantidad, 0);
      const orderQuantity = this.toNumber(orderDetail.cantidad, 0);
      if (quantity > orderQuantity) {
        throw new BadRequestException(
          `La cantidad de ${orderDetail.nombre_producto} no puede superar lo pedido en la orden de compra.`,
        );
      }
      return {
        orderDetail,
        cantidad: quantity,
        observacion: this.toText(detail.observacion) || null,
      };
    });
  }

  private resolveUnitCost(
    orderDetail: OrdenCompraDet,
    product: Producto,
    stock: StockBodega,
  ) {
    const stockCost = this.toNumber(stock.costo_promedio_bodega, 0);
    if (stockCost > 0) return stockCost;
    const orderCost = this.toNumber(orderDetail.costo_unitario, 0);
    if (orderCost > 0) return orderCost;
    const productCost = this.toNumber(product.costo_promedio ?? product.ultimo_costo, 0);
    return productCost > 0 ? productCost : 0;
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

  private async generateCode(manager: EntityManager, prefix: string) {
    const rows = await manager.find(TransferenciaBodega, {
      where: { is_deleted: false },
      select: { codigo: true } as any,
      take: 200,
      order: { created_at: 'DESC' } as any,
    });
    const maxNumber = rows.reduce((max, item: any) => {
      const match = String(item?.codigo || '')
        .trim()
        .match(/(\d+)$/);
      const numeric = match ? Number(match[1]) : 0;
      return numeric > max ? numeric : max;
    }, 0);
    return `${prefix}-${String(maxNumber + 1).padStart(8, '0')}`;
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

    for (const stockId of [...new Set([...stockIds].filter(Boolean))]) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: `inventory-transfer-${source}`,
            stock_id: stockId,
          }),
        });
        if (!response.ok) {
          this.logger.warn(
            `No se pudo disparar el recálculo de alertas (transfer:${stockId}). HTTP ${response.status}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Error notificando recálculo de alertas desde transferencias (${stockId}): ${message}`,
        );
      }
    }
  }

  private resolveUserName(dto: CreateTransferenciaBodegaDto) {
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
