import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';
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

type PreparedTransferDetail = {
  orderDetail: OrdenCompraDet | null;
  product: Producto;
  cantidad: number;
  observacion: string | null;
  codigoProducto: string | null;
  nombreProducto: string;
  orderUnitCost: number;
};

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

  private async getWarehouseIdsBySucursal(sucursalId?: string | null) {
    if (!sucursalId) return null;
    const rows = await this.bodegaRepo.find({
      where: { sucursal_id: sucursalId, is_deleted: false } as any,
      select: { id: true } as any,
    });
    return rows.map((item) => item.id);
  }

  async findAll(query: TransferenciaBodegaQueryDto, sucursalId?: string | null) {
    const page = Number(query.page || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit || 10)));
    const search = this.toText(query.search);
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);

    if (warehouseIds && !warehouseIds.length) {
      return {
        data: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 1,
        },
      };
    }

    const qb = this.transferenciaRepo
      .createQueryBuilder('transferencia')
      .where('transferencia.is_deleted = false');

    if (warehouseIds) {
      qb.andWhere(
        new Brackets((scopeQb) => {
          scopeQb
            .where('transferencia.bodega_origen_id IN (:...warehouseIds)', {
              warehouseIds,
            })
            .orWhere('transferencia.bodega_destino_id IN (:...warehouseIds)', {
              warehouseIds,
            });
        }),
      );
    }

    if (search) {
      qb.andWhere(
        new Brackets((searchQb) => {
          searchQb
            .where('transferencia.codigo ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('COALESCE(transferencia.observacion, \'\') ILIKE :search', {
              search: `%${search}%`,
            });
        }),
      );
    }

    const [rows, total] = await qb
      .orderBy('transferencia.fecha_transferencia', 'DESC')
      .addOrderBy('transferencia.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

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

  async findOne(id: string, sucursalId?: string | null) {
    const transfer = await this.transferenciaRepo.findOne({
      where: { id, is_deleted: false },
    });
    if (!transfer) {
      throw new NotFoundException('La transferencia no existe.');
    }
    const warehouseIds = await this.getWarehouseIdsBySucursal(sucursalId);
    if (
      warehouseIds &&
      !warehouseIds.includes(String(transfer.bodega_origen_id || '')) &&
      !warehouseIds.includes(String(transfer.bodega_destino_id || ''))
    ) {
      throw new NotFoundException('La transferencia no existe.');
    }
    const [hydrated] = await this.hydrateTransfers([transfer], true);
    return hydrated;
  }

  async create(dto: CreateTransferenciaBodegaDto) {
    return this.dataSource.transaction(async (manager) => {
      const userName = this.resolveUserName(dto);
      const orderId = this.toText(dto.orden_compra_id) || null;
      const order = orderId
        ? await manager.findOne(OrdenCompra, {
            where: { id: orderId, is_deleted: false },
          })
        : null;
      if (orderId && !order) {
        throw new NotFoundException('La orden de compra seleccionada no existe.');
      }
      if (order && String(order.estado || '').toUpperCase() === 'TRANSFERIDA') {
        throw new BadRequestException(
          'La orden de compra ya fue transferida.',
        );
      }
      if (order) {
        const existingTransfer = await manager.findOne(TransferenciaBodega, {
          where: { orden_compra_id: order.id, is_deleted: false },
        });
        if (existingTransfer) {
          throw new BadRequestException(
            'La orden de compra ya tiene una transferencia registrada.',
          );
        }
      }

      const sourceWarehouseId = this.toText(order?.bodega_destino_id || dto.bodega_origen_id);
      if (!sourceWarehouseId) {
        throw new BadRequestException(
          'La bodega origen es obligatoria cuando la transferencia no proviene de una orden de compra.',
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

      const orderDetails = order
        ? await manager.find(OrdenCompraDet, {
            where: { orden_compra_id: order.id, is_deleted: false },
            order: { created_at: 'ASC' },
          })
        : [];
      if (order && !orderDetails.length) {
        throw new BadRequestException(
          'La orden de compra no tiene materiales para transferir.',
        );
      }

      const requestedDetails = order
        ? this.prepareTransferDetails(dto.detalles, orderDetails)
        : await this.prepareManualTransferDetails(manager, dto.detalles);
      if (!requestedDetails.length) {
        throw new BadRequestException(
          order
            ? 'La orden de compra no tiene saldo preaprobado disponible para transferir.'
            : 'Debes agregar al menos un material para registrar la transferencia.',
        );
      }
      const code = await this.generateCode(manager, 'TB');
      const egressCode = await this.generateMovementDocumentCode(manager, 'EB');
      const fechaTransferencia = dto.fecha_transferencia
        ? new Date(dto.fecha_transferencia)
        : new Date();
      const baseObservation =
        this.toText(dto.observacion) || `Transferencia ${code}`;

      const movementReceipt = order
        ? await manager.save(
            MovimientoInventario,
            manager.create(MovimientoInventario, {
              tipo_movimiento: 'INGRESO',
              fecha_movimiento: fechaTransferencia,
              tipo_documento: 'INGRESO_BODEGA',
              numero_documento: await this.generateMovementDocumentCode(
                manager,
                'IB',
              ),
              referencia: order.codigo || order.referencia || code,
              observacion: `Ingreso preaprobado por ${order.codigo || 'orden de compra'} para transferencia ${code}`,
              bodega_destino_id: sourceWarehouse.id,
              tipo_cambio: '1',
              total_costos: '0.0000',
              estado: 'CONFIRMADO',
              created_by: userName,
              updated_by: userName,
            }),
          )
        : null;

      const ingressCode = await this.generateMovementDocumentCode(manager, 'IB');

      const movementOut = await manager.save(
        MovimientoInventario,
        manager.create(MovimientoInventario, {
          tipo_movimiento: 'SALIDA',
          fecha_movimiento: fechaTransferencia,
          tipo_documento: 'EGRESO_BODEGA',
          numero_documento: egressCode,
          referencia: code,
          observacion: baseObservation,
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
          tipo_documento: 'INGRESO_BODEGA',
          numero_documento: ingressCode,
          referencia: code,
          observacion: baseObservation,
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
          orden_compra_id: order?.id ?? null,
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
        const product = detail.product;
        const quantity = this.toNumber(detail.cantidad, 0);
        if (!(quantity > 0)) {
          throw new BadRequestException(
            `La cantidad a transferir de ${detail.nombreProducto} debe ser mayor a cero.`,
          );
        }

        const sourceStock = await this.getOrCreateStockRow(manager, {
          bodegaId: sourceWarehouse.id,
          productoId: product.id,
          costoPromedio: this.toNumber(
            detail.orderUnitCost,
            this.toNumber(product.costo_promedio ?? product.ultimo_costo, 0),
          ),
          userName,
        });
        let currentSourceStock = this.toNumber(sourceStock.stock_actual, 0);
        const approvedAvailable = this.getApprovedAvailableQuantity(orderDetail);
        if (order && approvedAvailable < quantity) {
          throw new BadRequestException(
            `La cantidad solicitada de ${product.nombre} supera el saldo preaprobado de la orden de compra. Disponible ${approvedAvailable.toFixed(
              2,
            )}, requerido ${quantity.toFixed(2)}.`,
          );
        }
        if (!order && currentSourceStock < quantity) {
          throw new BadRequestException(
            `Stock insuficiente en ${sourceWarehouse.nombre} para ${product.nombre}. Disponible ${currentSourceStock.toFixed(
              2,
            )}, requerido ${quantity.toFixed(2)}.`,
          );
        }

        const unitCost = this.resolveUnitCost(orderDetail, product, sourceStock);
        const subtotal = quantity * unitCost;
        totalCost += subtotal;

        if (order && movementReceipt) {
          currentSourceStock += quantity;
          sourceStock.stock_actual = this.toFixedText(currentSourceStock, 6);
          sourceStock.costo_promedio_bodega = this.toFixedText(unitCost, 4);
          sourceStock.updated_by = userName;
          await manager.save(StockBodega, sourceStock);
          changedStockIds.add(sourceStock.id);

          const receiptDet = await manager.save(
            MovimientoInventarioDet,
            manager.create(MovimientoInventarioDet, {
              movimiento_id: movementReceipt.id,
              producto_id: product.id,
              cantidad: this.toFixedText(quantity, 6),
              costo_unitario: this.toFixedText(unitCost, 4),
              subtotal_costo: this.toFixedText(subtotal, 4),
              observacion:
                this.toText(detail.observacion) ||
                baseObservation ||
                `Ingreso preaprobado ${order.codigo || code}`,
              created_by: userName,
              updated_by: userName,
            }),
          );

          await manager.save(
            Kardex,
            manager.create(Kardex, {
              fecha: fechaTransferencia,
              bodega_id: sourceWarehouse.id,
              producto_id: product.id,
              movimiento_id: movementReceipt.id,
              movimiento_det_id: receiptDet.id,
              tipo_movimiento: 'INGRESO',
              entrada_cantidad: this.toFixedText(quantity, 6),
              salida_cantidad: '0.000000',
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
                baseObservation ||
                `Ingreso preaprobado ${order.codigo || code}`,
              created_by: userName,
              updated_by: userName,
            }),
          );
        }

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
              baseObservation ||
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
              baseObservation ||
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
              baseObservation ||
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
              baseObservation ||
              `Ingreso por transferencia ${code}`,
            created_by: userName,
            updated_by: userName,
          }),
        );

        if (orderDetail) {
          orderDetail.cantidad_transferida = this.toFixedText(
            this.toNumber(orderDetail.cantidad_transferida, 0) + quantity,
            6,
          );
          orderDetail.updated_by = userName;
          await manager.save(OrdenCompraDet, orderDetail);
        }

        transferDetailEntities.push(
          manager.create(TransferenciaBodegaDet, {
            transferencia_bodega_id: transfer.id,
            orden_compra_det_id: orderDetail?.id ?? null,
            producto_id: product.id,
            codigo_producto: detail.codigoProducto,
            nombre_producto: detail.nombreProducto,
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
      if (movementReceipt) {
        movementReceipt.total_costos = this.toFixedText(totalCost, 4);
        movementReceipt.updated_by = userName;
      }
      const movementBatch = [movementReceipt, movementOut, movementIn].filter(
        (item): item is MovimientoInventario => Boolean(item),
      );
      await manager.save(MovimientoInventario, movementBatch);
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

      if (order) {
        order.estado = 'TRANSFERIDA';
        order.updated_by = userName;
        await manager.save(OrdenCompra, order);
      }

      await this.notifyMaintenanceRecalculationForStocks(changedStockIds, 'transfer');
      const [hydrated] = await this.hydrateTransfersWithManager(
        manager,
        [transfer],
        true,
      );
      return hydrated;
    });
  }

  private async hydrateTransfers(
    rows: TransferenciaBodega[],
    includeDetails: boolean,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const orderIds = rows
      .map((item) => item.orden_compra_id)
      .filter((value): value is string => Boolean(value));
    const warehouseIds = rows.flatMap((item) => [
      item.bodega_origen_id,
      item.bodega_destino_id,
    ]);
    const movementIds = rows
      .flatMap((item) => [item.movimiento_salida_id, item.movimiento_ingreso_id])
      .filter((value): value is string => Boolean(value));
    const [details, orders, warehouses, movements] = await Promise.all([
      this.transferenciaDetRepo.find({
        where: ids.map((id) => ({ transferencia_bodega_id: id, is_deleted: false })),
        order: { created_at: 'ASC' },
      }),
      orderIds.length
        ? this.ordenRepo.find({
            where: orderIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as OrdenCompra[]),
      this.bodegaRepo.find({
        where: [...new Set(warehouseIds.filter(Boolean))].map((id) => ({
          id,
          is_deleted: false,
        })),
      }),
      movementIds.length
        ? this.movimientoRepo.find({
            where: [...new Set(movementIds)].map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as MovimientoInventario[]),
    ]);
    const detailMap = details.reduce((acc, item) => {
      (acc[item.transferencia_bodega_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, TransferenciaBodegaDet[]>);
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const movementMap = new Map(movements.map((item) => [item.id, item]));

    return rows.map((item) => {
      const source = warehouseMap.get(item.bodega_origen_id);
      const destination = warehouseMap.get(item.bodega_destino_id);
      const order = item.orden_compra_id ? orderMap.get(item.orden_compra_id) : null;
      const movementOut = item.movimiento_salida_id
        ? movementMap.get(item.movimiento_salida_id)
        : null;
      const movementIn = item.movimiento_ingreso_id
        ? movementMap.get(item.movimiento_ingreso_id)
        : null;
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
        egreso_bodega_codigo: movementOut?.numero_documento ?? null,
        ingreso_bodega_codigo: movementIn?.numero_documento ?? null,
        detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
      };
    });
  }

  private async hydrateTransfersWithManager(
    manager: EntityManager,
    rows: TransferenciaBodega[],
    includeDetails: boolean,
  ) {
    if (!rows.length) return [];
    const ids = rows.map((item) => item.id);
    const orderIds = rows
      .map((item) => item.orden_compra_id)
      .filter((value): value is string => Boolean(value));
    const warehouseIds = rows.flatMap((item) => [
      item.bodega_origen_id,
      item.bodega_destino_id,
    ]);
    const movementIds = rows
      .flatMap((item) => [item.movimiento_salida_id, item.movimiento_ingreso_id])
      .filter((value): value is string => Boolean(value));
    const [details, orders, warehouses, movements] = await Promise.all([
      manager.find(TransferenciaBodegaDet, {
        where: ids.map((id) => ({
          transferencia_bodega_id: id,
          is_deleted: false,
        })),
        order: { created_at: 'ASC' },
      }),
      orderIds.length
        ? manager.find(OrdenCompra, {
            where: orderIds.map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as OrdenCompra[]),
      manager.find(Bodega, {
        where: [...new Set(warehouseIds.filter(Boolean))].map((id) => ({
          id,
          is_deleted: false,
        })),
      }),
      movementIds.length
        ? manager.find(MovimientoInventario, {
            where: [...new Set(movementIds)].map((id) => ({ id, is_deleted: false })),
          })
        : Promise.resolve([] as MovimientoInventario[]),
    ]);

    const detailMap = details.reduce((acc, item) => {
      (acc[item.transferencia_bodega_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, TransferenciaBodegaDet[]>);
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const movementMap = new Map(movements.map((item) => [item.id, item]));

    return rows.map((item) => {
      const source = warehouseMap.get(item.bodega_origen_id);
      const destination = warehouseMap.get(item.bodega_destino_id);
      const order = item.orden_compra_id ? orderMap.get(item.orden_compra_id) : null;
      const movementOut = item.movimiento_salida_id
        ? movementMap.get(item.movimiento_salida_id)
        : null;
      const movementIn = item.movimiento_ingreso_id
        ? movementMap.get(item.movimiento_ingreso_id)
        : null;
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
        egreso_bodega_codigo: movementOut?.numero_documento ?? null,
        ingreso_bodega_codigo: movementIn?.numero_documento ?? null,
        detalles: includeDetails ? detailMap[item.id] ?? [] : undefined,
      };
    });
  }

  private prepareTransferDetails(
    dtoDetails: TransferenciaBodegaDetalleDto[] | undefined,
    orderDetails: OrdenCompraDet[],
  ): PreparedTransferDetail[] {
    if (!dtoDetails?.length) {
      return orderDetails
        .map((item) => ({
          orderDetail: item,
          product: {
            id: item.producto_id,
            codigo: item.codigo_producto || '',
            nombre: item.nombre_producto,
          } as Producto,
          cantidad: this.getApprovedAvailableQuantity(item),
          observacion: item.observacion ?? null,
          codigoProducto: item.codigo_producto || null,
          nombreProducto: item.nombre_producto,
          orderUnitCost: this.toNumber(item.costo_unitario, 0),
        }))
        .filter((item) => item.cantidad > 0);
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
      const approvedAvailable = this.getApprovedAvailableQuantity(orderDetail);
      if (quantity > approvedAvailable) {
        throw new BadRequestException(
          `La cantidad de ${orderDetail.nombre_producto} no puede superar el saldo preaprobado disponible en la orden de compra.`,
        );
      }
      return {
        orderDetail,
        product: {
          id: orderDetail.producto_id,
          codigo: orderDetail.codigo_producto || '',
          nombre: orderDetail.nombre_producto,
        } as Producto,
        cantidad: quantity,
        observacion: this.toText(detail.observacion) || null,
        codigoProducto: orderDetail.codigo_producto || null,
        nombreProducto: orderDetail.nombre_producto,
        orderUnitCost: this.toNumber(orderDetail.costo_unitario, 0),
      };
    });
  }

  private async prepareManualTransferDetails(
    manager: EntityManager,
    dtoDetails: TransferenciaBodegaDetalleDto[] | undefined,
  ): Promise<PreparedTransferDetail[]> {
    if (!dtoDetails?.length) {
      throw new BadRequestException(
        'Debes agregar al menos un material para registrar la transferencia.',
      );
    }

    const prepared: PreparedTransferDetail[] = [];
    for (const detail of dtoDetails) {
      const product = await manager.findOne(Producto, {
        where: { id: detail.producto_id, is_deleted: false },
      });
      if (!product) {
        throw new BadRequestException(
          'Uno de los materiales seleccionados no existe.',
        );
      }
      const quantity = this.toNumber(detail.cantidad, 0);
      if (!(quantity > 0)) {
        throw new BadRequestException(
          `La cantidad a transferir de ${product.nombre} debe ser mayor a cero.`,
        );
      }
      prepared.push({
        orderDetail: null,
        product,
        cantidad: quantity,
        observacion: this.toText(detail.observacion) || null,
        codigoProducto: product.codigo || null,
        nombreProducto: product.nombre,
        orderUnitCost: this.toNumber(
          product.costo_promedio ?? product.ultimo_costo,
          0,
        ),
      });
    }
    return prepared;
  }

  private resolveUnitCost(
    orderDetail: OrdenCompraDet | null,
    product: Producto,
    stock: StockBodega,
  ) {
    const stockCost = this.toNumber(stock.costo_promedio_bodega, 0);
    if (stockCost > 0) return stockCost;
    const orderCost = this.toNumber(orderDetail?.costo_unitario, 0);
    if (orderCost > 0) return orderCost;
    const productCost = this.toNumber(product.costo_promedio ?? product.ultimo_costo, 0);
    return productCost > 0 ? productCost : 0;
  }

  private getApprovedAvailableQuantity(orderDetail: OrdenCompraDet | null) {
    if (!orderDetail) return 0;
    const approved = this.toNumber(
      orderDetail.cantidad_preaprobada,
      this.toNumber(orderDetail.cantidad, 0),
    );
    const transferred = this.toNumber(orderDetail.cantidad_transferida, 0);
    return Math.max(0, approved - transferred);
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
