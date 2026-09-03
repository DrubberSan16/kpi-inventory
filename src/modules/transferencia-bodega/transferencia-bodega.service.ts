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
import { Brackets, DataSource, EntityManager, Not, Repository } from 'typeorm';
import {
  Bodega,
  GuiaRemisionElectronica,
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
import { isAdministrativeManagementRoleName } from '../../common/utils/administrative-role.util';
import { buildAnnulmentInfo } from '../../common/http/annulled-records.util';
import { buildSecurityServiceHeaders } from '../../common/http/internal-service.util';

type PreparedTransferDetail = {
  orderDetail: OrdenCompraDet | null;
  product: Producto;
  cantidad: number;
  observacion: string | null;
  codigoProducto: string | null;
  nombreProducto: string;
  orderUnitCost: number;
  requestedCondition: 'NUEVO' | 'USADO' | null;
};

type DocumentAnnulmentActor = {
  username?: string | null;
  displayName?: string | null;
  roleName?: string | null;
};

@Injectable()
export class TransferenciaBodegaService {
  private readonly logger = new Logger(TransferenciaBodegaService.name);
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
    @InjectRepository(GuiaRemisionElectronica)
    private readonly guideRepo: Repository<GuiaRemisionElectronica>,
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

  private assertCanAnnul(actor?: DocumentAnnulmentActor | null) {
    if (isAdministrativeManagementRoleName(actor?.roleName)) return;
    throw new ForbiddenException(
      'Solo Administrador, Super Administrador o Gerente General pueden anular documentos.',
    );
  }

  private assertCanForceAuthorizedGuideAnnul(
    actor?: DocumentAnnulmentActor | null,
  ) {
    if (
      this.isAdministratorRoleName(actor?.roleName || undefined) ||
      this.isSuperAdministratorRoleName(actor?.roleName || undefined)
    ) {
      return;
    }
    throw new ForbiddenException(
      'Solo el Administrador o Super Administrador puede forzar la anulacion de una transferencia con guia autorizada.',
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
  private readonly logEndpoint = '/kpi_inventory/transferencias-bodega';

  private queueTransactionLog(payload: {
    traceId: string;
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
          typeLog: 'WAREHOUSE_TRANSFER_FLOW',
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
        `No se pudo registrar log transaccional de transferencia: ${error?.message ?? 'desconocido'}`,
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
    query: TransferenciaBodegaQueryDto,
    sucursalId?: string | null,
    includeAnnulled = false,
  ) {
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

    if (!includeAnnulled) {
      qb.andWhere(
        "UPPER(TRIM(COALESCE(transferencia.estado, ''))) NOT IN ('ANULADA', 'ANULADO', 'CANCELADA', 'CANCELADO', 'VOID', 'VOIDED')",
      );
    }

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

    if (query.bodega_origen_id) {
      qb.andWhere('transferencia.bodega_origen_id = :bodegaOrigenId', {
        bodegaOrigenId: query.bodega_origen_id,
      });
    }
    if (query.bodega_destino_id) {
      qb.andWhere('transferencia.bodega_destino_id = :bodegaDestinoId', {
        bodegaDestinoId: query.bodega_destino_id,
      });
    }
    if (query.estado) {
      qb.andWhere(
        "UPPER(TRIM(COALESCE(transferencia.estado, ''))) = :estado",
        { estado: this.toText(query.estado).toUpperCase() },
      );
    }
    if (query.desde) {
      qb.andWhere('DATE(transferencia.fecha_transferencia) >= :desde', {
        desde: query.desde,
      });
    }
    if (query.hasta) {
      qb.andWhere('DATE(transferencia.fecha_transferencia) <= :hasta', {
        hasta: query.hasta,
      });
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
      .orderBy('transferencia.created_at', 'DESC')
      .addOrderBy('transferencia.fecha_transferencia', 'DESC')
      .addOrderBy('transferencia.id', 'DESC')
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
    const traceId = randomUUID();
    const createdBy = this.resolveUserName(dto);
    const changedStockIds = new Set<string>();
    const decreasedStockIds = new Set<string>();
    this.queueTransactionLog({
      traceId,
      createdBy,
      description: 'Inicio de registro de transferencia de bodega.',
    });
    try {
      const result = await this.dataSource.transaction(async (manager) => {
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
          where: {
            orden_compra_id: order.id,
            is_deleted: false,
            estado: Not('ANULADA'),
          },
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
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Validacion completada para transferencia. Materiales=${requestedDetails.length}.`,
      });
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
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Documentos base generados para transferencia ${code}.`,
      });

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
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Cabecera de transferencia ${transfer.codigo} persistida.`,
      });

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

        const materialCondition = this.resolveTransferStockCondition(
          sourceStock,
          Boolean(order),
          detail.requestedCondition,
        );
        if (!order) {
          const reservedQuantity = await this.getActiveReservedQuantity(
            manager,
            sourceWarehouse.id,
            product.id,
          );
          const availableForCondition = this.getTransferableStockByCondition(
            sourceStock,
            materialCondition,
            reservedQuantity,
          );
          if (availableForCondition + 0.000001 < quantity) {
            throw new BadRequestException(
              `Stock ${materialCondition.toLowerCase()} insuficiente en ${sourceWarehouse.nombre} para ${product.nombre}. Disponible para transferir ${availableForCondition.toFixed(
                2,
              )}, reservado en ordenes de trabajo ${reservedQuantity.toFixed(
                2,
              )}, requerido ${quantity.toFixed(2)}.`,
            );
          }
        }

        const unitCost = this.resolveUnitCost(orderDetail, product, sourceStock);
        const subtotal = quantity * unitCost;
        totalCost += subtotal;

        if (order && movementReceipt) {
          currentSourceStock = this.applyNewStockDelta(sourceStock, quantity);
          sourceStock.stock_fisico = this.toFixedText(currentSourceStock, 6);
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
              condicion_material: 'NUEVO',
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
              condicion_material: 'NUEVO',
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

        const sourceStockAfterOut = this.applyStockDeltaByCondition(
          sourceStock,
          -quantity,
          materialCondition,
        );
        sourceStock.stock_fisico = this.toFixedText(
          this.toNumber(sourceStock.stock_fisico, currentSourceStock) - quantity,
          6,
        );
        sourceStock.updated_by = userName;
        await manager.save(StockBodega, sourceStock);
        changedStockIds.add(sourceStock.id);
        if (!order) decreasedStockIds.add(sourceStock.id);

        const destStock = await this.getOrCreateStockRow(manager, {
          bodegaId: destinationWarehouse.id,
          productoId: product.id,
          costoPromedio: unitCost,
          userName,
        });
        const currentDestStock = this.toNumber(destStock.stock_actual, 0);
        const destinationStockAfterIn = this.applyStockDeltaByCondition(
          destStock,
          quantity,
          materialCondition,
        );
        destStock.stock_fisico = this.toFixedText(
          this.toNumber(destStock.stock_fisico, currentDestStock) + quantity,
          6,
        );
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
            condicion_material: materialCondition,
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
            condicion_material: materialCondition,
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
            saldo_cantidad: this.toFixedText(sourceStockAfterOut, 6),
            condicion_material: materialCondition,
            saldo_costo_promedio: this.toFixedText(unitCost, 4),
            saldo_valorizado: this.toFixedText(
              sourceStockAfterOut * unitCost,
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
            saldo_cantidad: this.toFixedText(destinationStockAfterIn, 6),
            condicion_material: materialCondition,
            saldo_costo_promedio: this.toFixedText(unitCost, 4),
            saldo_valorizado: this.toFixedText(
              destinationStockAfterIn * unitCost,
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
      this.queueTransactionLog({
        traceId,
        createdBy: userName,
        description: `Detalle y movimientos confirmados para transferencia ${transfer.codigo}. Filas=${transferDetailEntities.length}.`,
      });

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

      const [hydrated] = await this.hydrateTransfersWithManager(
        manager,
        [transfer],
        true,
      );
      return hydrated;
      });
      this.queueTransactionLog({
        traceId,
        createdBy,
        description: `Transferencia ${this.toText((result as any)?.codigo) || 'sin-codigo'} registrada correctamente.`,
      });
      await this.notifyMaintenanceRecalculationForStocks(
        changedStockIds,
        'transfer',
        { decreasedStockIds, actorUsername: createdBy },
      );
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy,
        status: 'ERROR',
        requestMethod: 'POST',
        requestUrl: this.logEndpoint,
        requestPayload: dto,
        description: `Fallo al registrar transferencia de bodega: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
  }

  async annul(
    id: string,
    actor?: DocumentAnnulmentActor | null,
    forceAuthorizedGuide = false,
  ) {
    this.assertCanAnnul(actor);
    if (forceAuthorizedGuide) {
      this.assertCanForceAuthorizedGuideAnnul(actor);
    }
    const annulledBy = this.resolveAnnulmentActorName(actor);
    const traceId = randomUUID();
    const changedStockIds = new Set<string>();
    const decreasedStockIds = new Set<string>();
    this.queueTransactionLog({
      traceId,
      createdBy: annulledBy,
      description: `Inicio de anulacion de transferencia ${id}.`,
    });

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const transfer = await manager.findOne(TransferenciaBodega, {
          where: { id, is_deleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (!transfer) {
          throw new NotFoundException('La transferencia no existe.');
        }
        if (String(transfer.estado || '').trim().toUpperCase() === 'ANULADA') {
          const [hydrated] = await this.hydrateTransfersWithManager(
            manager,
            [transfer],
            true,
          );
          return hydrated;
        }

        const guide = await manager.findOne(GuiaRemisionElectronica, {
          where: { transferencia_bodega_id: transfer.id, is_deleted: false },
          order: { created_at: 'DESC' },
        });
        const guideEmissionState = String(guide?.estado_emision || '')
          .trim()
          .toUpperCase();
        const guideSriState = String(guide?.sri_estado || '')
          .trim()
          .toUpperCase();
        const hasAuthorizedGuide =
          ['AUTORIZADA', 'AUTORIZADO'].includes(guideEmissionState) ||
          ['AUTORIZADA', 'AUTORIZADO'].includes(guideSriState);
        if (hasAuthorizedGuide && !forceAuthorizedGuide) {
          throw new BadRequestException(
            'La transferencia tiene una guia autorizada por el SRI y no se puede anular.',
          );
        }

        const details = await manager.find(TransferenciaBodegaDet, {
          where: { transferencia_bodega_id: transfer.id, is_deleted: false },
          order: { created_at: 'ASC' },
        });
        if (!details.length) {
          throw new BadRequestException(
            'La transferencia no tiene detalles para revertir.',
          );
        }

        const reversalDate = new Date();
        const reversalObservation = `Anulacion administrativa de transferencia ${transfer.codigo}`;
        const destinationOut = await manager.save(
          MovimientoInventario,
          manager.create(MovimientoInventario, {
            tipo_movimiento: 'SALIDA',
            fecha_movimiento: reversalDate,
            tipo_documento: 'ANULACION_TRANSFERENCIA',
            numero_documento: await this.generateMovementDocumentCode(
              manager,
              'EB',
            ),
            referencia: transfer.codigo,
            observacion: reversalObservation,
            bodega_origen_id: transfer.bodega_destino_id,
            tipo_cambio: '1',
            total_costos: '0.0000',
            estado: 'CONFIRMADO',
            created_by: annulledBy,
            updated_by: annulledBy,
          }),
        );
        const sourceIn = transfer.orden_compra_id
          ? null
          : await manager.save(
              MovimientoInventario,
              manager.create(MovimientoInventario, {
                tipo_movimiento: 'INGRESO',
                fecha_movimiento: reversalDate,
                tipo_documento: 'ANULACION_TRANSFERENCIA',
                numero_documento: await this.generateMovementDocumentCode(
                  manager,
                  'IB',
                ),
                referencia: transfer.codigo,
                observacion: reversalObservation,
                bodega_destino_id: transfer.bodega_origen_id,
                tipo_cambio: '1',
                total_costos: '0.0000',
                estado: 'CONFIRMADO',
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );

        let totalCost = 0;
        for (const detail of details) {
          const quantity = this.toNumber(detail.cantidad, 0);
          const unitCost = this.toNumber(detail.costo_unitario, 0);
          const subtotal = quantity * unitCost;
          totalCost += subtotal;
          const originalOutDetail = detail.movimiento_salida_det_id
            ? await manager.findOne(MovimientoInventarioDet, {
                where: {
                  id: detail.movimiento_salida_det_id,
                  is_deleted: false,
                },
              })
            : null;
          const materialCondition = this.normalizePersistedStockCondition(
            originalOutDetail?.condicion_material,
          );

          const destinationStock = await this.getOrCreateStockRow(manager, {
            bodegaId: transfer.bodega_destino_id,
            productoId: detail.producto_id,
            costoPromedio: unitCost,
            userName: annulledBy,
          });
          const destinationAfter = this.applyStockDeltaByCondition(
            destinationStock,
            -quantity,
            materialCondition,
          );
          destinationStock.stock_fisico = this.toFixedText(
            destinationAfter,
            6,
          );
          destinationStock.updated_by = annulledBy;
          await manager.save(StockBodega, destinationStock);
          changedStockIds.add(destinationStock.id);
          decreasedStockIds.add(destinationStock.id);

          const destinationOutDetail = await manager.save(
            MovimientoInventarioDet,
            manager.create(MovimientoInventarioDet, {
              movimiento_id: destinationOut.id,
              producto_id: detail.producto_id,
              cantidad: this.toFixedText(quantity, 6),
              costo_unitario: this.toFixedText(unitCost, 4),
              subtotal_costo: this.toFixedText(subtotal, 4),
              condicion_material: materialCondition,
              observacion: reversalObservation,
              created_by: annulledBy,
              updated_by: annulledBy,
            }),
          );
          await manager.save(
            Kardex,
            manager.create(Kardex, {
              fecha: reversalDate,
              bodega_id: transfer.bodega_destino_id,
              producto_id: detail.producto_id,
              movimiento_id: destinationOut.id,
              movimiento_det_id: destinationOutDetail.id,
              tipo_movimiento: 'SALIDA',
              entrada_cantidad: '0.000000',
              salida_cantidad: this.toFixedText(quantity, 6),
              costo_unitario: this.toFixedText(unitCost, 4),
              costo_total: this.toFixedText(subtotal, 4),
              saldo_cantidad: this.toFixedText(destinationAfter, 6),
              condicion_material: materialCondition,
              saldo_costo_promedio: this.toFixedText(unitCost, 4),
              saldo_valorizado: this.toFixedText(
                destinationAfter * unitCost,
                4,
              ),
              observacion: reversalObservation,
              created_by: annulledBy,
              updated_by: annulledBy,
            }),
          );

          if (sourceIn) {
            const sourceStock = await this.getOrCreateStockRow(manager, {
              bodegaId: transfer.bodega_origen_id,
              productoId: detail.producto_id,
              costoPromedio: unitCost,
              userName: annulledBy,
            });
            const sourceAfter = this.applyStockDeltaByCondition(
              sourceStock,
              quantity,
              materialCondition,
            );
            sourceStock.stock_fisico = this.toFixedText(sourceAfter, 6);
            sourceStock.updated_by = annulledBy;
            await manager.save(StockBodega, sourceStock);
            changedStockIds.add(sourceStock.id);

            const sourceInDetail = await manager.save(
              MovimientoInventarioDet,
              manager.create(MovimientoInventarioDet, {
                movimiento_id: sourceIn.id,
                producto_id: detail.producto_id,
                cantidad: this.toFixedText(quantity, 6),
                costo_unitario: this.toFixedText(unitCost, 4),
                subtotal_costo: this.toFixedText(subtotal, 4),
                condicion_material: materialCondition,
                observacion: reversalObservation,
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );
            await manager.save(
              Kardex,
              manager.create(Kardex, {
                fecha: reversalDate,
                bodega_id: transfer.bodega_origen_id,
                producto_id: detail.producto_id,
                movimiento_id: sourceIn.id,
                movimiento_det_id: sourceInDetail.id,
                tipo_movimiento: 'INGRESO',
                entrada_cantidad: this.toFixedText(quantity, 6),
                salida_cantidad: '0.000000',
                costo_unitario: this.toFixedText(unitCost, 4),
                costo_total: this.toFixedText(subtotal, 4),
                saldo_cantidad: this.toFixedText(sourceAfter, 6),
                condicion_material: materialCondition,
                saldo_costo_promedio: this.toFixedText(unitCost, 4),
                saldo_valorizado: this.toFixedText(sourceAfter * unitCost, 4),
                observacion: reversalObservation,
                created_by: annulledBy,
                updated_by: annulledBy,
              }),
            );
          }

          if (detail.orden_compra_det_id) {
            const orderDetail = await manager.findOne(OrdenCompraDet, {
              where: { id: detail.orden_compra_det_id, is_deleted: false },
            });
            if (orderDetail) {
              orderDetail.cantidad_transferida = this.toFixedText(
                Math.max(
                  0,
                  this.toNumber(orderDetail.cantidad_transferida, 0) - quantity,
                ),
                6,
              );
              orderDetail.updated_by = annulledBy;
              await manager.save(OrdenCompraDet, orderDetail);
            }
          }
        }

        destinationOut.total_costos = this.toFixedText(totalCost, 4);
        destinationOut.updated_by = annulledBy;
        await manager.save(MovimientoInventario, destinationOut);
        if (sourceIn) {
          sourceIn.total_costos = this.toFixedText(totalCost, 4);
          sourceIn.updated_by = annulledBy;
          await manager.save(MovimientoInventario, sourceIn);
        }

        const annulledMovementIds = [
          transfer.movimiento_salida_id,
          transfer.movimiento_ingreso_id,
          destinationOut.id,
          sourceIn?.id,
        ].filter((value): value is string => Boolean(value));
        if (annulledMovementIds.length) {
          const annulledAt = new Date();
          await manager
            .createQueryBuilder()
            .update(MovimientoInventario)
            .set({
              estado: 'ANULADO',
              status: 'INACTIVE',
              updated_by: annulledBy,
              is_deleted: true,
              deleted_at: annulledAt,
              deleted_by: annulledBy,
            })
            .where('id IN (:...annulledMovementIds)', { annulledMovementIds })
            .execute();
          await manager
            .createQueryBuilder()
            .update(Kardex)
            .set({
              status: 'INACTIVE',
              updated_by: annulledBy,
              is_deleted: true,
              deleted_at: annulledAt,
              deleted_by: annulledBy,
            })
            .where('movimiento_id IN (:...annulledMovementIds)', {
              annulledMovementIds,
            })
            .execute();
        }

        transfer.estado = 'ANULADA';
        transfer.status = 'INACTIVE';
        transfer.updated_by = annulledBy;
        await manager.save(TransferenciaBodega, transfer);

        if (transfer.orden_compra_id) {
          const order = await manager.findOne(OrdenCompra, {
            where: { id: transfer.orden_compra_id, is_deleted: false },
          });
          if (order) {
            order.estado = 'EMITIDA';
            order.updated_by = annulledBy;
            await manager.save(OrdenCompra, order);
          }
        }
        if (guide && !hasAuthorizedGuide) {
          guide.estado_emision = 'ANULADA';
          guide.sri_estado = 'ANULADA';
          guide.updated_by = annulledBy;
          await manager.save(GuiaRemisionElectronica, guide);
        }

        const [hydrated] = await this.hydrateTransfersWithManager(
          manager,
          [transfer],
          true,
        );
        return hydrated;
      });
      this.queueTransactionLog({
        traceId,
        createdBy: annulledBy,
        description: forceAuthorizedGuide
          ? `Transferencia ${id} anulada de forma forzada con reverso de stock; la autorizacion SRI de la guia se conserva.`
          : `Transferencia ${id} anulada correctamente con reverso de stock.`,
      });
      await this.notifyMaintenanceRecalculationForStocks(
        changedStockIds,
        'transfer-annulment',
        { decreasedStockIds, actorUsername: annulledBy },
      );
      return result;
    } catch (error: any) {
      this.queueTransactionLog({
        traceId,
        createdBy: annulledBy,
        status: 'ERROR',
        requestMethod: 'PATCH',
        requestUrl: `${this.logEndpoint}/${id}/anular`,
        requestPayload: { id, annulledBy },
        description: `Fallo al anular transferencia ${id}: ${error?.message ?? 'desconocido'}`,
      });
      throw error;
    }
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

  private isAdministratorRoleName(roleName?: string): boolean {
    const normalized = String(roleName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase();
    return ['ADMINISTRADOR', 'ADMINISTRADOR DEL SISTEMA', 'ADMIN'].includes(
      normalized,
    );
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
      const guides = await manager
        .createQueryBuilder()
        .delete()
        .from(GuiaRemisionElectronica)
        .execute();
      const details = await manager
        .createQueryBuilder()
        .delete()
        .from(TransferenciaBodegaDet)
        .execute();
      const transfers = await manager
        .createQueryBuilder()
        .delete()
        .from(TransferenciaBodega)
        .execute();

      return {
        guias: Number(guides.affected || 0),
        detalles: Number(details.affected || 0),
        transferencias: Number(transfers.affected || 0),
      };
    });

    return {
      message: `Eliminacion real masiva ejecutada correctamente (${result.transferencias} transferencias).`,
      affected: result.transferencias,
      details: result,
    };
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
    const [details, orders, warehouses, movements, guides] = await Promise.all([
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
      ids.length
        ? this.guideRepo.find({
            where: ids.map((id) => ({ transferencia_bodega_id: id, is_deleted: false })),
            order: { created_at: 'DESC' },
          })
        : Promise.resolve([] as GuiaRemisionElectronica[]),
    ]);
    const detailProductIds = includeDetails
      ? [...new Set(details.map((item) => item.producto_id).filter(Boolean))]
      : [];
    const detailProducts = detailProductIds.length
      ? await this.productoRepo.find({
          where: detailProductIds.map((id) => ({ id })),
          select: { id: true, descripcion: true },
        })
      : [];
    const detailMap = details.reduce((acc, item) => {
      (acc[item.transferencia_bodega_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, TransferenciaBodegaDet[]>);
    const productDescriptionMap = new Map(
      detailProducts.map((item) => [item.id, item.descripcion ?? null]),
    );
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const movementMap = new Map(movements.map((item) => [item.id, item]));
    const guideMap = new Map(guides.map((item) => [item.transferencia_bodega_id, item]));

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
      const guide = guideMap.get(item.id) || null;
      return {
        ...item,
        ...buildAnnulmentInfo(item),
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
        guia_remision_id: guide?.id ?? null,
        guia_remision_estado: guide?.estado_emision ?? null,
        guia_remision_sri_estado: guide?.sri_estado ?? null,
        guia_remision_clave_acceso: guide?.clave_acceso ?? null,
        guia_remision_numero: guide?.numero_guia ?? null,
        guia_remision_numero_autorizacion: guide?.numero_autorizacion ?? null,
        detalles: includeDetails
          ? (detailMap[item.id] ?? []).map((detail) => ({
              ...detail,
              descripcion_producto:
                productDescriptionMap.get(detail.producto_id) ?? null,
            }))
          : undefined,
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
    const [details, orders, warehouses, movements, guides] = await Promise.all([
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
      ids.length
        ? manager.find(GuiaRemisionElectronica, {
            where: ids.map((id) => ({ transferencia_bodega_id: id, is_deleted: false })),
            order: { created_at: 'DESC' },
          })
        : Promise.resolve([] as GuiaRemisionElectronica[]),
    ]);
    const detailProductIds = includeDetails
      ? [...new Set(details.map((item) => item.producto_id).filter(Boolean))]
      : [];
    const detailProducts = detailProductIds.length
      ? await manager.find(Producto, {
          where: detailProductIds.map((id) => ({ id })),
          select: { id: true, descripcion: true },
        })
      : [];

    const detailMap = details.reduce((acc, item) => {
      (acc[item.transferencia_bodega_id] ??= []).push(item);
      return acc;
    }, {} as Record<string, TransferenciaBodegaDet[]>);
    const productDescriptionMap = new Map(
      detailProducts.map((item) => [item.id, item.descripcion ?? null]),
    );
    const orderMap = new Map(orders.map((item) => [item.id, item]));
    const warehouseMap = new Map(warehouses.map((item) => [item.id, item]));
    const movementMap = new Map(movements.map((item) => [item.id, item]));
    const guideMap = new Map(guides.map((item) => [item.transferencia_bodega_id, item]));

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
      const guide = guideMap.get(item.id) || null;
      return {
        ...item,
        ...buildAnnulmentInfo(item),
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
        guia_remision_id: guide?.id ?? null,
        guia_remision_estado: guide?.estado_emision ?? null,
        guia_remision_sri_estado: guide?.sri_estado ?? null,
        guia_remision_clave_acceso: guide?.clave_acceso ?? null,
        guia_remision_numero: guide?.numero_guia ?? null,
        guia_remision_numero_autorizacion: guide?.numero_autorizacion ?? null,
        detalles: includeDetails
          ? (detailMap[item.id] ?? []).map((detail) => ({
              ...detail,
              descripcion_producto:
                productDescriptionMap.get(detail.producto_id) ?? null,
            }))
          : undefined,
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
          requestedCondition: 'NUEVO' as const,
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
        requestedCondition: 'NUEVO',
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
        requestedCondition: detail.condicion_material
          ? this.normalizeRequestedStockCondition(detail.condicion_material)
          : null,
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
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing) {
      if (
        existing.is_deleted ||
        this.toText(existing.status).toUpperCase() !== 'ACTIVE'
      ) {
        existing.is_deleted = false;
        existing.status = 'ACTIVE';
        existing.deleted_at = null;
        existing.deleted_by = null;
        existing.updated_by = args.userName;
        return manager.save(StockBodega, existing);
      }
      return existing;
    }

    return manager.save(
      StockBodega,
      manager.create(StockBodega, {
        bodega_id: args.bodegaId,
        producto_id: args.productoId,
        stock_actual: '0.000000',
        stock_nuevo: '0.000000',
        stock_usado: '0.000000',
        stock_critico: '0.000000',
        stock_fisico: '0.000000',
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

  private getStockNuevoAmount(stockRow: StockBodega) {
    const actual = this.toNumber(stockRow.stock_actual, 0);
    const usado = this.toNumber(stockRow.stock_usado, 0);
    const critico = this.toNumber(stockRow.stock_critico, 0);
    const nuevo = this.toNumber(stockRow.stock_nuevo, actual - usado - critico);
    if (nuevo > 0 || usado > 0 || critico > 0 || actual === 0) {
      return Math.max(nuevo, 0);
    }
    return Math.max(actual - usado - critico, 0);
  }

  private getStockCriticoAmount(stockRow: StockBodega) {
    return Math.max(this.toNumber(stockRow.stock_critico, 0), 0);
  }

  private setStockBreakdown(
    stockRow: StockBodega,
    stockNuevo: number,
    stockUsado = this.toNumber(stockRow.stock_usado, 0),
    stockCritico = this.toNumber(stockRow.stock_critico, 0),
  ) {
    const normalizedNuevo = Math.max(this.toNumber(stockNuevo, 0), 0);
    const normalizedUsado = Math.max(this.toNumber(stockUsado, 0), 0);
    const normalizedCritico = Math.max(this.toNumber(stockCritico, 0), 0);
    const total = normalizedNuevo + normalizedUsado + normalizedCritico;
    stockRow.stock_nuevo = this.toFixedText(normalizedNuevo, 6);
    stockRow.stock_usado = this.toFixedText(normalizedUsado, 6);
    stockRow.stock_critico = this.toFixedText(normalizedCritico, 6);
    stockRow.stock_actual = this.toFixedText(total, 6);
    return total;
  }

  private applyNewStockDelta(stockRow: StockBodega, delta: number) {
    const currentNuevo = this.getStockNuevoAmount(stockRow);
    const nextNuevo = currentNuevo + this.toNumber(delta, 0);
    if (nextNuevo < -0.000001) {
      throw new BadRequestException(
        `Stock nuevo insuficiente. Disponible ${currentNuevo.toFixed(2)}, requerido ${Math.abs(delta).toFixed(2)}.`,
      );
    }
    return this.setStockBreakdown(stockRow, nextNuevo);
  }

  private getStockUsadoAmount(stockRow: StockBodega) {
    return Math.max(this.toNumber(stockRow.stock_usado, 0), 0);
  }

  private getOperationalStockAmount(stockRow: StockBodega) {
    const primary =
      this.getStockNuevoAmount(stockRow) + this.getStockUsadoAmount(stockRow);
    return primary > 0.000001 ? primary : this.getStockCriticoAmount(stockRow);
  }

  private normalizeRequestedStockCondition(value: unknown): 'NUEVO' | 'USADO' {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'NUEVO') return 'NUEVO';
    if (normalized === 'USADO') return 'USADO';
    throw new BadRequestException(
      'La condicion del material para una transferencia manual debe ser NUEVO o USADO.',
    );
  }

  private normalizePersistedStockCondition(
    value: unknown,
  ): 'NUEVO' | 'USADO' | 'CRITICO' {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'USADO') return 'USADO';
    if (normalized === 'CRITICO') return 'CRITICO';
    return 'NUEVO';
  }

  private resolveTransferStockCondition(
    stockRow: StockBodega,
    isPurchaseOrderTransfer: boolean,
    requestedCondition?: 'NUEVO' | 'USADO' | null,
  ): 'NUEVO' | 'USADO' | 'CRITICO' {
    if (isPurchaseOrderTransfer) return 'NUEVO';

    const nuevo = this.getStockNuevoAmount(stockRow);
    const usado = this.getStockUsadoAmount(stockRow);
    const critico = this.getStockCriticoAmount(stockRow);

    // Compatibilidad con stock crítico histórico: solo se usa automáticamente
    // cuando no existe disponibilidad NUEVO/USADO.
    if (nuevo <= 0.000001 && usado <= 0.000001 && critico > 0.000001) {
      return 'CRITICO';
    }

    // Para transferencias manuales modernas el frontend puede enviar dos filas
    // del mismo producto: una NUEVO y otra USADO. Se debe respetar la condición
    // solicitada sin depender del flag legado es_usado de la fila de stock.
    if (requestedCondition) return requestedCondition;

    // Compatibilidad con clientes antiguos que no enviaban condición cuando
    // solo existía un único tipo de stock operativo.
    if (nuevo > 0.000001 && usado <= 0.000001) return 'NUEVO';
    if (usado > 0.000001 && nuevo <= 0.000001) return 'USADO';

    throw new BadRequestException(
      'Debes indicar cuánto se transfiere desde stock NUEVO y cuánto desde stock USADO.',
    );
  }

  private async getActiveReservedQuantity(
    manager: EntityManager,
    bodegaId: string,
    productoId: string,
  ) {
    const closedStatuses = this.closedWorkOrderStatuses
      .map((status) => `'${status.replace(/'/g, "''")}'`)
      .join(', ');
    const rows = await manager.query(
      `SELECT COALESCE(SUM(COALESCE(reserva.cantidad, 0)), 0) AS cantidad
       FROM kpi_inventory.tb_reserva_stock reserva
       INNER JOIN kpi_process.tb_work_order work_order
         ON work_order.id = reserva.work_order_id
        AND work_order.is_deleted = false
       WHERE reserva.is_deleted = false
         AND UPPER(TRIM(COALESCE(reserva.estado, ''))) = 'RESERVADO'
         AND reserva.producto_id = $1
         AND reserva.bodega_id = $2
         AND UPPER(TRIM(COALESCE(work_order.status_workflow, 'PLANNED'))) NOT IN (${closedStatuses})`,
      [productoId, bodegaId],
    );
    return Math.max(this.toNumber(rows?.[0]?.cantidad, 0), 0);
  }

  private getTransferableStockByCondition(
    stockRow: StockBodega,
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
    reservedQuantity: number,
  ) {
    const totalTransferable = Math.max(
      this.getOperationalStockAmount(stockRow) -
        Math.max(this.toNumber(reservedQuantity, 0), 0),
      0,
    );
    const conditionStock =
      condition === 'USADO'
        ? this.getStockUsadoAmount(stockRow)
        : condition === 'CRITICO'
          ? this.getStockCriticoAmount(stockRow)
          : this.getStockNuevoAmount(stockRow);
    return Math.max(Math.min(conditionStock, totalTransferable), 0);
  }

  private applyStockDeltaByCondition(
    stockRow: StockBodega,
    delta: number,
    condition: 'NUEVO' | 'USADO' | 'CRITICO',
  ) {
    if (condition === 'NUEVO') return this.applyNewStockDelta(stockRow, delta);
    const currentNuevo = this.getStockNuevoAmount(stockRow);
    const currentUsado = this.getStockUsadoAmount(stockRow);
    const currentCritico = this.getStockCriticoAmount(stockRow);
    const current = condition === 'USADO' ? currentUsado : currentCritico;
    const next = current + this.toNumber(delta, 0);
    if (condition === 'USADO' && delta > 0) {
      stockRow.es_usado = true;
    }
    if (next < -0.000001) {
      throw new BadRequestException(
        `Stock ${condition === 'USADO' ? 'usado' : 'critico'} insuficiente. Disponible ${current.toFixed(2)}, requerido ${Math.abs(delta).toFixed(2)}.`,
      );
    }
    return this.setStockBreakdown(
      stockRow,
      currentNuevo,
      condition === 'USADO' ? next : currentUsado,
      condition === 'CRITICO' ? next : currentCritico,
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
    context?: {
      decreasedStockIds?: ReadonlySet<string>;
      actorUsername?: string | null;
    },
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
            movement_direction: context?.decreasedStockIds?.has(stockId)
              ? 'decrease'
              : 'increase',
            actor_username: context?.actorUsername ?? null,
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
